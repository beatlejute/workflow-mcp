/**
 * Фикстура lock-файла раннера.
 *
 * `.workflow/logs/.pipeline.lock` — единственный источник pid идущего
 * пайплайна. Прежде тесты писали `.runner-pids`; файла с таким именем не
 * пишет никто, и фикстуры воспроизводили контракт, которого не существует.
 */

import fs from 'fs';
import path from 'path';

/**
 * Кладёт lock раннера в проект.
 *
 * @param {string} projectRoot корень проекта (не `.workflow`)
 * @param {number} pid pid раннера
 * @param {Object} [extra] переопределения полей: `started_by`, `run_id`,
 *   `started_at`, `timestamp`
 * @returns {string} путь к записанному файлу
 */
export function writeRunnerLock(projectRoot, pid, extra = {}) {
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const now = new Date().toISOString();
  const lockPath = path.join(logsDir, '.pipeline.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      { pid, timestamp: now, started_at: now, started_by: 'mcp', ...extra },
      null,
      2
    )
  );
  return lockPath;
}

/** Путь к lock-файлу проекта. */
export function runnerLockPath(projectRoot) {
  return path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock');
}

/** Снимает lock, если он есть. */
export function removeRunnerLock(projectRoot) {
  try {
    fs.unlinkSync(runnerLockPath(projectRoot));
  } catch {
    // нет файла — нечего снимать
  }
}
