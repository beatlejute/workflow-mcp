import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readConfig } from '../discovery.mjs';
import { workspaceKey } from '../lib/project-root.mjs';

/**
 * Compute SHA-256 hash of the absolute path, first 12 characters.
 * @param {string} cwd
 * @returns {string}
 */
function computeHash(cwd) {
  // Ключ считает `workspaceKey`: на Windows он гасит регистр пути. Тот же
  // ключ берёт идентификатор экземпляра — иначе `d:\Dev` и `D:\Dev` дают две
  // разные рабочие области там, где файловая система видит одну.
  const hash = crypto.createHash('sha256').update(workspaceKey(cwd)).digest('hex');
  return hash.slice(0, 12);
}

/**
 * Check if a path is a protected location (or a parent of one).
 * Protected: $HOME, /, C:\, C:\Users, C:\Users\<name>
 * @param {string} dir
 * @returns {boolean}
 */
function isProtectedLocation(dir) {
  const absolute = path.resolve(dir);
  const normalized = path.normalize(absolute);

  const home = os.homedir();
  const homeNormalized = path.normalize(home);

  // Check $HOME (and any subdirectory that is exactly home)
  if (normalized === homeNormalized) return true;

  // Check Unix root
  if (normalized === '/') return true;

  if (process.platform === 'win32') {
    // Check C:\
    if (/^[a-z]:\\$/i.test(normalized)) return true;
    // Check C:\Users
    if (/^[a-z]:\\Users$/i.test(normalized)) return true;
    // Check C:\Users\<name>
    if (/^[a-z]:\\Users\\[^\\]+$/i.test(normalized)) return true;
  }

  return false;
}

/**
 * Resolve the state directory for workflow-mcp based on cwd and config.
 * @param {string} cwd - Current working directory
 * @param {Object} [config={}] - Configuration object
 * @param {Object} [config.state] - State configuration
 * @param {string} [config.state.dir] - Override state directory (absolute or relative to cwd)
 * @returns {{ dir: string|null, mode: 'writable'|'read-only' }}
 */
export function resolveStateDir(cwd, config = {}) {
  const cfg = config || {};
  const stateCfg = cfg.state || {};

  // If state.dir is explicitly set, use it
  if (stateCfg.dir !== undefined && stateCfg.dir !== null && stateCfg.dir !== '') {
    let dir = stateCfg.dir;
    // Resolve relative to cwd if not absolute
    if (!path.isAbsolute(dir)) {
      dir = path.resolve(cwd, dir);
    }
    return { dir, mode: 'writable' };
  }

  // Check guard: protected location
  if (isProtectedLocation(cwd)) {
    process.stderr.write(
      `[workflow-mcp] cwd is a protected location; state persistence disabled. Set state.dir in .workflow-mcp.yaml to enable.\n`
    );
    return { dir: null, mode: 'read-only' };
  }

  // XDG default
  let baseDir;
  if (process.platform === 'win32') {
    baseDir = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  } else {
    baseDir = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  }

  const hash = computeHash(cwd);
  const dir = path.join(baseDir, 'workflow-mcp', hash);

  return { dir, mode: 'writable' };
}

/**
 * Каталог состояния сервера — в том же порядке, в каком его ищет `server.mjs`:
 * сначала `WORKFLOW_STATE_DIR`, потом `state.dir` из конфига, потом XDG.
 *
 * Без общей функции git-клиент повторял только вторую половину: при заданном
 * `WORKFLOW_STATE_DIR` состояние сервера шло в переменную, а кеш пути к `gh` — в XDG.
 *
 * @param {string} cwd - Корень рабочей области
 * @returns {{ dir: string|null, mode: 'writable'|'read-only' }}
 */
export function serverStateDir(cwd) {
  if (process.env.WORKFLOW_STATE_DIR) {
    return {
      dir: process.env.WORKFLOW_STATE_DIR,
      mode: process.env.WORKFLOW_STATE_MODE || 'writable'
    };
  }
  return resolveStateDir(cwd, readConfig(cwd));
}

/**
 * Каталог состояния, общего для машины, — без привязки к рабочей области.
 *
 * Туда кладётся то, что от рабочей области не зависит: путь к `gh` один на
 * машину. Прежде кеш лежал в каталоге рабочей области, и каждая новая область
 * заводила свой — на машине их набралось 465 штук с одинаковым содержимым.
 *
 * `WORKFLOW_STATE_DIR` перекрывает и этот каталог: переменная задаёт всё
 * состояние сервера целиком.
 *
 * @returns {{ dir: string|null, mode: 'writable'|'read-only' }}
 */
export function machineStateDir(cwd = process.env.MCP_CWD || process.cwd()) {
  if (process.env.WORKFLOW_STATE_DIR) {
    return {
      dir: process.env.WORKFLOW_STATE_DIR,
      mode: process.env.WORKFLOW_STATE_MODE || 'writable'
    };
  }

  // `state.dir` из `.workflow-mcp.yaml` уводит всё состояние сервера, включая
  // машинный кеш: пользователь, задавший каталог явно, не ждёт записи в
  // `%LOCALAPPDATA%`. Прежний кеш `gh` шёл через `serverStateDir` и настройку
  // уважал — после переезда на уровень машины она перестала действовать.
  const configured = readConfig(cwd)?.state?.dir;
  if (configured) {
    return {
      dir: path.isAbsolute(configured) ? configured : path.resolve(cwd, configured),
      mode: 'writable'
    };
  }

  let baseDir;
  if (process.platform === 'win32') {
    baseDir = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  } else {
    baseDir = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  }

  return { dir: path.join(baseDir, 'workflow-mcp'), mode: 'writable' };
}

/**
 * Ensure state directory exists (mkdir -p) if not read-only.
 * @param {{ dir: string|null, mode: 'writable'|'read-only' }} result
 */
export function ensureStateDir(result) {
  if (result.mode === 'read-only' || !result.dir) {
    return;
  }
  fs.mkdirSync(result.dir, { recursive: true });
}
