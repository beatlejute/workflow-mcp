import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProcessAlive } from '../pid-check.mjs';

/**
 * Detects crashed pipelines by checking if PIDs from .runner-pids are still alive.
 * Returns an Alert if a PID is dead AND its last log is fresh.
 *
 * @param {string} projectPath - Path to the project directory
 * @param {Object} config - Configuration object with crash_mtime_freshness_sec
 * @returns {Object|null} Alert object or null
 */
export function detectCrashed(projectPath, config) {
  const runnerPidsPath = resolve(projectPath, '.workflow', 'logs', '.runner-pids');
  const logsDir = resolve(projectPath, '.workflow', 'logs');

  // Read .runner-pids file
  let pids;
  try {
    const content = readFileSync(runnerPidsPath, 'utf8');
    pids = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => parseInt(line, 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    // File doesn't exist or can't be read - no PIDs to check
    if (error.code === 'ENOENT') {
      return null;
    }
    // Other errors - return null (can't check)
    return null;
  }

  if (pids.length === 0) {
    return null;
  }

  // Check each PID for liveness
  for (const pid of pids) {
    if (!isProcessAlive(pid)) {
      // Process is dead - check if log is fresh
      const alert = checkDeadPidAlert(projectPath, logsDir, pid, config);
      if (alert) {
        return alert;
      }
    }
  }

  // All processes alive
  return null;
}

/**
 * Check if a dead PID should generate an alert based on log freshness
 * @param {string} projectPath - Project path
 * @param {string} logsDir - Path to logs directory
 * @param {number} deadPid - The dead PID
 * @param {Object} config - Config with crash_mtime_freshness_sec
 * @returns {Object|null} Alert or null
 */
function checkDeadPidAlert(projectPath, logsDir, deadPid, config) {
  const freshnessSec = config?.crash_mtime_freshness_sec ?? 60;
  const freshnessMs = freshnessSec * 1000;
  const now = Date.now();

  // Find the most recent pipeline_*.log
  let latestLog = null;
  let latestMtime = 0;

  try {
    const files = readdirSync(logsDir);
    for (const file of files) {
      if (file.startsWith('pipeline_') && file.endsWith('.log')) {
        const filePath = resolve(logsDir, file);
        const stats = statSync(filePath);
        if (stats.mtimeMs > latestMtime) {
          latestMtime = stats.mtimeMs;
          latestLog = filePath;
        }
      }
    }
  } catch (error) {
    // Can't read logs directory
    return null;
  }

  if (!latestLog) {
    // No logs found
    return null;
  }

  // Check if log is fresh
  const logAge = now - latestMtime;
  if (logAge > freshnessMs) {
    // Log is stale - don't alert
    return null;
  }

  // Process is dead AND log is fresh - generate alert
  const runId = latestLog.match(/pipeline_(.+?)\.log$/)?.[1] || 'unknown';
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const alert = {
    fingerprint: `crashed:${projectName}:${deadPid}`,
    type: 'crashed',
    severity: 'critical',
    project: projectName,
    run_id: runId,
    pid: deadPid,
    message: `Pipeline process ${deadPid} has crashed`,
    detected_at: new Date().toISOString(),
    suggested_actions: ['get_pipeline_log', 'restart_pipeline']
  };

  return alert;
}
