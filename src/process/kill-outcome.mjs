/**
 * Исход насильственной остановки прогона.
 *
 * Снимок состояния видит проект, только пока жив `.pipeline.lock`. Раннер
 * workflow-ai снимает lock при любом упорядоченном выходе — своём, по SIGINT и
 * по SIGTERM, — поэтому завершившийся прогон из списка просто исчезает. Lock
 * переживает процесс ровно в одном случае: раннера убили так, что он ничего не
 * успел (`SIGKILL`, `taskkill /F`, падение машины).
 *
 * Отличить «мы его убили» от «непонятно, что с ним случилось» по логу нельзя:
 * строки с кодом выхода раннер не пишет вовсе. Зато это знает тот, кто убивал,
 * — `stop_pipeline` и escalation в `abort_pipeline`. Они и записывают исход
 * рядом с lock'ом; снимок читает его, пока lock жив, и показывает `killed`
 * вместо безликого `stale`.
 *
 * Запись привязана к pid и `run_id` прогона: файл от прошлой остановки не
 * должен приписывать `killed` следующему запуску.
 */

import fs from 'fs';
import path from 'path';

/** Путь к файлу исхода. */
export function killOutcomePath(projectRoot) {
  return path.join(projectRoot, '.workflow', 'state', 'last-kill.json');
}

/**
 * Записать, что прогон убили.
 *
 * @param {string} projectRoot
 * @param {Object} info
 * @param {number} info.pid pid убитого раннера
 * @param {string|null} [info.runId] `run_id` из lock'а
 * @param {string} info.by что именно убивало: `stop_pipeline` или `abort_pipeline`
 * @returns {boolean} удалось ли записать
 */
export function writeKillOutcome(projectRoot, { pid, runId = null, by } = {}) {
  const file = killOutcomePath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      killed_at: new Date().toISOString(),
      pid,
      run_id: runId,
      by
    }, null, 2), 'utf-8');
    return true;
  } catch (err) {
    // Не записали — прогон всё равно убит, просто в снимке он будет `stale`.
    console.error('Failed to write kill outcome:', err.message);
    return false;
  }
}

/**
 * Прочитать исход.
 *
 * @param {string} projectRoot
 * @returns {{killed_at: string, pid: number|null, run_id: string|null, by: string|null}|null}
 */
export function readKillOutcome(projectRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(killOutcomePath(projectRoot), 'utf-8'));
    if (!data || typeof data.killed_at !== 'string') return null;
    if (Number.isNaN(new Date(data.killed_at).getTime())) return null;
    return {
      killed_at: data.killed_at,
      pid: typeof data.pid === 'number' ? data.pid : null,
      run_id: typeof data.run_id === 'string' ? data.run_id : null,
      by: typeof data.by === 'string' ? data.by : null
    };
  } catch {
    return null;
  }
}

/** Убили ли именно тот прогон, который описан в lock'е. */
export function killedThisRun(projectRoot, lock) {
  if (!lock) return false;
  const outcome = readKillOutcome(projectRoot);
  if (!outcome) return false;
  if (outcome.pid !== lock.pid) return false;
  // `run_id` сверяется, только когда он есть в обоих местах: lock без `run_id`
  // пишут старые версии раннера.
  if (outcome.run_id && lock.run_id && outcome.run_id !== lock.run_id) return false;
  return true;
}

/** Убрать запись. Идемпотентно. */
export function clearKillOutcome(projectRoot) {
  try {
    fs.unlinkSync(killOutcomePath(projectRoot));
  } catch {
    // файла нет — нечего убирать
  }
}
