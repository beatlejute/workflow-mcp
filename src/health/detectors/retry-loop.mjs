import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCounterLimit } from '../thresholds.mjs';

/**
 * Detects if the task execution counter is at its last attempt.
 * Returns an Alert if current == limit - 1, otherwise null.
 *
 * @param {string} projectPath - Path to the project directory
 * @param {Object} thresholds - Threshold configuration (unused, kept for signature compatibility)
 * @returns {Object|null} Alert object or null
 */
export function detectRetryLoop(projectPath, thresholds) {
  const counterName = 'task_attempts';

  // Read limit from pipeline.yaml via getCounterLimit
  const limit = getCounterLimit(projectPath, counterName);
  if (limit === null) {
    // Limit not configured → not a retry-loop condition
    console.warn(`[retry_loop] counter limit not defined for "${counterName}" in pipeline.yaml`);
    return null;
  }

  // Read current counter value from runner's counter file
  const countersPath = resolve(projectPath, '.workflow', 'state', 'counters.json');

  // If counter file does not exist → fresh start → null
  if (!existsSync(countersPath)) {
    return null;
  }

  let counters;
  try {
    const raw = readFileSync(countersPath, 'utf8');
    counters = JSON.parse(raw);
  } catch (err) {
    console.warn(`[retry_loop] failed to parse counter file: ${err.message}`);
    return null;
  }

  const current = counters[counterName];
  if (typeof current !== 'number') {
    // Counter not found or not a number
    return null;
  }

  // Check if this is the last attempt: current == limit - 1
  if (current === limit - 1) {
    // Gather project name
    const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

    // Derive run_id from the most recent pipeline log (if available)
    let runId = 'unknown';
    try {
      const logsDir = resolve(projectPath, '.workflow', 'logs');
      const files = readdirSync(logsDir);
      let latestMtime = 0;
      let latestLog = null;
      for (const file of files) {
        if (file.startsWith('pipeline_') && file.endsWith('.log')) {
          const filePath = resolve(logsDir, file);
          const stats = statSync(filePath);
          if (stats.mtimeMs > latestMtime) {
            latestMtime = stats.mtimeMs;
            latestLog = file;
          }
        }
      }
      if (latestLog) {
        const match = latestLog.match(/pipeline_(.+?)\.log$/);
        if (match) runId = match[1];
      }
    } catch (e) {
      // ignore, keep unknown
    }

    const alert = {
      fingerprint: `retry_loop:${projectName}:${counterName}:${current}`,
      type: 'retry_loop',
      severity: 'warning',
      project: projectName,
      run_id: runId,
      ticket_id: '',
      message: `Counter ${counterName}: ${current}/${limit}, last attempt`,
      detected_at: new Date().toISOString(),
      suggested_actions: ['get_pipeline_log']
    };

    return alert;
  }

  return null;
}
