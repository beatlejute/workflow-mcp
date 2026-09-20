/**
 * Отпечаток алерта — один на всю службу здоровья.
 *
 * Правило жило в двух местах: publisher дедуплицировал по хешу, а тик держал
 * память о прошлом обходе по «сырому» `alert.fingerprint` с собственным
 * запасным вариантом. Все восемь детекторов отпечаток ставят, поэтому
 * расхождение было спящим: первый детектор без `fingerprint` развёл бы дедуп
 * и память тика по разным ключам.
 */

import crypto from 'crypto';

/**
 * @param {Object} alert
 * @returns {string} двенадцать hex-символов
 */
export function fingerprintOf(alert) {
  const own = typeof alert.fingerprint === 'string' && alert.fingerprint.length > 0
    ? alert.fingerprint
    : null;
  const str = own ?? `${alert.type}${alert.project}${alert.stage}${alert.step_number}`;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}
