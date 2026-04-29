import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Detects accumulation of blocked tickets.
 * Returns an Alert if the number of blocked ticket files >= threshold, otherwise null.
 *
 * @param {string} projectPath - Path to the project directory
 * @param {number} threshold - Threshold for blocked ticket count
 * @returns {Object|null} Alert object or null
 */
export function detectBlockedAccumulation(projectPath, threshold) {
  const blockedDir = resolve(projectPath, '.workflow', 'tickets', 'blocked');

  // If blocked directory does not exist → null + warning
  if (!existsSync(blockedDir)) {
    console.warn(`[blocked_accumulation] directory does not exist: ${blockedDir}`);
    return null;
  }

  let files;
  try {
    files = readdirSync(blockedDir);
  } catch (err) {
    console.warn(`[blocked_accumulation] failed to read directory: ${err.message}`);
    return null;
  }

  // Filter files by regexp ^[A-Z]+-\d+\.md$ — only ticket files
  const ticketFiles = files.filter(file => /^[A-Z]+-\d+\.md$/.test(file));
  const count = ticketFiles.length;

  if (count >= threshold) {
    // Gather project name
    const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

    // Derive run_id from the most recent pipeline log (if available)
    let runId = 'unknown';
    try {
      const logsDir = resolve(projectPath, '.workflow', 'logs');
      const logs = readdirSync(logsDir);
      let latestMtime = 0;
      let latestLog = null;
      for (const file of logs) {
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
      fingerprint: `blocked_accumulation:${projectName}:${count}`,
      type: 'blocked_accumulation',
      severity: 'warning',
      project: projectName,
      run_id: runId,
      ticket_id: '',
      message: `${count} tickets blocked (threshold: ${threshold})`,
      detected_at: new Date().toISOString(),
      suggested_actions: ['get_pipeline_log']
    };

    return alert;
  }

  return null;
}