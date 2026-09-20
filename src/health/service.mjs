/**
 * Служба здоровья: единственное место, где детекторы, дедуп и уведомления
 * клиенту собираются в одну работающую цепочку.
 *
 * Цепочка существовала по частям и не была замкнута: `watcher.mjs` никто не
 * запускал, `publisher.mjs` никто не создавал, а ресурс `workflow://alerts`
 * при этом был зарегистрирован и всегда отдавал пустой список. Отдельный
 * модуль, а не десяток строк внутри `server.mjs`, — чтобы у сборки был тест:
 * `server.mjs` поднимает stdio-транспорт и в тестах не запускается.
 */

import { createWatcher } from './watcher.mjs';
import { createPublisher } from './publisher.mjs';
import { getMcpConfig } from './thresholds.mjs';

/**
 * @param {Object} options
 * @param {string} options.cwd Корень рабочей области (`MCP_CWD`)
 * @param {Array|Function} options.projects Список проектов либо функция,
 *   возвращающая актуальный список: discovery пересобирает его на лету.
 * @param {{dir: string|null, mode: 'writable'|'read-only'}} options.stateDir
 *   Каталог состояния для истории алертов.
 * @param {(alert: Object) => void} options.onAlert Вызывается для каждого
 *   алерта, прошедшего дедуп.
 * @returns {{start: () => boolean, stop: () => void, enabled: boolean}}
 */
export function createHealthService({ cwd, projects, stateDir, onAlert }) {
  const config = getMcpConfig(cwd);
  const enabled = config.enabled !== false;

  // Выключенная служба не должна оставлять следов: `createPublisher` создаёт
  // каталог состояния и перечитывает историю алертов, поэтому собирается
  // только при старте.
  if (!enabled) {
    return {
      enabled: false,
      start() { return false; },
      stop() { }
    };
  }

  const publisher = createPublisher({
    // Исключение из колбэка не должно ронять тик: следующие проекты в том же
    // проходе иначе остались бы непроверенными.
    onAlert: (alert) => {
      try {
        onAlert(alert);
      } catch (err) {
        console.error('[health] alert callback failed:', err.message);
      }
    },
    stateDir,
    config
  });

  const watcher = createWatcher({
    cwd,
    projects,
    onAlert: (alert) => {
      try {
        publisher.publishAlert(alert);
      } catch (err) {
        // Сюда доходит только отказ записи в историю: сам колбэк выше уже
        // проглатывает свои ошибки.
        console.error('[health] failed to record alert:', err.message);
      }
    }
  });

  let started = false;

  return {
    enabled,

    /** @returns {boolean} запустилась ли служба (false, если выключена конфигом) */
    start() {
      if (started) {
        return false;
      }
      watcher.start();
      started = true;
      return true;
    },

    stop() {
      if (!started) {
        return;
      }
      watcher.stop();
      started = false;
    }
  };
}
