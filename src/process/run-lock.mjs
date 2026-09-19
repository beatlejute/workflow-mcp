/**
 * Lock раннера и владение запуском.
 *
 * `.workflow/logs/.pipeline.lock` пишет сам раннер workflow-ai при любом
 * запуске — из CLI, из расширения VS Code или из MCP. Это единственный признак
 * «пайплайн идёт», общий для всех способов старта, и единственное место, где
 * есть pid живого раннера: `.runner-pids` не пишет никто.
 *
 * Владение проверяется здесь же, потому что одного маркера мало. Маркер
 * `.mcp-started-by` говорит «этот запуск сделали мы», но сам по себе не
 * доказывает, что процесс с записанным pid — всё ещё тот самый раннер.
 */

import fs from 'fs';
import path from 'path';
import { validateMarker, readMarker } from './marker.mjs';
import { pidCouldBeFromRun } from './process-start.mjs';

/**
 * Прочитать lock-файл пайплайна.
 *
 * @param {string} projectRoot
 * @returns {{pid: number, timestamp: string|null, started_at: string|null, started_by: string|null, run_id: string|null}|null}
 */
export function readPipelineLock(projectRoot) {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock'), 'utf-8');
    const data = JSON.parse(raw);
    const pid = typeof data.pid === 'number' ? data.pid : parseInt(data.pid, 10);
    if (!pid || Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    const str = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
    return {
      pid,
      timestamp: str(data.timestamp),
      started_at: str(data.started_at) ?? str(data.timestamp),
      started_by: str(data.started_by),
      run_id: str(data.run_id)
    };
  } catch {
    return null;
  }
}

/** Маркер, не роняющий вызывающего на битом JSON. */
export function safeReadMarker(projectRoot) {
  try {
    return readMarker(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Принадлежит ли идущий пайплайн нам.
 *
 * Поверх проверки маркера (pid + `mcp_instance_id`) сверяются три вещи, каждая
 * из которых закрывает свой способ ошибиться:
 *
 * - `started_by` из lock'а: запуск из CLI не наш, даже если рядом лежит наш
 *   маркер от прошлого раза;
 * - `run_id`: маркер и lock должны описывать один и тот же запуск, иначе это
 *   остаток от предыдущего;
 * - время старта процесса: раннер, убитый без снятия lock'а, оставляет номер,
 *   который система переиспользует. Без этой проверки `stop_pipeline` слал бы
 *   `taskkill /F /T` постороннему дереву процессов.
 *
 * @param {string} projectRoot
 * @param {number} pid pid, которому собираемся слать сигнал
 * @param {{pid: number, started_at: string|null, started_by: string|null, run_id: string|null}|null} lock
 * @param {string} instanceId ожидаемый `mcp_instance_id`
 * @param {Object} [options]
 * @param {boolean} [options.verifyProcessStart] спрашивать у ОС время старта процесса.
 *   Это внешний вызов ценой в сотни миллисекунд, поэтому он включается только
 *   там, где собираемся послать сигнал. Для чтения состояния хватает дешёвых
 *   проверок: список пайплайнов запрашивают часто и по всем проектам сразу.
 * @returns {{valid: boolean, reason?: string, override?: boolean}}
 */
export function validateRunOwnership(projectRoot, pid, lock, instanceId, options = {}) {
  const base = validateMarker(projectRoot, pid, instanceId);
  if (!base.valid || base.override) {
    return base;
  }

  // Без lock'а нет ни `run_id`, ни `started_by`, но время запуска есть в самом
  // маркере — его пишет MCP в момент spawn'а. Без этой ветки вся защита
  // сводилась бы к равенству pid всякий раз, когда lock уже снят.
  if (!lock) {
    const markerWithoutLock = safeReadMarker(projectRoot);
    if (options.verifyProcessStart
        && markerWithoutLock
        && !pidCouldBeFromRun(pid, markerWithoutLock.started_at)) {
      return { valid: false, reason: 'PID_REUSED' };
    }
    return base;
  }

  if (lock.started_by && lock.started_by !== 'mcp') {
    return { valid: false, reason: 'STARTED_BY_MISMATCH' };
  }

  const marker = safeReadMarker(projectRoot);
  if (marker && marker.run_id && lock.run_id && marker.run_id !== lock.run_id) {
    return { valid: false, reason: 'RUN_MISMATCH' };
  }

  if (options.verifyProcessStart && !pidCouldBeFromRun(pid, lock.started_at)) {
    return { valid: false, reason: 'PID_REUSED' };
  }

  return base;
}
