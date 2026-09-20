/**
 * Lock раннера и владение запуском.
 *
 * `.workflow/logs/.pipeline.lock` пишет сам раннер workflow-ai при любом
 * запуске — из CLI, из расширения VS Code или из MCP. Это единственный признак
 * «пайплайн идёт», общий для всех способов старта, и единственное место, где
 * есть pid живого раннера: `.runner-pids` не пишет никто.
 *
 * Владение читается отсюда же. Прежде рядом лежал второй файл —
 * `.workflow/logs/.mcp-started-by`, — и каждая проверка сверяла два файла про
 * один запуск. Весь класс дефектов, на который ушло восемь кругов ревью
 * (`PID_MISMATCH` на собственном пайплайне, инвертированный признак `foreign`,
 * расхождение идентификатора между писателем и читателем, `RUN_MISMATCH` на
 * остатках прошлого запуска), порождён именно этой парой. Теперь сервер
 * представляется раннеру через `WORKFLOW_STARTED_BY_ID`, раннер кладёт метку в
 * lock полем `started_by_id`, и файл владения остался один.
 *
 * Требует workflow-ai ≥ 1.7.0: раннер 1.6.x поля не пишет, и его запуск виден
 * как `INSTANCE_UNKNOWN` — «запущен MCP, но каким, неизвестно»; раннер ≤ 1.5.2
 * не писал и `started_by`, поэтому неотличим от запуска из CLI.
 */

import fs from 'fs';
import path from 'path';
import { pidCouldBeFromRun } from './process-start.mjs';

/**
 * Прочитать lock-файл пайплайна.
 *
 * @param {string} projectRoot
 * @returns {{pid: number, timestamp: string|null, started_at: string|null, started_by: string|null, started_by_id: string|null, run_id: string|null}|null}
 */
export function readPipelineLock(projectRoot) {
  const lockPath = path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock');
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const data = JSON.parse(raw);
    const pid = typeof data.pid === 'number' ? data.pid : parseInt(data.pid, 10);
    if (!pid || Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    const str = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

    // Время записи нужно для проверки переиспользованного номера: настоящий
    // раннер стартовал не позже, чем записал lock. Раннер до 1.5.2 полей
    // времени не писал вовсе, и такой lock проверку молча пропускал — то есть
    // сигнал уходил по номеру, про который ничего не известно.
    //
    // Запасной источник — время изменения самого файла: раннер пишет lock
    // один раз, при захвате. Ровно так же поступает и он сам, когда читает
    // чужой lock (`markerStartedAt` в workflow-ai).
    const fileWrittenAt = () => {
      try {
        return fs.statSync(lockPath).mtime.toISOString();
      } catch {
        return null;
      }
    };

    return {
      pid,
      timestamp: str(data.timestamp),
      started_at: str(data.started_at) ?? str(data.timestamp) ?? fileWrittenAt(),
      started_by: str(data.started_by),
      started_by_id: str(data.started_by_id),
      run_id: str(data.run_id)
    };
  } catch {
    return null;
  }
}

/**
 * Принадлежит ли идущий пайплайн нам.
 *
 * Сверяются четыре вещи, каждая закрывает свой способ ошибиться:
 *
 * - lock есть: без него запуска нет вовсе, а значит нет и владения;
 * - `pid`: сигнал уходит тому номеру, который записал раннер, и никакому другому;
 * - `started_by`: запуск из CLI или из расширения не наш;
 * - `started_by_id`: наша рабочая область, а не соседняя, запущенная другим
 *   сервером на той же машине;
 * - время старта процесса: раннер, убитый без снятия lock'а, оставляет номер,
 *   который система переиспользует. Без этой проверки `stop_pipeline` слал бы
 *   `taskkill /F /T` постороннему дереву процессов.
 *
 * @param {{pid: number, started_at: string|null, started_by: string|null, started_by_id: string|null, run_id: string|null}|null} lock
 * @param {number} pid pid, которому собираемся слать сигнал
 * @param {string|string[]} instanceId ожидаемый идентификатор экземпляра либо список
 *   принимаемых (`acceptedInstanceIds`: текущий плюс прежнего формата)
 * @param {Object} [options]
 * @param {boolean} [options.verifyProcessStart] спрашивать у ОС время старта процесса.
 *   Внешний вызов ценой в сотни миллисекунд; ответ помнится, поэтому частые
 *   чтения состояния платят за него один раз.
 * @param {boolean} [options.fresh] спрашивать ОС, минуя память. Обязательно там,
 *   откуда следом уходит сигнал процессу: запись, прогретая чтением состояния,
 *   переживает смерть раннера, и переиспользованный системой номер прошёл бы
 *   проверку. Сверка `pid` и `started_by_id` от этого не защищает — оба поля
 *   лежат в том же протухшем lock'е.
 * @returns {{valid: boolean, reason?: string, override?: boolean}}
 */
export function validateRunOwnership(lock, pid, instanceId, options = {}) {
  // Аварийный ключ: снимает проверку целиком. Остался с тех пор, когда файлов
  // владения было два и разойтись они могли молча.
  if (process.env.WORKFLOW_MCP_FORCE_FOREIGN === '1') {
    return { valid: true, override: true };
  }

  if (!lock) {
    return { valid: false, reason: 'NO_LOCK' };
  }

  if (lock.pid !== pid) {
    return { valid: false, reason: 'PID_MISMATCH' };
  }

  if (lock.started_by !== 'mcp') {
    return { valid: false, reason: 'STARTED_BY_MISMATCH' };
  }

  // Раннер 1.6.x метку не пишет. Отличать этот случай от чужой метки важно:
  // первое чинится обновлением workflow-ai, второе — не чинится вовсе.
  if (!lock.started_by_id) {
    return { valid: false, reason: 'INSTANCE_UNKNOWN' };
  }

  const accepted = Array.isArray(instanceId) ? instanceId : [instanceId];
  if (!accepted.includes(lock.started_by_id)) {
    return { valid: false, reason: 'INSTANCE_MISMATCH' };
  }

  if (options.verifyProcessStart
      && !pidCouldBeFromRun(pid, lock.started_at, { fresh: options.fresh === true })) {
    return { valid: false, reason: 'PID_REUSED' };
  }

  return { valid: true };
}
