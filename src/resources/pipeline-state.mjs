import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../discovery.mjs';
import { mcpInstanceId as getMcpInstanceId } from '../lib/project-root.mjs';
import { readPipelineLock, validateRunOwnership } from '../process/run-lock.mjs';
import { readAbortState } from '../process/abort-state.mjs';
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
  if (state.runner_pid !== null && state.runner_pid !== lock.pid) return false;
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
function determinePipelineState({ pidAlive, paused, aborting, logAgeMs, logHasExitCode, logExitCode }) {
  // Остановка важнее паузы: приостановленный пайплайн, которому уже послали
  // сигнал, для клиента прежде всего останавливается.
  if (aborting) return 'aborting';
  if (paused) return 'paused';
  if (pidAlive) return 'running';
  if (logHasExitCode) return logExitCode === 0 ? 'completed' : 'killed';
  return logAgeMs < 30000 ? 'running' : 'completed';
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
 * Get log exit info from latest pipeline log.
 * @param {string} projectRoot
 * @returns {{ageMs: number, hasExitCode: boolean, exitCode: number|null}}
 */
function getLogExitInfo(projectRoot) {
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  if (!fs.existsSync(logsDir)) return { ageMs: Infinity, hasExitCode: false, exitCode: null };
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(logsDir, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return { ageMs: Infinity, hasExitCode: false, exitCode: null };
    const latest = files[0];
    const logPath = path.join(logsDir, latest.name);
    const content = fs.readFileSync(logPath, 'utf-8');
    for (const line of content.split('\n').reverse()) {
      if (line.includes('[exit]')) {
        const m = line.match(/code=(\d+)/);
        if (m) return { ageMs: Date.now() - latest.mtime, hasExitCode: true, exitCode: parseInt(m[1], 10) };
      }
    }
    return { ageMs: Date.now() - latest.mtime, hasExitCode: false, exitCode: null };
  } catch {
    return { ageMs: Infinity, hasExitCode: false, exitCode: null };
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
    // Чужой — любой, чей маркер не доказывает наше владение: нет маркера
    // (запущен из CLI), чужой идентификатор или чужой pid. Проверка только на
    // PID_MISMATCH давала ровно обратный ответ: свои пайплайны считались чужими,
    // а запущенные из CLI (маркера нет вовсе) — своими.
    const isForeign = !markerValid.valid;

    const pidAlive = isProcessAlive(pid);
    const paused = getPausedState(projectRoot, pid);
    const aborting = isAbortingRun(projectRoot, lock);
    const { ageMs: logAgeMs, hasExitCode: logHasExitCode, exitCode: logExitCode } = getLogExitInfo(projectRoot);
    const awaiting = getAwaitingApproval(projectRoot);
    const { runId, currentStage, stepNumber } = getRunInfo(projectRoot);

    let state = determinePipelineState({
      pidAlive,
      paused,
      aborting,
      logAgeMs,
      logHasExitCode,
      logExitCode
    });

    // Lock пережил процесс (kill -9, ребут, падение) — как минимум запуск не
    // идёт. Признак остаётся информационным: по нему видно, что файл надо
    // убирать руками.
    const staleLock = Boolean(lock) && !pidAlive;

    // А вот состояние по нему ставится, только если о конце прогона больше
    // сказать нечего. Раньше `stale` затирало всё подряд, включая разбор лога,
    // и состояние `killed` не возникало никогда: мёртвый pid давал `stale`
    // раньше, чем кто-либо смотрел на код выхода.
    if (staleLock && !logHasExitCode) {
      state = 'stale';
    }

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
