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
 * «процесса нет или не спросить» и ведёт к fail-open, так что застревать в
 * этом ответе на минуту опаснее, чем переспросить.
 *
 * @type {Map<number, {at: number, value: Date|null}>}
 */
const startCache = new Map();
const START_CACHE_TTL_MS = 60_000;
const UNKNOWN_CACHE_TTL_MS = 5_000;

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
  const value = processStartedAt(pid);
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

  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      const parsed = new Date(out);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    // POSIX: `ps -o lstart=` отдаёт локальное время в формате вроде
    // «Mon Sep 19 18:04:11 2026».
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!out) {
      return null;
    }
    const parsed = new Date(out);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    // Процесса нет, прав не хватает, утилита недоступна — проверку пропускаем.
    return null;
  }
}

/**
 * Мог ли процесс с этим pid быть тем самым раннером, что записал lock.
 *
 * Возвращает `true`, если узнать время старта не удалось: запрет управления
 * своим же пайплайном из-за недоступной системной утилиты хуже, чем
 * остающийся риск переиспользования pid. Про это сказано в README, в блоке
 * «Владение процессом».
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
 * @returns {boolean}
 */
export function pidCouldBeFromRun(pid, lockWrittenAt, { fresh = false, toleranceMs = 5000 } = {}) {
  if (!lockWrittenAt) {
    return true;
  }
  const lockTime = new Date(lockWrittenAt).getTime();
  if (Number.isNaN(lockTime)) {
    return true;
  }
  const startedAt = processStartedAtCached(pid, { fresh });
  if (!startedAt) {
    return true;
  }
  return startedAt.getTime() <= lockTime + toleranceMs;
}
