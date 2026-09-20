/**
 * Что считать документом рабочей области: тикетом, планом, отчётом.
 *
 * Каталоги `.workflow/` держат не только документы. `workflow init` кладёт в
 * каждый `.gitkeep.md` — описание папки без frontmatter, чтобы пустой каталог
 * попал в git. Фильтр во всех местах был один: `f.endsWith('.md')`, — поэтому
 * `.gitkeep` выходил из `list_blocked_tickets` как тикет с пустым заголовком и
 * id `.gitkeep`, из `list_plans` — как план со статусом `unknown` (в
 * `documentaions` таких «планов» два), и попадал в счётчики и метрики.
 *
 * Правило простое: точка в начале имени означает служебный файл.
 */

/**
 * @param {string} filename имя файла в каталоге `.workflow/`
 * @returns {boolean}
 */
export function isWorkflowDoc(filename) {
  return typeof filename === 'string'
    && filename.endsWith('.md')
    && !filename.startsWith('.');
}
