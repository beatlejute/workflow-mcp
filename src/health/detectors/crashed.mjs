import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProcessAlive } from '../pid-check.mjs';
import { readPipelineLock } from '../../process/run-lock.mjs';

/**
 * Детектор упавшего пайплайна: pid раннера мёртв, а лог ещё свежий.
 *
 * Источник pid — `.workflow/logs/.pipeline.lock`, который пишет сам раннер
 * workflow-ai при любом запуске. Прежде детектор читал `.runner-pids` — файл,
 * которого не пишет никто, поэтому он не срабатывал ни разу за всё время
 * существования. Прогон всегда один: lock держит синглтон, так что и pid один.
 *
 * @param {string} projectPath Путь к каталогу проекта
 * @param {Object} config Конфигурация с `crash_mtime_freshness_sec`
 * @returns {Object|null} Алерт или null
 */
export function detectCrashed(projectPath, config) {
  const lock = readPipelineLock(projectPath);

  // Нет lock'а — нет прогона, падать нечему. Битый lock `readPipelineLock`
  // отдаёт как отсутствующий: по мусору нельзя утверждать, что процесс умер.
  if (!lock) {
    return null;
  }

  if (isProcessAlive(lock.pid)) {
    return null;
  }

  const logsDir = resolve(projectPath, '.workflow', 'logs');
  return checkDeadPidAlert(projectPath, logsDir, lock, config);
}

/**
 * Решает, поднимать ли алерт по мёртвому pid, по свежести лога.
 *
 * Свежесть обязательна: lock нормально переживает конец прогона на доли
 * секунды, и без проверки каждый завершившийся пайплайн выглядел бы крахом.
 *
 * @param {string} projectPath Путь к проекту
 * @param {string} logsDir Каталог логов
 * @param {{pid: number, run_id: string|null}} lock Прочитанный lock раннера
 * @param {Object} config Конфигурация с `crash_mtime_freshness_sec`
 * @returns {Object|null} Алерт или null
 */
function checkDeadPidAlert(projectPath, logsDir, lock, config) {
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
  const runId = lock.run_id || latestLog.match(/pipeline_(.+?)\.log$/)?.[1] || 'unknown';
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const alert = {
    fingerprint: `crashed:${projectName}:${lock.pid}`,
    type: 'crashed',
    severity: 'critical',
    project: projectName,
    run_id: runId,
    pid: lock.pid,
    message: `Pipeline process ${lock.pid} has crashed`,
    detected_at: new Date().toISOString(),
    suggested_actions: ['get_pipeline_log', 'restart_pipeline']
  };

  return alert;
}
