import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { validateMarker, readMarker, removeMarker } from '../process/marker.mjs';
import { kill, pause, resume, abort } from '../process/control.mjs';
import { notify_workflow_pipeline_state } from '../resources/index.mjs';
import { get_workflow_pipeline_state } from '../resources/pipeline-state.mjs';
import { z } from 'zod';

function getMcpInstanceId() {
  const cwd = process.cwd();
  const hash = createHash('sha256').update(cwd).digest('hex');
  return `workflow-mcp@${hash.slice(0, 12)}`;
}

/**
 * Start a pipeline for a project.
 * Not yet fully implemented — stub for IMPL-49+.
 */
export const start_pipeline = {
  name: 'start_pipeline',
  description: 'Start a pipeline for a project',
  inputSchema: z.object({
    project: z.string().describe('Project path or name')
  }),
  async execute({ project }) {
    return { ok: false, code: 'NOT_IMPLEMENTED', hint: 'start_pipeline tool not yet implemented' };
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
    const cwd = process.env.MCP_CWD || process.cwd();

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
 * Resolve project root from project path
 * @param {string} project - Project path (relative or absolute)
 * @returns {string} Absolute project path
 */
function resolveProjectRoot(project) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, project);
  const workflowDir = path.join(resolved, '.workflow');
  if (!fs.existsSync(workflowDir)) {
    throw new Error(`Project not found or not a workflow project: ${project}`);
  }
  return resolved;
}

/**
 * Pause a running pipeline (implementation).
 * Validates marker, gets PID from .runner-pids (latest run), calls process/control.pause.
 * Returns {pid, state: "paused", paused_at} on success.
 */
export async function pausePipelineImpl(project) {
  const projectRoot = resolveProjectRoot(project);
  const marker = readMarker(projectRoot);

  // Validate marker
  const validation = validateMarker(projectRoot, process.pid, getMcpInstanceId());
  if (!validation.valid) {
    return {
      ok: false,
      code: 'MARKER_VALIDATION_FAILED',
      reason: validation.reason,
      hint: `Pipeline marker validation failed: ${validation.reason}`
    };
  }

  // Get PID from .runner-pids (latest/last run)
  const runnerPidsPath = path.join(projectRoot, '.runner-pids');
  let pid = null;
  try {
    const content = fs.readFileSync(runnerPidsPath, 'utf-8');
    const pids = content
      .split('\n')
      .map(line => parseInt(line.trim(), 10))
      .filter(n => !isNaN(n));

    // Get the last (latest) PID
    if (pids.length > 0) {
      pid = pids[pids.length - 1];
    }
  } catch (err) {
    return {
      ok: false,
      code: 'NO_RUNNER_PIDS',
      hint: `Failed to read .runner-pids: ${err.message}`
    };
  }

  if (!pid) {
    return {
      ok: false,
      code: 'NO_RUNNER_PIDS',
      hint: '.runner-pids file is empty or invalid'
    };
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
   * Validates marker, gets PID from .runner-pids (latest run), calls process/control.resume.
   * Returns {pid, state: "running"} on success.
   * Idempotent: if not paused, returns NOT_PAUSED.
   */
  export async function resumePipelineImpl(project) {
    const projectRoot = resolveProjectRoot(project);
    const marker = readMarker(projectRoot);

    // Validate marker
    const validation = validateMarker(projectRoot, process.pid, getMcpInstanceId());
    if (!validation.valid) {
      return {
        ok: false,
        code: 'MARKER_VALIDATION_FAILED',
        reason: validation.reason,
        hint: `Pipeline marker validation failed: ${validation.reason}`
      };
    }

    // Get PID from .runner-pids (latest/last run)
    const runnerPidsPath = path.join(projectRoot, '.runner-pids');
    let pid = null;
    try {
      const content = fs.readFileSync(runnerPidsPath, 'utf-8');
      const pids = content
        .split('\n')
        .map(line => parseInt(line.trim(), 10))
        .filter(n => !isNaN(n));

      // Get the last (latest) PID
      if (pids.length > 0) {
        pid = pids[pids.length - 1];
      }
    } catch (err) {
      return {
        ok: false,
        code: 'NO_RUNNER_PIDS',
        hint: `Failed to read .runner-pids: ${err.message}`
      };
    }

    if (!pid) {
      return {
        ok: false,
        code: 'NO_RUNNER_PIDS',
        hint: '.runner-pids file is empty or invalid'
      };
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
   * Validates marker (unless overridden by force=true), gets PID from .runner-pids, calls process/control.kill.
   * Removes marker after success.
   * Returns {pid, state: "killed"} on success.
   */
  export async function stopPipelineImpl(project, options = {}) {
    const force = options.force === true;
    const projectRoot = resolveProjectRoot(project);

    // Validate marker (unless force=true)
    if (!force) {
      const validation = validateMarker(projectRoot, process.pid, getMcpInstanceId());
      if (!validation.valid) {
        return {
          ok: false,
          code: 'FOREIGN_PIPELINE',
          reason: validation.reason,
          hint: `Pipeline is foreign (owned by another MCP instance). Use force=true to override: ${validation.reason}`
        };
      }
    }

    // Get PID from .runner-pids (latest/last run)
    const runnerPidsPath = path.join(projectRoot, '.runner-pids');
    let pid = null;
    try {
      const content = fs.readFileSync(runnerPidsPath, 'utf-8');
      const pids = content
        .split('\n')
        .map(line => parseInt(line.trim(), 10))
        .filter(n => !isNaN(n));

      // Get the last (latest) PID
      if (pids.length > 0) {
        pid = pids[pids.length - 1];
      }
    } catch (err) {
      return {
        ok: false,
        code: 'NO_RUNNER_PIDS',
        hint: `Failed to read .runner-pids: ${err.message}`
      };
    }

    if (!pid) {
      return {
        ok: false,
        code: 'NO_RUNNER_PIDS',
        hint: '.runner-pids file is empty or invalid'
      };
    }

    // Call process/control.kill()
    const killResult = await kill(pid);

    if (!killResult.ok) {
      return killResult;
    }

    // Remove marker after successful kill
    try {
      removeMarker(projectRoot);
    } catch (err) {
      // Marker removal failure doesn't block the operation
      console.error('Failed to remove marker:', err.message);
    }

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
      force: z.boolean().optional().describe('Override marker validation (requires explicit consent)')
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
    const cwd = process.env.MCP_CWD || process.cwd();
    const absoluteCwd = path.resolve(cwd);
    const pipelines = await get_workflow_pipeline_state(absoluteCwd);
    return pipelines;
  }
};

/**
 * Resolve abort state file for a given project.
 * @param {string} projectRoot
 * @returns {string} Path to abort state file in state-dir
 */
function getAbortStateFile(projectRoot) {
  return path.join(projectRoot, '.workflow', 'state', 'abort-state.json');
}

/**
 * Check if an abort is already in progress for the given project.
 * Uses a state file in state-dir as a flag.
 * @param {string} projectRoot
 * @returns {boolean} True if abort is already in progress
 */
function isAbortInProgress(projectRoot) {
  const abortStateFile = getAbortStateFile(projectRoot);
  if (!fs.existsSync(abortStateFile)) {
    return false;
  }
  try {
    const data = JSON.parse(fs.readFileSync(abortStateFile, 'utf-8'));
    // Consider abort in-progress if started_at is recent (within last 10 minutes)
    if (data.started_at) {
      const startedAt = new Date(data.started_at).getTime();
      const now = Date.now();
      // If it's been more than 10 minutes, treat as stale
      if (now - startedAt > 10 * 60 * 1000) {
        return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Write abort in-progress flag to state-dir.
 * @param {string} projectRoot
 */
function writeAbortState(projectRoot) {
  const abortStateFile = getAbortStateFile(projectRoot);
  const data = {
    started_at: new Date().toISOString(),
    pid: process.pid,
    mcp_instance_id: getMcpInstanceId()
  };
  try {
    fs.mkdirSync(path.dirname(abortStateFile), { recursive: true });
    fs.writeFileSync(abortStateFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    // Best-effort; failure to write flag is non-blocking
    console.error('Failed to write abort state:', err.message);
  }
}

/**
 * Clear abort in-progress flag from state-dir.
 * @param {string} projectRoot
 */
function clearAbortState(projectRoot) {
  const abortStateFile = getAbortStateFile(projectRoot);
  try {
    fs.unlinkSync(abortStateFile);
  } catch (err) {
    // Idempotent: ignore if file doesn't exist
  }
}

/**
 * Implementation for abort_pipeline tool.
 * Graceful shutdown: SIGINT → wait grace_sec → SIGTERM (POSIX).
 * Windows: taskkill /PID → wait → taskkill /F.
 * After grace period, marker is removed via removeMarker.
 * Returns {pid, state: "aborted", duration_ms, escalated: bool}.
 * Parallel abort on same project → ALREADY_ABORTING.
 */
export async function abortPipelineImpl(project, options = {}) {
  const projectRoot = resolveProjectRoot(project);
  const graceSec = options.grace_sec !== undefined ? options.grace_sec : 10;
  // Clamp grace_sec to [0, 60]
  const clampedGraceSec = Math.max(0, Math.min(60, graceSec));

  // Validate marker
  const validation = validateMarker(projectRoot, process.pid, getMcpInstanceId());
  if (!validation.valid) {
    return {
      ok: false,
      code: 'FOREIGN_PIPELINE',
      reason: validation.reason,
      hint: `Pipeline is foreign (owned by another MCP instance). Cannot abort: ${validation.reason}`
    };
  }

  // Check for parallel abort already in progress (flag in state-dir)
  if (isAbortInProgress(projectRoot)) {
    return {
      ok: false,
      code: 'ALREADY_ABORTING',
      hint: 'An abort operation is already in progress for this project'
    };
  }

  // Get PID from .runner-pids
  const runnerPidsPath = path.join(projectRoot, '.runner-pids');
  let pid = null;
  try {
    const content = fs.readFileSync(runnerPidsPath, 'utf-8');
    const pids = content
      .split('\n')
      .map(line => parseInt(line.trim(), 10))
      .filter(n => !isNaN(n));

    if (pids.length > 0) {
      pid = pids[pids.length - 1];
    }
  } catch (err) {
    return {
      ok: false,
      code: 'NO_RUNNER_PIDS',
      hint: `Failed to read .runner-pids: ${err.message}`
    };
  }

  if (!pid) {
    return {
      ok: false,
      code: 'NO_RUNNER_PIDS',
      hint: '.runner-pids file is empty or invalid'
    };
  }

  // Set abort-in-progress flag (for parallel abort detection)
  writeAbortState(projectRoot);

  // Send notification: abort starting
  try {
    notify_workflow_pipeline_state();
  } catch (err) {
    console.error('Failed to notify pipeline-state on abort start:', err.message);
  }

  // Execute graceful abort using process/control.abort
  const abortResult = await abort(pid, { grace_sec: clampedGraceSec });

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

  // Remove marker after grace period completes
  try {
    removeMarker(projectRoot);
  } catch (err) {
    console.error('Failed to remove marker:', err.message);
  }

  // Clear abort-in-progress flag
  clearAbortState(projectRoot);

  // Send notification: abort completed
  try {
    notify_workflow_pipeline_state();
  } catch (err) {
    console.error('Failed to notify pipeline-state on abort complete:', err.message);
  }

  return {
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
