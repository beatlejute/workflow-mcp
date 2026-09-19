/**
 * Единая точка резолва проекта и корня рабочей области.
 *
 * Корень, от которого сервер видит проекты, задаёт `MCP_CWD`: рабочий каталог
 * процесса выбирает клиент, и у stdio-клиентов он произвольный — обычно это
 * каталог самого клиента, а не рабочая область. Половина tools читала
 * `process.cwd()` напрямую, поэтому один и тот же `project` одни tools видели,
 * а другие отвечали «Project not found».
 *
 * Сюда же вынесен идентификатор экземпляра: маркер пайплайна пишется с ним, и
 * по нему же чужой пайплайн отличается от своего. Считался он в четырёх местах
 * от двух разных корней — писатель маркера брал `process.cwd()`, а читатель
 * в `resources/pipeline-state.mjs` — переданный корень. При `MCP_CWD`, не
 * совпадающем с cwd процесса, свой же маркер выглядел чужим.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Корень рабочей области сервера.
 * @returns {string}
 */
export function mcpCwd() {
  return process.env.MCP_CWD || process.cwd();
}

/**
 * Идентификатор экземпляра сервера, привязанный к рабочей области.
 * @param {string} [cwd] - Корень; по умолчанию `mcpCwd()`
 * @returns {string}
 */
export function mcpInstanceId(cwd = mcpCwd()) {
  const hash = createHash('sha256').update(path.resolve(cwd)).digest('hex');
  return `workflow-mcp@${hash.slice(0, 12)}`;
}

/**
 * Абсолютный путь к корню проекта по имени или пути.
 *
 * Резолв чисто путевой: discovery не опрашивается. Имя проекта работает
 * потому, что в multi-project раскладке проект — прямой потомок `cwd`.
 * `git_*` резолвят иначе — через discovery и только по имени.
 *
 * @param {string} project - Путь относительно `cwd` либо абсолютный
 * @param {Object} [options]
 * @param {string} [options.cwd] - Корень резолва; по умолчанию `mcpCwd()`
 * @returns {string} Абсолютный путь
 * @throws {Error & {code: 'INVALID_PROJECT'}} Если по пути нет `.workflow/`
 */
export function resolveProjectRoot(project, { cwd = mcpCwd() } = {}) {
  const resolved = path.resolve(cwd, project);
  if (!fs.existsSync(path.join(resolved, '.workflow'))) {
    const err = new Error(`Project not found or not a workflow project: ${project}`);
    err.code = 'INVALID_PROJECT';
    throw err;
  }
  return resolved;
}

/**
 * То же, но без исключения — для tools, которые отвечают объектом с `error`.
 *
 * @param {string} project
 * @param {Object} [options]
 * @param {string} [options.cwd]
 * @returns {{ok: true, root: string} | {ok: false, message: string}}
 */
export function tryResolveProjectRoot(project, { cwd = mcpCwd() } = {}) {
  try {
    return { ok: true, root: resolveProjectRoot(project, { cwd }) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
