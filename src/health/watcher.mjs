import { getMcpConfig } from './thresholds.mjs';
import { runDetectorsForProject } from './sweep.mjs';

/**
 * Creates a health watcher factory
 * @param {Object} options - Configuration options
 * @param {string} options.cwd - Current working directory
 * @param {Array|Function} options.projects - List of projects to monitor, or a
 *   function returning it. Функция нужна серверу: discovery пересобирает список
 *   на лету, и захваченный при старте массив устаревает после первой же правки
 *   состава проектов.
 * @param {Function} options.onAlert - Callback for alerts
 * @returns {Object} Object with start() and stop() methods
 */
export function createWatcher({ cwd, projects, onAlert }) {
  let intervalId = null;

  /**
   * Текущий список проектов — массив либо результат вызова функции.
   *
   * Отказ функции не должен ронять ни старт, ни тик: список пересобирает
   * discovery, и его поломка не причина ронять сервер.
   */
  function currentProjects() {
    try {
      const list = typeof projects === 'function' ? projects() : projects;
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.error('[health] project list unavailable:', err.message);
      return [];
    }
  }

  /**
   * Start the watcher tick-loop
   */
  function start() {
    // Warn if too many projects
    const initialProjects = currentProjects();
    if (initialProjects.length > 20) {
      console.warn(`Health watcher monitoring ${initialProjects.length} projects. Consider configuring a whitelist for better performance.`);
    }

    // Get tick interval from config
    const config = getMcpConfig(cwd);
    const tickIntervalSec = config.tick_interval_sec ?? 15;
    const tickIntervalMs = tickIntervalSec * 1000;

    // Set up tick loop
    intervalId = setInterval(() => {
      // Тело тика целиком под защитой. Внутри защищены только детекторы, а
      // чтение конфига и получение списка проектов — нет: исключение в
      // колбэке `setInterval` не ловит никто, и процесс сервера умирает.
      try {
        // Get config once per tick for detector thresholds
        const config = getMcpConfig(cwd);

        // Loop through projects and run all detectors
        for (const project of currentProjects()) {
          // Обход общий с ресурсом `workflow://alerts`: см. `health/sweep.mjs`.
          const alerts = runDetectorsForProject(project.path, config);

          // Send alerts to callback
          for (const alert of alerts) {
            onAlert(alert);
          }
        }
      } catch (err) {
        console.error('[health] tick failed:', err.message);
      }
    }, tickIntervalMs);
  }

  /**
   * Stop the watcher and clean up resources
   */
  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, stop };
}
