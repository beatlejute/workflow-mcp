import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../discovery.mjs';
import { mcpInstanceId as getMcpInstanceId } from '../lib/project-root.mjs';
import { readPipelineLock, validateRunOwnership } from '../process/run-lock.mjs';
import { readAbortState } from '../process/abort-state.mjs';
import { killOutcomeForRun } from '../process/kill-outcome.mjs';
import { parsePipelineLog } from '../parsers/pipeline-log.mjs';

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}


/**
 * Get paused state for a PID.
 */
function getPausedState(projectRoot, pid) {
  try {
    const pauseFile = path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json');
    if (fs.existsSync(pauseFile)) {
      const data = JSON.parse(fs.readFileSync(pauseFile, 'utf-8'));
      return data.pid === pid;
    }
  } catch { }
  return false;
}

/**
 * Идёт ли прямо сейчас остановка этого прогона.
 *
 * Читался файл `.workflow/logs/.aborting`, которого не пишет никто — ни
 * сервер, ни раннер, ни расширение, — поэтому состояние `aborting` не
 * возникало никогда. Настоящий признак лежал рядом: `abort_pipeline` пишет
 * `.workflow/state/abort-state.json` на всё grace-окно.
 *
 * Флаг сверяется с живым прогоном: сервер может умереть посреди abort'а, и
 * тогда файл переживёт и остановку, и сам прогон. Флаг от другого pid'а или
 * другого `run_id` — чужой, и состояние по нему не ставится.
 */
function isAbortingRun(projectRoot, lock) {
  const state = readAbortState(projectRoot);
  if (!state || !lock) return false;
  // Флаг без pid раннера — формат до 1.5.0 либо испорченное поле. Такой
  // подходит к любому прогону, поэтому не подходит ни к какому: иначе
  // забытый файл десять минут держал бы следующий запуск в `aborting`.
  if (state.runner_pid === null || state.runner_pid !== lock.pid) return false;
  if (state.run_id && lock.run_id && state.run_id !== lock.run_id) return false;
  return true;
}

/**
 * Get pending approval info.
 */
function getAwaitingApproval(projectRoot) {
  const approvalsDir = path.join(projectRoot, '.workflow', 'approvals');
  if (!fs.existsSync(approvalsDir)) return null;
  try {
    for (const file of fs.readdirSync(approvalsDir).filter(f => f.endsWith('.json'))) {
      const fp = path.join(approvalsDir, file);
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (data.status === 'pending') {
        return {
          step_id: data.step_id || data.id || file.replace('.json', ''),
          since: data.created_at || data.since || new Date(fs.statSync(fp).mtime).toISOString()
        };
      }
    }
  } catch { }
  return null;
}

/**
 * Determine pipeline state.
 */
function determinePipelineState({ pidAlive, paused, aborting, killed }) {
  // Остановка важнее паузы: приостановленный пайплайн, которому уже послали
  // сигнал, для клиента прежде всего останавливается.
  if (aborting) return 'aborting';
  if (paused) return 'paused';
  if (pidAlive) return 'running';
  // Дальше — только мёртвый pid при живом lock'е. Раннер снимает lock при
  // любом упорядоченном выходе, так что сюда попадает лишь тот, кого убили
  // без шанса прибраться. Если убивали мы — знаем, что это `killed`; если
  // нет — честнее сказать `stale`, чем гадать.
  return killed ? 'killed' : 'stale';
}

/**
 * Extract run_id from log file name.
 * @param {string} filename
 * @returns {string}
 */
function extractRunId(filename) {
  const match = filename.match(/pipeline_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
  if (match) return `pipeline_${match[1]}`;
  return filename;
}

/**
 * Get run info from latest log file.
 * @param {string} projectRoot
 * @returns {{runId: string|null, currentStage: string|null, stepNumber: number|null}}
 */
function getRunInfo(projectRoot) {
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  if (!fs.existsSync(logsDir)) return { runId: null, currentStage: null, stepNumber: null };
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
      .sort((a, b) => fs.statSync(path.join(logsDir, b)).mtime.getTime() - fs.statSync(path.join(logsDir, a)).mtime.getTime());
    if (files.length === 0) return { runId: null, currentStage: null, stepNumber: null };
    const latest = files[0];
    const runId = extractRunId(latest);
    // Read log to extract current stage/step (last non-completed step)
    const logPath = path.join(logsDir, latest);
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const steps = parsePipelineLog(content);
      if (steps.length > 0) {
        // Find last step that is not completed, or last step overall
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i];
          if (s.status !== 'success' && s.status !== 'error' && s.status !== 'killed') {
            return { runId, currentStage: s.stage, stepNumber: s.step_number };
          }
        }
        // All steps finished, return last step
        const last = steps[steps.length - 1];
        return { runId, currentStage: last.stage, stepNumber: last.step_number };
      }
    } catch {
      // Parse errors, ignore
    }
    return { runId, currentStage: null, stepNumber: null };
  } catch {
    return { runId: null, currentStage: null, stepNumber: null };
  }
}


/**
 * Build snapshot of running pipelines for all projects.
 * Reuses list_running_pipelines logic.
 * @param {string} absoluteCwd - Absolute workspace root
 * @returns {Array<Object>}
 */
export function get_workflow_pipeline_state(absoluteCwd) {
  const projects = discoverProjects(absoluteCwd);
  const snapshot = [];

  for (const project of projects) {
    const projectRoot = project.path;
    // Единственный источник pid — lock, который пишет раннер.
    const lock = readPipelineLock(projectRoot);
    if (!lock) continue;
    const pid = lock.pid;

    // Владение привязано к запуску, а не к номеру процесса. Битый маркер
    // внутри читается безопасно: раньше один такой файл ронял снимок целиком.
    const markerValid = validateRunOwnership(projectRoot, pid, lock, getMcpInstanceId(absoluteCwd));

    // Запись об исходе делает только MCP — `stop_pipeline` и эскалация
    // `abort_pipeline`, — и она привязана к pid и `run_id` прогона. Значит это
    // второе доказательство владения, причём то самое, которое переживает
    // убийство: маркер после kill'а снимаем мы сами.
    const killOutcome = killOutcomeForRun(projectRoot, lock);

    const pidAlive = isProcessAlive(pid);
    const paused = getPausedState(projectRoot, pid);
    const aborting = isAbortingRun(projectRoot, lock);
    const killed = !pidAlive && killOutcome !== null;

    // Чужой — любой, чей маркер не доказывает наше владение: нет маркера
    // (запущен из CLI), чужой идентификатор или чужой pid. Проверка только на
    // PID_MISMATCH давала ровно обратный ответ: свои пайплайны считались чужими,
    // а запущенные из CLI (маркера нет вовсе) — своими.
    // Исключение — прогон, который мы сами же убили: маркера нет ровно потому,
    // что мы его убрали. Признак снимается только вместе с `killed`, то есть
    // при мёртвом pid: у живого процесса запись о прошлом убийстве ничего не
    // доказывает — номер мог переиспользоваться.
    const isForeign = !markerValid.valid && !killed;
    const awaiting = getAwaitingApproval(projectRoot);
    const { runId, currentStage, stepNumber } = getRunInfo(projectRoot);

    let state = determinePipelineState({ pidAlive, paused, aborting, killed });

    // Lock пережил процесс (kill -9, ребут, падение) — как минимум запуск не
    // идёт. Признак остаётся информационным: по нему видно, что файл надо
    // убирать руками.
    const staleLock = Boolean(lock) && !pidAlive;

    // If there is a pending approval and pipeline is running, treat as paused
    if (awaiting && state === 'running') {
      state = 'paused';
    }

    const entry = {
      project: project.name,
      pid,
      state,
      marker_valid: markerValid.valid,
      run_id: runId,
      current_stage: currentStage,
      step_number: stepNumber,
      ...(isForeign && { foreign: true }),
      ...(staleLock && { stale_lock: true }),
      ...(markerValid.reason && { marker_reason: markerValid.reason }),
      // Кто именно добивал: `stop_pipeline` или эскалация `abort_pipeline`.
      // Заодно это объяснение, почему у убитого прогона нет маркера.
      ...(killed && killOutcome.by ? { killed_by: killOutcome.by } : {}),
      ...(awaiting && { awaiting_approval: awaiting })
    };

    // Timestamps
    if (lock && lock.timestamp) {
      entry.started_at = lock.timestamp;
    } else {
      try {
        const startedMarker = path.join(projectRoot, '.workflow', 'logs', '.mcp-started-by');
        if (fs.existsSync(startedMarker)) {
          entry.started_at = new Date(fs.statSync(startedMarker).mtime).toISOString();
        }
      } catch { }
    }
    try {
      const logsDir = path.join(projectRoot, '.workflow', 'logs');
      const files = fs.readdirSync(logsDir).filter(f => f.startsWith('pipeline_') && f.endsWith('.log'));
      if (files.length > 0) {
        const latest = files.reduce((a, b) => {
          const ta = fs.statSync(path.join(logsDir, a)).mtime.getTime();
          const tb = fs.statSync(path.join(logsDir, b)).mtime.getTime();
          return ta > tb ? a : b;
        });
        entry.last_log_at = new Date(fs.statSync(path.join(logsDir, latest)).mtime).toISOString();
      }
    } catch { }

    snapshot.push(entry);
  }

  return snapshot;
}
