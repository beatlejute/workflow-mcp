import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../discovery.mjs';
import { mcpCwd } from '../lib/project-root.mjs';

/**
 * Pipeline Log Latest Resource - subscribable live-tail for pipeline logs
 * Resource URI: workflow://{project}/logs/pipeline/latest
 *
 * Supports cursor-based incremental reading via ?cursor=<byte_offset>
 * Uses fs.watch to monitor the latest pipeline log file and sends
 * resources/updated notifications on changes (coalesced 200ms).
 */

// Watches keyed by project name
const projectWatches = new Map();

// Coalescing buffers for notifications
const notificationTimers = new Map();
const NOTIFICATION_COALESCE_MS = 200;

// Max log size before requiring explicit cursor (100MB)
const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Find the latest pipeline log file for a project
 * @param {string} logsDir - Path to .workflow/logs directory
 * @returns {{path: string, name: string, runId: string, mtime: Date}|null}
 */
function findLatestLogFile(logsDir) {
  try {
    if (!fs.existsSync(logsDir)) {
      return null;
    }
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(logsDir, f),
        mtime: fs.statSync(path.join(logsDir, f)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length === 0) {
      return null;
    }

    const file = files[0];
    const runIdMatch = file.name.match(/pipeline_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    const runId = runIdMatch ? `pipeline_${runIdMatch[1]}` : file.name;

    return {
      path: file.path,
      name: file.name,
      runId,
      mtime: file.mtime,
      size: file.size || fs.statSync(file.path).size
    };
  } catch (err) {
    return null;
  }
}

/**
 * Get file size safely
 * @param {string} logPath
 * @returns {number}
 */
function getFileSize(logPath) {
  try {
    return fs.statSync(logPath).size;
  } catch (err) {
    return 0;
  }
}

/**
 * Resolve the current log file for a project, handling latest symlink pattern
 * @param {string} logsDir - Path to .workflow/logs directory
 * @param {string|null} cursorLogName - Previously known log file name to detect rotation
 * @returns {{file: {path: string, name: string, runId: string, mtime: Date}|null, rotated: boolean, truncated: boolean, prevSize: number|null}}
 */
function resolveLogFile(logsDir, cursorLogName) {
  const latest = findLatestLogFile(logsDir);

  if (!latest) {
    return { file: null, rotated: false, truncated: false, prevSize: null };
  }

  let rotated = false;
  let truncated = false;
  let prevSize = null;

  if (cursorLogName && cursorLogName !== latest.name) {
    // Check if previous file still exists (truncate scenario) or it's a new run (rotation)
    const prevPath = path.join(logsDir, cursorLogName);
    if (fs.existsSync(prevPath)) {
      // Previous file still exists but a newer one appeared - this is a new run
      rotated = true;
    } else {
      // Previous file gone - could be truncate/rotation, treat as rotation
      rotated = true;
    }
  }

  // Check for truncation: current file size less than expected cursor position
  // (this is handled at read time based on cursor vs actual file size)

  return { file: latest, rotated, truncated, prevSize };
}

/**
 * Read log content from a specific byte offset
 * @param {string} logPath - Path to log file
 * @param {number|null} cursor - Byte offset to start reading from
 * @param {number} tailLines - Number of lines to return (default 1000)
 * @returns {{lines: string[], nextCursor: number|null, logSizeBytes: number, fromCursor: number, truncated: boolean, prevSize: number|null}}
 */
function readLogFromCursor(logPath, cursor = null, tailLines = 1000) {
  if (!fs.existsSync(logPath)) {
    throw new Error('LOG_FILE_NOT_FOUND');
  }

  const logSizeBytes = getFileSize(logPath);

  // Check for truncation: if cursor is beyond current file size, file was truncated
  let truncated = false;
  let prevSize = null;
  let effectiveCursor = cursor;

  if (cursor !== null && cursor > logSizeBytes) {
    truncated = true;
    prevSize = cursor;
    // Start from beginning after truncation
    effectiveCursor = 0;
  }

  // If cursor is null, default to reading the tail of the file
  let startByte = 0;
  if (effectiveCursor !== null) {
    startByte = effectiveCursor;
  } else {
    // No cursor: read last N lines by seeking from end
    // For simplicity, read entire file and slice last lines
    // In production this could be optimized with reverse reading
  }

  const buffer = fs.readFileSync(logPath);
  const content = buffer.toString('utf-8');
  const lines = content.split('\n').filter(l => l.length > 0 || l === '');

  let selectedLines;
  let nextCursor;

  if (effectiveCursor !== null) {
    // Count newlines up to cursor to find starting line
    let byteCount = 0;
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length + 1; // +1 for newline
      if (byteCount + lineLength > effectiveCursor) {
        startLine = i;
        break;
      }
      byteCount += lineLength;
    }
    // If cursor is in middle of line, include from that line
    selectedLines = lines.slice(startLine);
    nextCursor = effectiveCursor + buffer.slice(effectiveCursor).length;
  } else {
    // No cursor: return tail lines
    const startLine = Math.max(0, lines.length - tailLines);
    selectedLines = lines.slice(startLine);
    // Calculate cursor for next read (end of file)
    nextCursor = logSizeBytes;
  }

  return {
    lines: selectedLines,
    nextCursor,
    logSizeBytes,
    fromCursor: effectiveCursor || 0,
    truncated,
    prevSize
  };
}

/**
 * Get the resource content for a project's latest pipeline log
 * @param {string} cwd - Current working directory
 * @param {string} projectName - Project name
 * @param {URL} uri - Parsed resource URI (for query params)
 * @returns {{content: string, mimeType: string, metadata: object}}
 */
export async function get_workflow_project_pipeline_log_latest(cwd, projectName, uri = null) {
  if (!cwd) cwd = process.cwd();
  const projects = discoverProjects(cwd);
  const project = projects.find(p => p.name === projectName);

  if (!project) {
    throw new Error(`Project "${projectName}" not found`);
  }

  const logsDir = path.join(project.path, '.workflow', 'logs');
  const latest = findLatestLogFile(logsDir);

  if (!latest) {
    throw new Error('No pipeline log found');
  }

  // Check size limit
  const fileSize = getFileSize(latest.path);
  if (fileSize > MAX_LOG_SIZE_BYTES) {
    // Check if explicit cursor parameter was provided
    let cursor = null;
    if (uri) {
      try {
        cursor = uri.searchParams.get('cursor');
      } catch (e) {
        cursor = null;
      }
    }
    if (cursor === null) {
      throw new Error('LOG_TOO_LARGE: Log exceeds 100MB, explicit cursor parameter required');
    }
  }

  // Parse cursor from URI query parameter
  let cursorOffset = null;
  if (uri) {
    try {
      const cursorParam = uri.searchParams.get('cursor');
      if (cursorParam) {
        cursorOffset = parseInt(cursorParam, 10);
        if (isNaN(cursorOffset)) {
          cursorOffset = null;
        }
      }
    } catch (e) {
      cursorOffset = null;
    }
  }

  let tailLines = 1000;
  if (uri) {
    try {
      const tailParam = uri.searchParams.get('tail_lines');
      if (tailParam) {
        const parsed = parseInt(tailParam, 10);
        if (!isNaN(parsed) && parsed > 0) {
          tailLines = Math.min(parsed, 10000); // Cap at 10k
        }
      }
    } catch (e) {
      tailLines = 1000;
    }
  }

  const result = readLogFromCursor(latest.path, cursorOffset, tailLines);

  const response = {
    lines: result.lines,
    run_id: latest.runId,
    log_size_bytes: result.logSizeBytes,
    next_cursor: result.nextCursor,
    from_cursor: result.fromCursor
  };

  if (result.truncated) {
    response.truncated = true;
    response.prev_size_bytes = result.prevSize;
  }

  if (result.truncated || (cursorOffset === null && result.fromCursor > 0)) {
    response.from_cursor = result.fromCursor;
  }

  return {
    content: JSON.stringify(response, null, 2),
    mimeType: 'application/json',
    metadata: {
      runId: latest.runId,
      logSizeBytes: result.logSizeBytes,
      rotated: false,
      truncated: result.truncated
    }
  };
}

// Watch state per project
const watchState = new Map();

/**
 * Start watching a project's latest log file for changes
 *
 * `cwd` приходит от сервера: при `MCP_CWD ≠ cwd` процесса discovery от
 * рабочего каталога не находил проект, и watcher молча не ставился — чтение
 * ресурса работало, а `resources/updated` не приходили ни разу.
 *
 * @param {string} projectName
 * @param {Function} notifyCallback - Called to trigger resource update notification
 * @param {string} [cwd] - Корень рабочей области; по умолчанию `mcpCwd()`
 */
export function startWatching(projectName, notifyCallback, cwd = mcpCwd()) {
  if (watchState.has(projectName)) {
    return; // Already watching
  }

  const projects = discoverProjects(cwd);
  const project = projects.find(p => p.name === projectName);

  if (!project) {
    return;
  }

  const logsDir = path.join(project.path, '.workflow', 'logs');
  const latestLogInfo = findLatestLogFile(logsDir);

  let currentLogName = latestLogInfo ? latestLogInfo.name : null;
  let currentLogPath = latestLogInfo ? latestLogInfo.path : null;

  // Watch the logs directory for new/latest log files
  let watcher = null;
  try {
    watcher = fs.watch(logsDir, (eventType, filename) => {
      if (!filename) {
        return;
      }

      // Only care about pipeline log files
      if (!filename.startsWith('pipeline_') || !filename.endsWith('.log')) {
        return;
      }

      // Coalesce notifications
      const timerKey = `project-${projectName}`;
      if (notificationTimers.has(timerKey)) {
        clearTimeout(notificationTimers.get(timerKey));
      }

      notificationTimers.set(timerKey, setTimeout(() => {
        notificationTimers.delete(timerKey);

        const latestNow = findLatestLogFile(logsDir);
        if (!latestNow) {
          return;
        }

        const rotated = currentLogName && currentLogName !== latestNow.name;

        if (rotated) {
          // New run detected - cursor resets to 0
          currentLogName = latestNow.name;
          currentLogPath = latestNow.path;
          notifyCallback(`workflow://${projectName}/logs/pipeline/latest`, {
            rotated: true,
            new_run: true,
            run_id: latestNow.runId,
            cursor_reset: 0
          });
        } else {
          // Append to same log
          notifyCallback(`workflow://${projectName}/logs/pipeline/latest`, {
            rotated: false,
            new_run: false,
            run_id: latestNow.runId
          });
        }
      }, NOTIFICATION_COALESCE_MS));
    });

    watchState.set(projectName, {
      watcher,
      logsDir,
      currentLogName,
      currentLogPath,
      notifyCallback
    });
  } catch (err) {
    // Watch may fail on some systems, silently ignore
    if (watcher) {
      try { watcher.close(); } catch (e) {}
    }
  }
}

/**
 * Stop watching a project's log file
 * @param {string} projectName
 */
export function stopWatching(projectName) {
  const state = watchState.get(projectName);
  if (state) {
    try {
      state.watcher.close();
    } catch (e) {
      // Ignore
    }
    watchState.delete(projectName);

    const timerKey = `project-${projectName}`;
    if (notificationTimers.has(timerKey)) {
      clearTimeout(notificationTimers.get(timerKey));
      notificationTimers.delete(timerKey);
    }
  }
}
