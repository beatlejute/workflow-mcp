import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGhostMarkerMatcher } from '../ghost-marker.mjs';

/**
 * Detects ghost-execution marker in the most recent pipeline log.
 * Returns an Alert if the marker is found, otherwise null.
 *
 * @param {string} projectPath - Path to the project directory
 * @param {string} marker - Marker string to search for in the log (e.g., "ghost-execution")
 * @returns {Object|null} Alert object or null
 */
export function detectGhostExecution(projectPath, marker) {
  const logsDir = resolve(projectPath, '.workflow', 'logs');

  // Find the most recent pipeline_*.log file
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
    // No logs directory or can't read it → null
    return null;
  }

  if (!latestLog) {
    // No pipeline log files found → null
    return null;
  }

  // Read the log file
  let logContent;
  try {
    logContent = readFileSync(latestLog, 'utf8');
  } catch (error) {
    // Cannot read file → null
    return null;
  }

  // If log is empty → null
  if (!logContent || logContent.trim().length === 0) {
    return null;
  }

  // FIX-001: маркер ищется как структурный обособленный токен, а не подстрокой.
  // Прежний includes() давал critical-алерт на любое упоминание слов
  // «ghost-execution» в прозе — теге тикета, commit message, имени файла.
  const matcher = buildGhostMarkerMatcher(marker);
  if (!logContent.split('\n').some(line => matcher.test(line))) {
    return null;
  }

  // Build the alert
  const runId = latestLog.match(/pipeline_(.+?)\.log$/)?.[1] || 'unknown';
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const alert = {
    fingerprint: `ghost_execution:${projectName}:${runId}`,
    type: 'ghost_execution',
    severity: 'critical',
    project: projectName,
    run_id: runId,
    ticket_id: '',
    message: `Ghost execution marker "${matcher.marker}" found in pipeline log`,
    detected_at: new Date().toISOString(),
    suggested_actions: ['get_pipeline_log']
  };

  return alert;
}
