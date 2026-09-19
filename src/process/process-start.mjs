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
 * @param {number} [toleranceMs] запас на округление: `ps` отдаёт время с точностью
 *   до секунды. Шире делать незачем: это ровно окно, в котором переиспользованный
 *   pid пройдёт проверку
 * @returns {boolean}
 */
export function pidCouldBeFromRun(pid, lockWrittenAt, toleranceMs = 5000) {
  if (!lockWrittenAt) {
    return true;
  }
  const lockTime = new Date(lockWrittenAt).getTime();
  if (Number.isNaN(lockTime)) {
    return true;
  }
  const startedAt = processStartedAt(pid);
  if (!startedAt) {
    return true;
  }
  return startedAt.getTime() <= lockTime + toleranceMs;
}
