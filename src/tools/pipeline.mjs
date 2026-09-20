import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { readPipelineLock, validateRunOwnership } from '../process/run-lock.mjs';
import { writeAbortState, clearAbortState, isAbortInProgress } from '../process/abort-state.mjs';
import { writeKillOutcome, clearKillOutcome } from '../process/kill-outcome.mjs';
import { pidCouldBeFromRun } from '../process/process-start.mjs';
import { kill, pause, resume, abort } from '../process/control.mjs';
import { notify_workflow_pipeline_state } from '../resources/index.mjs';
import { get_workflow_pipeline_state } from '../resources/pipeline-state.mjs';
import { z } from 'zod';
import { mcpCwd, mcpInstanceId as getMcpInstanceId, acceptedInstanceIds, resolveProjectRoot } from '../lib/project-root.mjs';
import { workflowAiPath } from '../lib/workflow-ai.mjs';

/**
 * Разрешить путь до CLI workflow-ai (bin/workflow.mjs).
 *
 * Корень пакета считает `lib/workflow-ai.mjs` — один на весь сервер.
 *
 * @returns {{ok: true, bin: string} | {ok: false, code: string, hint: string}}
 */
function resolveWorkflowAiBin() {
  if (process.env.WORKFLOW_AI_BIN) {
    const bin = process.env.WORKFLOW_AI_BIN;
    if (!fs.existsSync(bin)) {
      return { ok: false, code: 'RUNNER_NOT_FOUND', hint: `WORKFLOW_AI_BIN points to a missing file: ${bin}` };
    }
    return { ok: true, bin };
  }

  try {
    const bin = workflowAiPath('bin', 'workflow.mjs');
    if (!fs.existsSync(bin)) {
      return { ok: false, code: 'RUNNER_NOT_FOUND', hint: `workflow-ai found at ${path.dirname(path.dirname(bin))}, but bin/workflow.mjs is missing` };
    }
    return { ok: true, bin };
  } catch (err) {
    return { ok: false, code: 'RUNNER_NOT_FOUND', hint: err.message };
  }
}

/**
 * Pid идущего раннера.
 *
 * Единственный источник — `.workflow/logs/.pipeline.lock`, который раннер
 * пишет при любом способе запуска: из CLI, из расширения, из MCP.
 *
 * Раньше рядом был запасной путь через `.runner-pids`. Файла с таким именем
 * не пишет никто — ни workflow-ai, ни расширение, ни сам сервер, — но читали
 * его пять модулей по двум разным путям, и отсутствие пайплайна выглядело для
 * клиента как `NO_RUNNER_PIDS: Failed to read .runner-pids: ENOENT`. Ответ
 * описывал не положение дел, а несуществующий файл.
 *
 * Возвращает и сам lock: читать его второй раз для проверки владения значит
 * допускать, что между чтениями его снимут и проверка выродится.
 *
 * @param {string} projectRoot
 * @returns {{ok: true, pid: number, lock: Object} | {ok: false, code: string, hint: string}}
 */
function resolveRunnerPid(projectRoot) {
  const lock = readPipelineLock(projectRoot);
  if (lock) {
    return { ok: true, pid: lock.pid, lock };
  }

  return {
    ok: false,
    code: 'PIPELINE_NOT_RUNNING',
    hint: 'No pipeline lock found — nothing is running for this project'
  };
}

/**
 * Отказ из-за владения.
 *
 * `PID_REUSED` выделен отдельным кодом: это не «чужой пайплайн», а протухший
 * lock без пайплайна вовсе. Совет «повторите с force» здесь означал бы «убейте
 * посторонний процесс, занявший номер».
 *
 * @param {{reason?: string}} validation
 * @param {string} code код для обычного случая
 * @param {string} hint подсказка для обычного случая
 * @returns {{ok: false, code: string, reason: string|undefined, hint: string}}
 */
function ownershipRefusal(validation, code, hint) {
  if (validation.reason === 'PID_REUSED') {
    return {
      ok: false,
      code: 'STALE_PIPELINE_LOCK',
      reason: validation.reason,
      hint: 'The recorded runner is gone and its pid now belongs to another process. '
        + 'Remove .workflow/logs/.pipeline.lock; do not retry with force — that would kill the unrelated process.'
    };
  }
  return { ok: false, code, reason: validation.reason, hint };
}

function isPipelineProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Pipeline-логи проекта, новые первыми.
 * @param {string} logsDir
 * @returns {string[]}
 */
function listPipelineLogs(logsDir) {
  try {
    return fs.readdirSync(logsDir)
      .filter(n => n.startsWith('pipeline_') && n.endsWith('.log'))
      .map(n => ({ n, m: fs.statSync(path.join(logsDir, n)).mtime.getTime() }))
      .sort((a, b) => b.m - a.m)
      .map(x => x.n);
  } catch {
    return [];
  }
}

/**
 * Дождаться появления нового лог-файла запуска.
 *
 * Раннер сам именует лог `pipeline_<timestamp>.log` при старте, поэтому run_id
 * узнаём по факту, а не выдумываем.
 *
 * @param {string} logsDir
 * @param {Set<string>} before - логи, существовавшие до spawn
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
async function waitForNewLog(logsDir, before, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = listPipelineLogs(logsDir).find(n => !before.has(n));
    if (fresh) return fresh;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/**
 * Start a pipeline for a project.
 *
 * Запускает настоящий раннер workflow-ai (`workflow run`) detached-процессом.
 * Синглтон обеспечивает сам раннер через .pipeline.lock (workflow-ai PLAN-011);
 * здесь мы проверяем занятость и снимаем протухший lock мёртвого процесса.
 */
export const start_pipeline = {
  name: 'start_pipeline',
  description: 'Start a pipeline for a project by spawning the workflow-ai runner detached. Returns {run_id, pid, started_at, log_path}',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    plan: z.string().optional().describe('Plan ID to execute (e.g. PLAN-017); omit to let the pipeline pick work itself'),
    config: z.string().optional().describe('Path to pipeline.yaml (default: .workflow/config/pipeline.yaml)')
  }),
  async execute({ project, plan, config }) {
    const cwd = mcpCwd();
    const projectRoot = path.isAbsolute(project) ? project : path.join(cwd, project);

    if (!fs.existsSync(path.join(projectRoot, '.workflow'))) {
      return { ok: false, code: 'INVALID_PROJECT', hint: `Project not found: ${project}` };
    }

    // Занятость: живой lock — отказ; протухший — снимаем, иначе раннер упадёт на EEXIST.
    const lock = readPipelineLock(projectRoot);
    if (lock) {
      if (isPipelineProcessAlive(lock.pid)) {
        // Живой pid сам по себе ничего не значит — его мог занять посторонний
        // процесс, — но и сносить lock автоматически нельзя: ошибёмся — поверх
        // живого раннера встанет второй пайплайн. Цена ошибки несимметрична,
        // поэтому протухший на вид lock с живым pid отдаётся человеку явно.
        if (!pidCouldBeFromRun(lock.pid, lock.started_at, { fresh: true })) {
          return {
            ok: false,
            code: 'STALE_PIPELINE_LOCK',
            pid: lock.pid,
            started_at: lock.timestamp,
            hint: `Lock points at pid ${lock.pid}, but that process started after the lock was written `
              + '— it is not the runner. Remove .workflow/logs/.pipeline.lock and start again.'
          };
        }
        return {
          ok: false,
          code: 'ALREADY_RUNNING',
          pid: lock.pid,
          started_at: lock.timestamp,
          hint: `Pipeline is already running for ${project} (pid ${lock.pid})`
        };
      }
      try {
        fs.unlinkSync(path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock'));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          return { ok: false, code: 'STALE_LOCK', hint: `Failed to remove stale lock: ${err.message}` };
        }
      }
    }

    const binResult = resolveWorkflowAiBin();
    if (!binResult.ok) return binResult;

    const logsDir = path.join(projectRoot, '.workflow', 'logs');
    const before = new Set(listPipelineLogs(logsDir));

    const argv = [binResult.bin, 'run', '--project', projectRoot];
    if (plan) argv.push('--plan', plan);
    if (config) argv.push('--config', config);

    let child;
    try {
      child = spawn(process.execPath, argv, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // Раннер кладёт обе переменные в .pipeline.lock. По `started_by`
        // внешние наблюдатели (расширение VS Code) отличают MCP-запуск от CLI,
        // по `started_by_id` мы узнаём собственную рабочую область — это и есть
        // единственный признак владения, второго файла для него больше нет.
        env: {
          ...process.env,
          WORKFLOW_STARTED_BY: 'mcp',
          WORKFLOW_STARTED_BY_ID: getMcpInstanceId()
        }
      });
      child.unref();
    } catch (err) {
      return { ok: false, code: 'SPAWN_FAILED', hint: err.message };
    }

    if (!child.pid) {
      return { ok: false, code: 'SPAWN_FAILED', hint: 'Runner process has no pid' };
    }

    const started_at = new Date().toISOString();

    // Владение записывает раннер: метка из `WORKFLOW_STARTED_BY_ID` ложится в
    // `.pipeline.lock` рядом с pid и `run_id`. Своего файла сервер больше не
    // пишет — пара файлов про один запуск умела разойтись, и на этом классе
    // дефектов держалась половина отказов владения.
    //
    // Метка привязана к рабочей области, а не к процессу сервера: stdio-сервер
    // живёт одну сессию клиента, detached-раннер — часами, и привязка к
    // `process.pid` делала бы свой же пайплайн чужим после каждого рестарта.

    // Исход прошлой остановки к новому прогону отношения не имеет. Сверка по
    // pid и `run_id` его и так отсекает, но файл иначе лежал бы вечно.
    clearKillOutcome(projectRoot);

    const logName = await waitForNewLog(logsDir, before);
    if (!logName) {
      return {
        ok: false,
        code: 'RUNNER_NO_LOG',
        pid: child.pid,
        started_at,
        hint: 'Runner was spawned but produced no pipeline log within 10s — check that workflow-ai is installed and the config is valid'
      };
    }

    const run_id = logName.replace(/\.log$/, '');

    // Раннер до workflow-ai 1.7.0 метку `started_by_id` не пишет, и такой
    // прогон виден как `INSTANCE_UNKNOWN`: `stop_pipeline` и `abort_pipeline`
    // откажут без `force`. Молчать об этом нельзя — клиент узнал бы о потере
    // управления только в момент остановки.
    const writtenLock = readPipelineLock(projectRoot);
    const runnerTooOld = Boolean(writtenLock) && writtenLock.pid === child.pid && !writtenLock.started_by_id;

    return {
      ok: true,
      run_id,
      pid: child.pid,
      started_at,
      ...(runnerTooOld && {
        warning: 'RUNNER_WITHOUT_INSTANCE_ID',
        hint: 'The runner did not record started_by_id in .pipeline.lock (workflow-ai < 1.7.0). '
          + 'This pipeline will read as foreign; stop_pipeline and abort_pipeline will need force=true. Update workflow-ai.'
      }),
      log_path: path.join(logsDir, logName)
    };
  }
};

export const get_pipeline_log = {
  name: 'get_pipeline_log',
  description: 'Get pipeline log content with cursor-based pagination',
  inputSchema: z.object({
    project: z.string().describe('Project name or path'),
    options: z.object({
      tail_lines: z.number().optional().describe('Lines from end (default 200, max 5000)'),
      offset_bytes: z.number().optional().describe('Start reading from this byte offset'),
      run_id: z.string().optional().describe('Specific run ID (log file name without .log)')
    }).optional()
  }),
  async execute({ project, options = {} }) {
    const cwd = mcpCwd();

    // Resolve project path
    const projectRoot = path.isAbsolute(project)
      ? project
      : path.join(cwd, project);

    // Validate project exists
    const workflowDir = path.join(projectRoot, '.workflow');
    if (!fs.existsSync(workflowDir)) {
      return { error: 'INVALID_PROJECT', message: `Project not found: ${project}` };
    }

    const logsDir = path.join(workflowDir, 'logs');

    // Validate tail_lines
    const tailLines = options.tail_lines !== undefined ? options.tail_lines : 200;
    if (tailLines > 5000) {
      return { error: 'TOO_MANY_LINES', message: `tail_lines cannot exceed 5000, got ${tailLines}` };
    }

    // Check logs directory exists
    if (!fs.existsSync(logsDir)) {
      return { error: 'LOG_NOT_FOUND', message: `Logs directory not found in project` };
    }

    // Find pipeline log files
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'));

    if (logFiles.length === 0) {
      return { error: 'LOG_NOT_FOUND', message: `No pipeline logs found in project` };
    }

    // Select log file
    let selectedLog;
    if (options.run_id) {
      const runLogName = options.run_id.endsWith('.log')
        ? options.run_id
        : `${options.run_id}.log`;
      if (!logFiles.includes(runLogName)) {
        return { error: 'LOG_NOT_FOUND', message: `Run ${options.run_id} not found` };
      }
      selectedLog = runLogName;
    } else {
      // Select latest by mtime
      const withMtime = logFiles.map(f => ({
        name: f,
        mtime: fs.statSync(path.join(logsDir, f)).mtimeMs
      }));
      withMtime.sort((a, b) => b.mtime - a.mtime);
      selectedLog = withMtime[0].name;
    }

    const logPath = path.join(logsDir, selectedLog);
    const runId = selectedLog.replace(/\.log$/, '');

    // Read file as buffer for accurate byte handling
    let fileBuffer = fs.readFileSync(logPath);
    const logSizeBytes = fileBuffer.length;

    // Strip UTF-8 BOM (EF BB BF)
    if (fileBuffer.length >= 3
      && fileBuffer[0] === 0xEF
      && fileBuffer[1] === 0xBB
      && fileBuffer[2] === 0xBF) {
      fileBuffer = fileBuffer.slice(3);
    }

    // Apply byte offset if specified
    const offsetBytes = options.offset_bytes;
    if (offsetBytes !== undefined && offsetBytes > 0) {
      fileBuffer = fileBuffer.slice(offsetBytes);
    }

    const content = fileBuffer.toString('utf8');

    // Split into lines
    let allLines = content.split('\n');
    // Remove trailing empty entry from trailing newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines = allLines.slice(0, -1);
    }

    // Apply tail_lines
    const lines = allLines.length <= tailLines
      ? allLines
      : allLines.slice(allLines.length - tailLines);

    return {
      run_id: runId,
      lines,
      log_path: logPath,
      log_size_bytes: logSizeBytes,
      truncated: false
    };
  }
};

/**
 * Read pause state for a given project.
 * @param {string} projectRoot
 * @returns {{pid: number, paused_at: string}|null}
 */
function readPauseState(projectRoot) {
  const stateFile = path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json');
  try {
    const content = fs.readFileSync(stateFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write pause state for a given project.
 * @param {string} projectRoot
 * @param {{pid: number, paused_at: string}} state
 */
function writePauseState(projectRoot, state) {
  const stateFile = path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Clear pause state for a given project.
 * @param {string} projectRoot
 */
export function clearPauseState(projectRoot) {
  const stateFile = path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json');
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // Idempotent: ignore if file doesn't exist
  }
}

/**
 * Pause a running pipeline (implementation).
 * Checks ownership against .pipeline.lock, gets the runner PID from it, calls process/control.pause.
 * Returns {pid, state: "paused", paused_at} on success.
 */
export async function pausePipelineImpl(project) {
  const projectRoot = resolveProjectRoot(project);

  // Сначала pid идущего раннера — именно с ним сверяется маркер.
  const runner = resolveRunnerPid(projectRoot);
  if (!runner.ok) {
    return { ok: false, code: runner.code, hint: runner.hint };
  }
  const pid = runner.pid;

  // Сверка владения по lock'у
  const validation = validateRunOwnership(runner.lock, pid, acceptedInstanceIds(), { verifyProcessStart: true, fresh: true });
  if (!validation.valid) {
    return ownershipRefusal(
      validation,
      'OWNERSHIP_VALIDATION_FAILED',
      `Pipeline ownership validation failed: ${validation.reason}`
    );
  }

  // Idempotency: check if already paused
  const existingState = readPauseState(projectRoot);
  if (existingState && existingState.pid === pid) {
    return {
      ok: true,
      code: 'ALREADY_PAUSED',
      pid,
      state: 'paused',
      paused_at: existingState.paused_at
    };
  }

  // Call process/control.pause()
  const pauseResult = await pause(pid);

  if (!pauseResult.ok) {
    // Handle PAUSE_UNSUPPORTED specifically
    if (pauseResult.code === 'PAUSE_UNSUPPORTED') {
      return {
        ok: false,
        code: 'PAUSE_UNSUPPORTED',
        hint: pauseResult.hint
      };
    }

    // Other errors
    return {
      ok: false,
      code: pauseResult.code || 'PAUSE_FAILED',
      hint: pauseResult.hint || 'Failed to pause pipeline'
    };
  }

  const paused_at = new Date().toISOString();

  // Persist pause state for idempotency
  writePauseState(projectRoot, { pid, paused_at });

  // Success: send notification to pipeline-state resource
  try {
    notify_workflow_pipeline_state();
  } catch (err) {
    // Notification failure doesn't block the operation
    console.error('Failed to notify pipeline-state:', err.message);
  }

   return {
     ok: true,
     pid,
     state: 'paused',
     paused_at
   };
 }

export const pause_pipeline = {
  name: 'pause_pipeline',
  description: 'Pause a running pipeline',
  inputSchema: z.object({
    project: z.string().describe('Project path or name')
  }),
  async execute({ project }) {
    return await pausePipelineImpl(project);
  }
};

  /**
   * Resume a paused pipeline (implementation).
   * Checks ownership against .pipeline.lock, gets the runner PID from it, calls process/control.resume.
   * Returns {pid, state: "running"} on success.
   * Idempotent: if not paused, returns NOT_PAUSED.
   */
  export async function resumePipelineImpl(project) {
    const projectRoot = resolveProjectRoot(project);

    const runner = resolveRunnerPid(projectRoot);
    if (!runner.ok) {
      return { ok: false, code: runner.code, hint: runner.hint };
    }
    const pid = runner.pid;

    // Сверка владения по lock'у
    const validation = validateRunOwnership(runner.lock, pid, acceptedInstanceIds(), { verifyProcessStart: true, fresh: true });
    if (!validation.valid) {
      return ownershipRefusal(
        validation,
        'OWNERSHIP_VALIDATION_FAILED',
        `Pipeline ownership validation failed: ${validation.reason}`
      );
    }

    // Idempotency: check if already not paused (no pause state or different PID)
    const existingState = readPauseState(projectRoot);
    if (!existingState || existingState.pid !== pid) {
      return {
        ok: false,
        code: 'NOT_PAUSED',
        pid,
        hint: `Pipeline is not paused (PID: ${pid})`
      };
    }

    // Call process/control.resume()
    const resumeResult = await resume(pid);

    if (!resumeResult.ok) {
      // Handle RESUME_UNSUPPORTED specifically
      if (resumeResult.code === 'RESUME_UNSUPPORTED') {
        return {
          ok: false,
          code: 'RESUME_UNSUPPORTED',
          hint: resumeResult.hint
        };
      }

      // Other errors
      return {
        ok: false,
        code: resumeResult.code || 'RESUME_FAILED',
        hint: resumeResult.hint || 'Failed to resume pipeline'
      };
    }

    // Clear pause state after successful resume
    clearPauseState(projectRoot);

    // Success: send notification to pipeline-state resource
    try {
      notify_workflow_pipeline_state();
    } catch (err) {
      // Notification failure doesn't block the operation
      console.error('Failed to notify pipeline-state:', err.message);
    }

    return {
      ok: true,
      pid,
      state: 'running'
    };
  }

export const resume_pipeline = {
  name: 'resume_pipeline',
  description: 'Resume a paused pipeline',
  inputSchema: z.object({
    project: z.string().describe('Project path or name')
  }),
  async execute({ project }) {
    return await resumePipelineImpl(project);
  }
};

  /**
   * Stop (hard kill) a running pipeline (implementation).
   * Checks ownership against .pipeline.lock (unless overridden by force=true), gets the runner PID from it, calls process/control.kill.
   * Returns {pid, state: "killed"} on success.
   */
  export async function stopPipelineImpl(project, options = {}) {
    const force = options.force === true;
    const projectRoot = resolveProjectRoot(project);

    const runner = resolveRunnerPid(projectRoot);
    if (!runner.ok) {
      return { ok: false, code: runner.code, hint: runner.hint };
    }
    const pid = runner.pid;

    // Сверка владения по lock'у. `force` снимает вопрос о том, чей это
    // пайплайн, но не вопрос о том, есть ли он вообще: при `PID_REUSED` номер
    // из lock'а принадлежит постороннему процессу, и убийство «с force» —
    // это `taskkill /F /T` по чужому дереву. Подсказка в `ownershipRefusal`
    // прямо говорит не повторять с force; странно было бы её же и обходить.
    const validation = validateRunOwnership(
      runner.lock, pid, acceptedInstanceIds(), { verifyProcessStart: true, fresh: true }
    );
    if (!validation.valid && (!force || validation.reason === 'PID_REUSED')) {
      return ownershipRefusal(
        validation,
        'FOREIGN_PIPELINE',
        `Pipeline is foreign (not started by this MCP workspace). Use force=true to override: ${validation.reason}`
      );
    }

    // Call process/control.kill()
    const killResult = await kill(pid);

    if (!killResult.ok) {
      return killResult;
    }

    // Кто убил — тот и знает исход. Раннер после `taskkill /F` ничего не
    // пишет и lock за собой не снимает, поэтому без этой записи снимок
    // показывал бы `stale`: «lock есть, процесса нет, чем кончилось —
    // неизвестно».
    writeKillOutcome(projectRoot, {
      pid,
      runId: runner.lock?.run_id ?? null,
      by: 'stop_pipeline'
    });

    // Success: send notification to pipeline-state resource
    try {
      notify_workflow_pipeline_state();
    } catch (err) {
      // Notification failure doesn't block the operation
      console.error('Failed to notify pipeline-state:', err.message);
    }

    return {
      ok: true,
      pid,
      state: 'killed'
    };
  }

export const stop_pipeline = {
  name: 'stop_pipeline',
  description: 'Stop (hard kill) a running pipeline',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    options: z.object({
      force: z.boolean().optional().describe('Override the ownership check (requires explicit consent)')
    }).optional()
  }),
   async execute({ project, options }) {
     return await stopPipelineImpl(project, options);
   }
 };

export const list_running_pipelines = {
  name: 'list_running_pipelines',
  description: 'List running pipelines across all projects with state and approval info (Sprint 2 extension)',
  inputSchema: z.object({}),
  async execute(args) {
    const cwd = mcpCwd();
    const absoluteCwd = path.resolve(cwd);
    const pipelines = await get_workflow_pipeline_state(absoluteCwd);
    return pipelines;
  }
};


/**
 * Implementation for abort_pipeline tool.
 * Graceful shutdown: SIGINT → wait grace_sec → SIGTERM (POSIX).
 * Windows: taskkill /PID → wait → taskkill /F.
 * Returns {pid, state: "aborted", duration_ms, escalated: bool}.
 * Parallel abort on same project → ALREADY_ABORTING.
 */
export async function abortPipelineImpl(project, options = {}) {
  const projectRoot = resolveProjectRoot(project);
  const graceSec = options.grace_sec !== undefined ? options.grace_sec : 10;
  // Clamp grace_sec to [0, 60]
  const clampedGraceSec = Math.max(0, Math.min(60, graceSec));

  const runner = resolveRunnerPid(projectRoot);
  if (!runner.ok) {
    return { ok: false, code: runner.code, hint: runner.hint };
  }
  const pid = runner.pid;

  // Сверка владения по lock'у
  const validation = validateRunOwnership(runner.lock, pid, acceptedInstanceIds(), { verifyProcessStart: true, fresh: true });
  if (!validation.valid) {
    return ownershipRefusal(
      validation,
      'FOREIGN_PIPELINE',
      `Pipeline is foreign (not started by this MCP workspace). Cannot abort: ${validation.reason}`
    );
  }

  // Check for parallel abort already in progress (flag in state-dir)
  if (isAbortInProgress(projectRoot)) {
    return {
      ok: false,
      code: 'ALREADY_ABORTING',
      hint: 'An abort operation is already in progress for this project'
    };
  }

  // Set abort-in-progress flag (for parallel abort detection)
  writeAbortState(projectRoot, {
    runnerPid: pid,
    runId: runner.lock?.run_id ?? null,
    mcpInstanceId: getMcpInstanceId()
  });

  // Send notification: abort starting
  try {
    notify_workflow_pipeline_state();
  } catch (err) {
    console.error('Failed to notify pipeline-state on abort start:', err.message);
  }

  // Execute graceful abort using process/control.abort
  let abortResult;
  try {
    abortResult = await abort(pid, {
      grace_sec: clampedGraceSec,
      // Перед жёстким сигналом снова смотрим на живое состояние, а не на
      // сохранённый lock: за grace-окно раннер мог выйти сам.
      can_escalate: () => {
        const liveLock = readPipelineLock(projectRoot);
        // В lock'е уже другой pid — наш раннер вышел, а на его место встал чужой
        // запуск. Добивать старый pid незачем и опасно.
        if (liveLock && liveLock.pid !== pid) {
          return { escalate: false, reason: 'RUNNER_GONE' };
        }
        if (!liveLock) {
          // lock был в начале и исчез — раннер завершился сам. Добивать некого,
          // а pid к этому моменту может уже принадлежать чужому процессу.
          return { escalate: false, reason: 'RUNNER_GONE' };
        }
        const ownership = validateRunOwnership(
          liveLock, pid, acceptedInstanceIds(), { verifyProcessStart: true, fresh: true }
        );
        return ownership.valid
          ? { escalate: true }
          : { escalate: false, reason: ownership.reason || 'OWNERSHIP_LOST' };
      }
    });
  } catch (err) {
    // Неожиданный отказ остановки не должен оставлять флаг: иначе проект
    // числился бы `aborting` до конца TTL, а повторный abort отвечал бы
    // `ALREADY_ABORTING` десять минут.
    clearAbortState(projectRoot);
    throw err;
  }

  if (!abortResult.ok) {
    // Clear flag even on failure
    clearAbortState(projectRoot);
    // Still try to send notification
    try {
      notify_workflow_pipeline_state();
    } catch (err) {
      // ignore
    }
    return abortResult;
  }

  // Запись делается только при эскалации: раннер, вышедший по мягкому сигналу
  // сам, успевает снять lock, и проект из снимка просто исчезает — писать про
  // него `killed` было бы неправдой.
  if (abortResult.escalated) {
    writeKillOutcome(projectRoot, {
      pid,
      runId: runner.lock?.run_id ?? null,
      by: 'abort_pipeline'
    });
  }

  // Clear abort-in-progress flag
  clearAbortState(projectRoot);

  // Send notification: abort completed
  try {
    notify_workflow_pipeline_state();
  } catch (err) {
    console.error('Failed to notify pipeline-state on abort complete:', err.message);
  }

  // `ok` здесь раньше не возвращался, хотя соседние pause/resume/stop его отдают,
  // а отказы самого abort всегда шли с `ok: false` — клиенту приходилось разбирать
  // успех по отсутствию поля. Добавлено без ломки остальных полей.
  return {
    ok: true,
    pid,
    state: 'aborted',
    duration_ms: abortResult.duration_ms,
    escalated: abortResult.escalated
  };
}

export const abort_pipeline = {
  name: 'abort_pipeline',
  description: 'Gracefully abort a running pipeline with optional grace period',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    options: z.object({
      grace_sec: z.number().min(0).max(60).optional().describe('Grace period in seconds [0-60], default 10')
    }).optional()
  }),
  async execute({ project, options = {} }) {
    return await abortPipelineImpl(project, options);
  }
};
