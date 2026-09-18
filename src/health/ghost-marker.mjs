/**
 * Матчинг маркера ghost-execution в логах пайплайна.
 *
 * FIX-001: оба детектора (list_ghost_executions и health-детектор) искали маркер
 * простой подстрокой, поэтому срабатывали на любое упоминание слов
 * «ghost-execution» в прозе: тег тикета `tags: [..., ghost-execution]`,
 * commit message «add E2E ghost-execution gate», имя файла
 * `ghost-execution-qa-18.log`, цитата из COACH-тикета в выводе агента.
 * Прецедент 2026-08-04: скан по workflowAi вернул 12 записей, все 12 ложные.
 *
 * Правило теперь двойное:
 *   1. маркер трактуется как СТРУКТУРНЫЙ токен, а не как слово (по умолчанию
 *      `[GHOST-EXECUTION]`); бесструктурный маркер из конфига нормализуется
 *      в скобочную форму;
 *   2. токен должен стоять обособленно — в начале строки или после пробела,
 *      и заканчиваться пробелом, концом строки или `:`/`=`.
 *
 * Прозаическое упоминание обоим условиям не удовлетворяет.
 */

export const DEFAULT_GHOST_MARKER = '[GHOST-EXECUTION]';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Приводит маркер из конфига к структурной форме.
 *
 * Маркер со скобками или `=` считается уже структурным и берётся как есть.
 * Голое слово (`ghost-execution` из старых конфигов) оборачивается в скобки и
 * поднимается в верхний регистр: `[GHOST-EXECUTION]`. Без этого старый конфиг
 * продолжал бы ловить commit message'и — токенного правила для него мало.
 *
 * @param {string} [marker]
 * @returns {string}
 */
export function normalizeGhostMarker(marker) {
  const raw = typeof marker === 'string' ? marker.trim() : '';
  if (!raw) return DEFAULT_GHOST_MARKER;
  if (raw.includes('[') || raw.includes('=')) return raw;
  return `[${raw.toUpperCase()}]`;
}

/**
 * Строит матчер маркера.
 *
 * @param {string} [marker] - значение ghost_execution_log_marker из конфига
 * @returns {{marker: string, pattern: RegExp, test: (line: string) => boolean}}
 */
export function buildGhostMarkerMatcher(marker) {
  const normalized = normalizeGhostMarker(marker);
  // Токен обособлен: начало строки или пробел слева; пробел, конец строки
  // или разделитель `:`/`=` справа.
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalized)}(?:\\s|[:=]|$)`, 'm');

  return {
    marker: normalized,
    pattern,
    test(line) {
      if (typeof line !== 'string' || line.length === 0) return false;
      return pattern.test(line);
    }
  };
}
