import { getMcpConfig } from './thresholds.mjs';
import { sweepProjects } from './sweep.mjs';

/**
 * Creates a health watcher factory
 * @param {Object} options - Configuration options
 * @param {string} options.cwd - Current working directory
 * @param {Array|Function} options.projects - List of projects to monitor, or a
 *   function returning it. Функция нужна серверу: discovery пересобирает список
 *   на лету, и захваченный при старте массив устаревает после первой же правки
 *   состава проектов.
 * @param {Function} options.onAlert - Callback for alerts
 * @param {Function} [options.onResolved] - Вызывается, когда условие, которое
 *   было в прошлом обходе, больше не срабатывает. Нужен подписчику на
 *   `workflow://alerts`: ресурс отвечает обходом, значит его содержимое
 *   меняется и при исчезновении условия, а не только при появлении.
 * @returns {Object} Object with start() and stop() methods
 */
export function createWatcher({ cwd, projects, onAlert, onResolved }) {
  let intervalId = null;

  /** Отпечатки прошлого обхода — чтобы заметить исчезнувшие условия. */
  let previousFingerprints = new Set();

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

  /** Отпечаток алерта: по нему же дедуплицирует publisher. */
  function fingerprintOf(alert) {
    return alert.fingerprint ?? `${alert.type}:${alert.project}`;
  }

  /**
   * Один проход: обход детекторов, публикация и сравнение с прошлым проходом.
   */
  function tick() {
    // Тело тика целиком под защитой. Внутри защищены только детекторы, а
    // чтение конфига и получение списка проектов — нет: исключение в
    // колбэке `setInterval` не ловит никто, и процесс сервера умирает.
    try {
      // Обход общий с ресурсом `workflow://alerts`: см. `health/sweep.mjs`.
      const alerts = sweepProjects(cwd, currentProjects());
      const currentFingerprints = new Set(alerts.map(fingerprintOf));

      for (const alert of alerts) {
        onAlert(alert);
      }

      // Дедуп глушит повторное появление, но исчезновение он не заметит: там
      // события нет вовсе. Сообщаем о нём отдельно — иначе подписчик держит в
      // руках список, из которого условие уже ушло.
      let resolved = false;
      for (const fingerprint of previousFingerprints) {
        if (!currentFingerprints.has(fingerprint)) {
          resolved = true;
          break;
        }
      }
      previousFingerprints = currentFingerprints;

      if (resolved && typeof onResolved === 'function') {
        try {
          onResolved();
        } catch (err) {
          console.error('[health] resolved callback failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[health] tick failed:', err.message);
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

    intervalId = setInterval(tick, tickIntervalMs);
  }

  /**
   * Stop the watcher and clean up resources
   */
  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    previousFingerprints = new Set();
  }

  return { start, stop };
}
