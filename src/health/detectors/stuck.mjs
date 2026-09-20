import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePipelineLog } from '../../parsers/pipeline-log.mjs';
import { getStageTimeout } from '../thresholds.mjs';
import { isProcessAlive } from '../pid-check.mjs';
import { readPipelineLock } from '../../process/run-lock.mjs';

/**
 * Detects stuck stages by checking if the current stage has been running
 * longer than its timeout plus headroom.
 * Returns an Alert if stuck, otherwise null.
 *
 * @param {string} projectPath - Path to the project directory
 * @param {Object} thresholds - Configuration object with stuck_headroom_sec
 * @returns {Object|null} Alert object or null
 */
export function detectStuck(projectPath, thresholds) {
  const logsDir = resolve(projectPath, '.workflow', 'logs');

  // Мёртвый раннер — забота detectCrashed, здесь такой прогон пропускается.
  // pid берётся из `.pipeline.lock`; раньше читался `.runner-pids`, которого
  // не пишет никто, и ветка не исполнялась ни разу.
  const lock = readPipelineLock(projectPath);
  if (lock && !isProcessAlive(lock.pid)) {
    return null;
  }

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

  // Parse the log file to get steps
  const steps = parsePipelineLog(logContent);

  // Find the last START step (currently running stage)
  // Looking for a step with started_at but no completed_at
  const runningStep = steps.find(s => s.started_at && !s.completed_at);

  if (!runningStep) {
    // No running stage found → null
    return null;
  }

  // Check if stage just started (mtime < 1 sec) to avoid false positives
  const now = Date.now();
  if (now - latestMtime < 1000) {
    return null;
  }

  // Get stage timeout
  let timeoutSec;
  try {
    timeoutSec = getStageTimeout(projectPath, runningStep.stage);
  } catch (error) {
    if (error.message === 'STAGE_NOT_FOUND') {
      // Stage not found - return null + warning
      console.error(`Warning: Stage "${runningStep.stage}" not found in pipeline.yaml`);
      return null;
    }
    // Other errors - return null
    return null;
  }

  // Get stuck_headroom_sec from thresholds
  const headroomSec = thresholds?.stuck_headroom_sec ?? 60;

  // Calculate if stage is stuck: now - log.mtime > timeout + headroom
  const logAgeSec = (now - latestMtime) / 1000;
  const thresholdSec = timeoutSec + headroomSec;

  if (logAgeSec <= thresholdSec) {
    // Not stuck yet
    return null;
  }

  // Stage is stuck - generate alert
  const runId = latestLog.match(/pipeline_(.+?)\.log$/)?.[1] || 'unknown';
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const alert = {
    fingerprint: `stuck:${projectName}:${runningStep.stage}:${runId}`,
    type: 'stuck',
    severity: 'critical',
    project: projectName,
    run_id: runId,
    stage: runningStep.stage,
    step_number: runningStep.step_number,
    ticket_id: runningStep.context?.ticket_id || '',
    message: `Stage ${runningStep.stage} running ${Math.round(logAgeSec)}s, timeout is ${timeoutSec}s (stuck)`,
    detected_at: new Date().toISOString(),
    suggested_actions: ['get_pipeline_log', 'get_pipeline_status']
  };

  return alert;
}
