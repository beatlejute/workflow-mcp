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
 * Ключ рабочей области: то, что хешируют идентификатор экземпляра и каталог
 * состояния.
 *
 * На Windows регистр пути ничего не значит для файловой системы, но значил для
 * хеша: клиент передавал cwd то как `d:\Dev`, то как `D:\Dev`, и одна и та же
 * рабочая область получала два разных каталога состояния и два разных
 * идентификатора экземпляра. Живьём рядом лежали оба каталога: история алертов
 * в одном, пустышка — во втором.
 *
 * @param {string} [cwd] - Корень; по умолчанию `mcpCwd()`
 * @returns {string}
 */
export function workspaceKey(cwd = mcpCwd()) {
  const absolute = path.resolve(cwd);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * Идентификатор экземпляра сервера, привязанный к рабочей области.
 * @param {string} [cwd] - Корень; по умолчанию `mcpCwd()`
 * @returns {string}
 */
export function mcpInstanceId(cwd = mcpCwd()) {
  const hash = createHash('sha256').update(workspaceKey(cwd)).digest('hex');
  return `workflow-mcp@${hash.slice(0, 12)}`;
}

/**
 * Идентификатор экземпляра по прежнему правилу — с учётом регистра пути.
 *
 * Пайплайн, запущенный сервером до 2.0.0, помечен таким идентификатором. Без
 * сверки с ним обновление посреди прогона делало прогон чужим:
 * `list_running_pipelines` показывал `foreign: true`, а `stop_pipeline` и
 * `abort_pipeline` отказывали с `FOREIGN_PIPELINE`, пока не позовёшь с `force`.
 *
 * На POSIX совпадает с `mcpInstanceId`: там регистр и раньше не гасился.
 *
 * @param {string} [cwd] - Корень; по умолчанию `mcpCwd()`
 * @returns {string}
 */
export function legacyMcpInstanceId(cwd = mcpCwd()) {
  const hash = createHash('sha256').update(path.resolve(cwd)).digest('hex');
  return `workflow-mcp@${hash.slice(0, 12)}`;
}

/**
 * Идентификаторы, которые считаются нашими для этой рабочей области.
 *
 * Первый — текущий, второй — прежнего формата, если он отличается. Список
 * считается от одного и того же корня: сверять маркер с идентификатором
 * текущего `mcpCwd()`, когда проверяют чужой корень, значит не проверять
 * ничего — на POSIX оба правила дают один хеш, и `validateMarker` принимал бы
 * любой местный маркер независимо от переданного ожидания.
 *
 * @param {string} [cwd] - Корень; по умолчанию `mcpCwd()`
 * @returns {string[]}
 */
export function acceptedInstanceIds(cwd = mcpCwd()) {
  const current = mcpInstanceId(cwd);
  const legacy = legacyMcpInstanceId(cwd);
  return current === legacy ? [current] : [current, legacy];
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
