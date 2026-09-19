/**
 * Позиционная обёртка над зарегистрированным MCP-tool.
 *
 * Сервер зовёт `tool.execute(args)` одним объектом — так его вызывает SDK из
 * `tools/call`. Внутренние функции в `src/tools/git.mjs` при этом позиционные:
 * `git_status(project)`, `git_diff(project, opts)`. Тесты писались под вторую
 * форму, но берут `.execute` — из-за чего `project` приходил как объект и
 * каждый вызов падал в `INVALID_PROJECT`.
 *
 * Обёртка сохраняет читаемость тестов и при этом гоняет их через ровно тот
 * `execute`, который видит клиент.
 *
 * @param {Array<{name: string, execute: Function}>} tools массив tools модуля
 * @param {string} name имя tool'а
 * @returns {(project: string, opts?: Object) => Promise<any>}
 */
export function positionalTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool "${name}" не зарегистрирован в модуле`);
  }
  return (project, opts = {}) => tool.execute({ project, ...opts });
}
