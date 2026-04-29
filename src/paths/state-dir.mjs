import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Compute SHA-256 hash of the absolute path, first 12 characters.
 * @param {string} cwd
 * @returns {string}
 */
function computeHash(cwd) {
  const absolute = path.resolve(cwd);
  const hash = crypto.createHash('sha256').update(absolute).digest('hex');
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
 * Ensure state directory exists (mkdir -p) if not read-only.
 * @param {{ dir: string|null, mode: 'writable'|'read-only' }} result
 */
export function ensureStateDir(result) {
  if (result.mode === 'read-only' || !result.dir) {
    return;
  }
  fs.mkdirSync(result.dir, { recursive: true });
}
