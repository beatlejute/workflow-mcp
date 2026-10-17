/**
 * Момент старта процесса по его pid.
 *
 * Нужен, чтобы отличить наш раннер от постороннего процесса, которому система
 * выдала тот же pid. Проверки «pid жив» для этого недостаточно: раннер,
 * убитый без снятия lock'а (`kill -9`, `taskkill /F`, перезагрузка), оставляет
 * файл с номером, который ОС потом переиспользует — на Windows охотно. Дальше
 * `stop_pipeline` отправляет `taskkill /F /T` уже чужому дереву процессов.
 *
 * Раннер пишет lock после своего старта, поэтому у настоящего раннера
 * время старта не позже времени записи lock'а. У процесса, занявшего
 * освободившийся pid, оно заведомо позже.
 *
 * Данные приходится брать у ОС: Node не отдаёт время старта чужого процесса.
 */

import { execFileSync } from 'child_process';

/**
 * Память об уже опрошенных pid'ах.
 *
 * Опрос стоит сотни миллисекунд (`powershell -Command Get-Process`), а ответ
 * для живого процесса неизменен: момент старта не меняется, пока процесс жив.
 * Без памяти `list_running_pipelines` и чтение `workflow://pipeline-state`
 * платили бы за один и тот же pid на каждый вызов, а зовут их часто.
 *
 * Память годится только для чтения состояния. Перед сигналом она запрещена:
 * прогретая чтением запись переживает смерть процесса, и если система за это
 * время отдала номер другому, `stop_pipeline` получил бы «тот самый раннер» и
 * послал `taskkill /F /T` постороннему дереву. Сверка `pid` и `started_by_id`
 * тут не спасает — оба поля лежат в том же протухшем lock'е. Поэтому
 * сигнальные пути зовут с `fresh: true` и всегда спрашивают ОС заново.
 *
 * Неудачный опрос (`null`) помнится отдельно и заметно меньше: он означает
 * «процесса нет или не спросить» и при управлении процессом ведёт к отказу.
 *
 * @type {Map<number, {at: number, value: Date|null}>}
 */
const startCache = new Map();
const START_CACHE_TTL_MS = 60_000;
const UNKNOWN_CACHE_TTL_MS = 5_000;
let processStartReader = processStartedAt;

/** Подменить опрос ОС в детерминированных тестах. */
export function setProcessStartReaderForTests(reader) {
  processStartReader = reader ?? processStartedAt;
  startCache.clear();
}

/** Забыть опрошенное. Нужно тестам: иначе pid из прошлого теста считается известным. */
export function clearProcessStartCache() {
  startCache.clear();
}

/**
 * Годится ли запись памяти к использованию.
 *
 * Вынесено отдельно, потому что у двух видов ответа разный срок: известное
 * время старта живёт минуту, отказ опроса — пять секунд. Проверить это на
 * живых процессах нельзя (мёртвый pid так и останется мёртвым), поэтому
 * правило проверяется здесь напрямую.
 *
 * @param {{at: number, value: Date|null}|undefined} entry
 * @param {number} now
 * @returns {boolean}
 */
export function cacheEntryUsable(entry, now = Date.now()) {
  if (!entry) return false;
  const ttl = entry.value === null ? UNKNOWN_CACHE_TTL_MS : START_CACHE_TTL_MS;
  return now - entry.at < ttl;
}

/**
 * Момент старта с памятью.
 *
 * @param {number} pid
 * @param {Object} [options]
 * @param {boolean} [options.fresh] спросить ОС, не заглядывая в память.
 *   Обязательно там, где по ответу отправляется сигнал процессу.
 * @returns {Date|null}
 */
export function processStartedAtCached(pid, { fresh = false } = {}) {
  const hit = startCache.get(pid);
  if (!fresh && cacheEntryUsable(hit)) {
    return hit.value;
  }
  let value = null;
  try {
    value = processStartReader(pid);
  } catch {
    // Неудачный опрос не подтверждает личность процесса.
  }
  startCache.set(pid, { at: Date.now(), value });
  return value;
}

/**
 * @param {number} pid
 * @returns {Date|null} момент старта или null, если узнать не удалось
 */
export function processStartedAt(pid) {
  if (!pid || pid <= 0) {
    return null;
  }

  const started = Date.now();
  const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
  try {
    const out = process.platform === 'win32'
      ? execFileSync(
        command,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      // POSIX: `ps -o lstart=` отдаёт локальное время в формате вроде
      // «Mon Sep 19 18:04:11 2026».
      : execFileSync(command, ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    const parsed = new Date(out);
    if (!out || Number.isNaN(parsed.getTime())) {
      reportProcessStartQuery({ pid, durationMs: Date.now() - started, reason: 'unparseable' });
      return null;
    }
    return parsed;
  } catch (error) {
    reportProcessStartQuery({
      pid,
      durationMs: Date.now() - started,
      code: error?.code,
      errno: error?.errno,
      status: error?.status,
      signal: error?.signal,
    });
    // Ошибка опроса не позволяет подтвердить личность процесса.
    return null;
  }
}

function diagnosticValue(value) {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function reportProcessStartQuery({ pid, durationMs, reason, code, errno, status, signal }) {
  try {
    process.stderr.write(`${JSON.stringify({
      event: 'process_start_query_failed',
      pid: diagnosticValue(pid),
      durationMs: diagnosticValue(durationMs),
      reason,
      code: diagnosticValue(code),
      errno: diagnosticValue(errno),
      status: diagnosticValue(status),
      signal: diagnosticValue(signal),
    })}\n`);
  } catch {
    // Недоступный поток диагностики не превращает неизвестную личность в совпадение.
  }
}

/**
 * Проверяет личность процесса по времени старта. Неизвестность отделена от
 * совпадения, чтобы пути управления могли отказать без отправки сигнала.
 * Read-only снимки могут использовать `pidCouldBeFromRun`, где неизвестность
 * отображается как возможное совпадение.
 *
 * @param {number} pid
 * @param {string|null} lockWrittenAt ISO-время записи lock'а
 * @param {Object} [options]
 * @param {boolean} [options.fresh] спрашивать ОС, минуя память. Обязательно
 *   перед отправкой сигнала: прогретая чтением запись переживает смерть
 *   процесса, и переиспользованный номер прошёл бы проверку
 * @param {number} [options.toleranceMs] запас на округление: `ps` отдаёт время с
 *   точностью до секунды. Шире делать незачем: это ровно окно, в котором
 *   переиспользованный pid пройдёт проверку
 * @returns {{status: 'MATCH'|'PID_REUSED'|'IDENTITY_UNKNOWN'}}
 */
export function checkProcessIdentity(pid, lockWrittenAt, { fresh = false, toleranceMs = 5000 } = {}) {
  if (!lockWrittenAt || Number.isNaN(new Date(lockWrittenAt).getTime())) {
    return { status: 'IDENTITY_UNKNOWN' };
  }
  const startedAt = processStartedAtCached(pid, { fresh });
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    return { status: 'IDENTITY_UNKNOWN' };
  }
  return startedAt.getTime() <= new Date(lockWrittenAt).getTime() + toleranceMs
    ? { status: 'MATCH' }
    : { status: 'PID_REUSED' };
}

/** Read-only compatibility helper: unknown identity may be displayed as possible. */
export function pidCouldBeFromRun(pid, lockWrittenAt, options = {}) {
  return checkProcessIdentity(pid, lockWrittenAt, options).status !== 'PID_REUSED';
}
