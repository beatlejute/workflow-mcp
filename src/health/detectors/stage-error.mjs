import { parsePipelineLog } from '../../parsers/pipeline-log.mjs';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Detects stage_error from the last COMPLETE step in the most recent pipeline log.
 * Returns an Alert if the last COMPLETE has status="error" or exitCode !== 0.
 * Otherwise returns null.
 *
 * @param {string} projectPath - Path to the project directory
 * @returns {Object|null} Alert object or null
 */
export function detectStageError(projectPath) {
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
    // No logs directory or can't read it
    return null;
  }

  if (!latestLog) {
    return null;
  }

  // Parse the log file
  let logContent;
  try {
    logContent = readFileSync(latestLog, 'utf8');
  } catch (error) {
    return null;
  }

  const steps = parsePipelineLog(logContent);

  // Find all COMPLETE steps (steps with completed_at set)
  const completeSteps = steps.filter(s => s.completed_at !== null);

  // If no COMPLETE steps, return null
  if (completeSteps.length === 0) {
    return null;
  }

  // Take only the last COMPLETE step
  const lastComplete = completeSteps[completeSteps.length - 1];

  // Check if it's an error: status === "error" OR exit_code !== 0
  const isError = lastComplete.status === 'error' || lastComplete.exit_code !== 0;

  if (!isError) {
    return null;
  }

  // Build the alert
  const runId = latestLog.match(/pipeline_(.+?)\.log$/)?.[1] || 'unknown';
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const alert = {
    fingerprint: `stage_error:${projectName}:${lastComplete.stage}:${lastComplete.step_number}`,
    type: 'stage_error',
    severity: 'warning',
    project: projectName,
    run_id: runId,
    step_number: lastComplete.step_number,
    stage: lastComplete.stage,
    ticket_id: lastComplete.context?.ticket_id || '',
    message: `Stage "${lastComplete.stage}" (step ${lastComplete.step_number}) completed with status="${lastComplete.status}" exitCode=${lastComplete.exit_code}`,
    detected_at: new Date().toISOString(),
    suggested_actions: ['get_pipeline_log', 'get_pipeline_status']
  };

  return alert;
}
