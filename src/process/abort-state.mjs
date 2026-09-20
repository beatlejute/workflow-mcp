/**
 * Признак идущего abort'а.
 *
 * `abort_pipeline` останавливает раннер мягко: сигнал, grace-окно до 60 секунд,
 * и только потом жёсткое добивание. Всё это время раннер жив, и снаружи такой
 * пайплайн неотличим от здорового `running` — хотя его уже останавливают.
 *
 * Флаг существовал и до этого, но только внутри `tools/pipeline.mjs` и только
 * ради защиты от параллельного abort'а. Снимок состояния тем временем искал
 * файл `.workflow/logs/.aborting`, которого не пишет никто: состояние
 * `aborting`, обещанное README, не возникало никогда. Теперь у флага один дом
 * и два читателя.
 *
 * В payload'е лежит pid раннера, а не сервера: по нему снимок отличает флаг от
 * текущего запуска от забытого — сервер может умереть посреди grace-окна, и
 * тогда файл переживёт и abort, и сам прогон.
 */

import fs from 'fs';
import path from 'path';

/**
 * Сколько флаг считается действующим.
 *
 * `grace_sec` ограничен 60 секундами, так что десять минут — с большим
 * запасом: дольше живёт только забытый файл.
 */
export const ABORT_STATE_TTL_MS = 10 * 60 * 1000;

/** Путь к файлу флага. */
export function abortStatePath(projectRoot) {
  return path.join(projectRoot, '.workflow', 'state', 'abort-state.json');
}

/**
 * Записать флаг «abort идёт».
 *
 * @param {string} projectRoot
 * @param {Object} info
 * @param {number} info.runnerPid pid останавливаемого раннера
 * @param {string|null} [info.runId] `run_id` из lock'а раннера
 * @param {string} [info.mcpInstanceId] идентификатор экземпляра MCP
 * @returns {boolean} удалось ли записать
 */
export function writeAbortState(projectRoot, { runnerPid, runId = null, mcpInstanceId = null } = {}) {
  const file = abortStatePath(projectRoot);
  const data = {
    started_at: new Date().toISOString(),
    runner_pid: runnerPid,
    run_id: runId,
    pid: process.pid,
    mcp_instance_id: mcpInstanceId
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    // Best-effort: не записали флаг — abort всё равно должен пройти.
    console.error('Failed to write abort state:', err.message);
    return false;
  }
}

/**
 * Прочитать действующий флаг.
 *
 * @param {string} projectRoot
 * @returns {{started_at: string, runner_pid: number|null, run_id: string|null, pid: number|null, mcp_instance_id: string|null}|null}
 *   `null`, если файла нет, он испорчен или протух.
 */
export function readAbortState(projectRoot) {
  const file = abortStatePath(projectRoot);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || typeof data.started_at !== 'string') return null;

    const startedAt = new Date(data.started_at).getTime();
    if (Number.isNaN(startedAt)) return null;
    if (Date.now() - startedAt > ABORT_STATE_TTL_MS) return null;

    const runnerPid = typeof data.runner_pid === 'number' ? data.runner_pid : null;
    return {
      started_at: data.started_at,
      runner_pid: runnerPid,
      run_id: typeof data.run_id === 'string' ? data.run_id : null,
      pid: typeof data.pid === 'number' ? data.pid : null,
      mcp_instance_id: typeof data.mcp_instance_id === 'string' ? data.mcp_instance_id : null
    };
  } catch {
    // Нет файла, битый JSON, нет прав — abort'а не видно.
    return null;
  }
}

/** Идёт ли abort прямо сейчас. */
export function isAbortInProgress(projectRoot) {
  return readAbortState(projectRoot) !== null;
}

/** Снять флаг. Идемпотентно. */
export function clearAbortState(projectRoot) {
  try {
    fs.unlinkSync(abortStatePath(projectRoot));
  } catch {
    // файла нет — нечего снимать
  }
}
