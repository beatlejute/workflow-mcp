import simpleGit from 'simple-git';
import { exec } from 'child_process';
import { promisify } from 'util';
import { machineStateDir } from '../paths/state-dir.mjs';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Error codes for git operations
 * @enum {string}
 */
export const GitErrorCodes = {
  NOT_A_REPO: 'NOT_A_REPO',
  DIRTY_TREE: 'DIRTY_TREE',
  BRANCH_EXISTS: 'BRANCH_EXISTS',
  NOTHING_TO_COMMIT: 'NOTHING_TO_COMMIT',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
};

/**
 * @typedef {Object} GitResult
 * @property {true} ok
 * @property {Object} [data]
 *
 * @typedef {Object} GitError
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 * @property {string} [hint]
 *
 * @typedef {GitResult|GitError} GitResponse
 */

const GIT_TIMEOUT = parseInt(process.env.GIT_TIMEOUT || '30000', 10);

/**
 * Detects gh CLI path and caches result
 * @param {string} stateDir - State directory path
 * @returns {Promise<string|null>} Path to gh binary or null if not found
 */
async function detectGhCli(stateDir) {
  const GH_CACHE_FILE = stateDir ? path.join(stateDir, 'gh-path.cache') : null;

  // Каталог создаётся только под запись кеша — ниже. Прежний безусловный
  // `mkdir` оставлял пустой каталог даже там, где `gh` не нашёлся и писать
  // было нечего.

  // Try cache first
  try {
    if (!GH_CACHE_FILE) { throw new Error('no cache'); }
    const cached = await fs.readFile(GH_CACHE_FILE, 'utf-8');
    const { path: cachedPath, mtime } = JSON.parse(cached);
    // Re-validate cache if older than 24h
    if (Date.now() - mtime < 86400000) {
      try {
        await fs.access(cachedPath);
        return cachedPath;
      } catch {
        // Cache stale, fall through to detection
      }
    }
  } catch {
    // No cache or invalid, proceed with detection
  }

  // Detect gh
  const cmd = process.platform === 'win32' ? 'where gh' : 'which gh';
  try {
    const { stdout } = await execAsync(cmd);
    const detectedPath = stdout.trim().split('\n')[0].trim();
    if (detectedPath) {
      if (GH_CACHE_FILE) {
        try {
          await fs.mkdir(stateDir, { recursive: true });
          await fs.writeFile(GH_CACHE_FILE, JSON.stringify({ path: detectedPath, mtime: Date.now() }));
        } catch {
          // Кеш вторичен: путь к `gh` уже найден, в следующий раз найдём снова.
        }
      }
      return detectedPath;
    }
  } catch {
    // gh not found
  }

  return null;
}

/**
 * Maps simple-git error to GitErrorCodes
 * @param {Error} err
 * @param {string} method
 * @returns {{code: string, hint?: string}}
 */
export function mapGitError(err, method) {
  const msg = String(err.message || err).toLowerCase();

  if (msg.includes('not a git repository') || msg.includes('not a git')) {
    return { code: GitErrorCodes.NOT_A_REPO, hint: 'Initialize a git repository with `git init`' };
  }
  if (msg.includes('working tree clean') === false && (msg.includes('not up to date') || msg.includes('local changes'))) {
    // Careful: dirty tree detection
  }
  if (msg.includes('already exists') || msg.includes('branch already exists')) {
    return { code: GitErrorCodes.BRANCH_EXISTS, hint: 'Choose a different branch name or delete the existing branch' };
  }
  if (msg.includes('nothing to commit') || msg.includes('no changes added')) {
    return { code: GitErrorCodes.NOTHING_TO_COMMIT, hint: 'Stage changes with `git add` before committing' };
  }
  if (msg.includes('merge conflict') || msg.includes('unmerged') || msg.includes('you have unmerged paths')) {
    return { code: GitErrorCodes.MERGE_CONFLICT, hint: 'Resolve conflicts and commit the resolution' };
  }
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return { code: GitErrorCodes.TIMEOUT, hint: 'Increase GIT_TIMEOUT environment variable' };
  }

  // DIRTY_TREE detection for operations that need clean tree
  if (['checkout', 'switch', 'pull', 'merge'].some(op => method.includes(op))) {
    if (msg.includes('overwritten') || msg.includes('would be overwritten')) {
      return { code: GitErrorCodes.DIRTY_TREE, hint: 'Commit or stash local changes before this operation' };
    }
  }

  return { code: GitErrorCodes.UNKNOWN, hint: 'See error message for details' };
}

/**
 * Parses git status output into structured object
 * @param {import('simple-git').StatusResult} status
 * @returns {Object}
 */
function parseStatus(status) {
  const hasUpstream = !!status.tracking;
  return {
    branch: status.current || null,
    detached: status.detached || false,
    tracking: status.tracking || null,
    ahead: hasUpstream ? (status.ahead ?? 0) : null,
    behind: hasUpstream ? (status.behind ?? 0) : null,
    modified: status.modified || [],
    staged: status.staged || [],
    untracked: status.not_added || [],
    conflicted: status.conflicted || [],
    deleted: status.deleted || [],
    created: status.created || []
  };
}

/**
 * Creates a git client for the given project path
 * @param {string} projectPath
 * @returns {Object} Git client instance
 */
export function createGitClient(projectPath) {
  // Кеш пути к `gh` — состояние машины, а не проекта и не рабочей области:
  // путь к бинарнику один на всю систему. Раньше кеш лежал в каталоге рабочей
  // области, и каждая новая область заводила свою копию — на машине их
  // набралось 465 с одинаковым содержимым. `WORKFLOW_STATE_DIR` по-прежнему
  // перекрывает всё состояние сервера, включая этот кеш.
  const stateResult = machineStateDir();
  const stateWritable = stateResult.mode === 'writable' && !!stateResult.dir;
  // Каталог заводит `detectGhCli`, когда ему действительно нужен кеш пути к
  // `gh`. Создавать его здесь значило оставлять пустой каталог на каждый
  // вызов любого git-tool'а — даже `git_status`, которому кеш не нужен.
  const stateDir = stateResult.dir;

  const git = simpleGit(projectPath, { timeout: GIT_TIMEOUT });

  const client = {
    /**
     * Checks if the path is a valid git repository
     * @returns {Promise<GitResponse<{isRepo: boolean}>>}
     */
    async isRepo() {
      try {
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
          return { ok: false, code: GitErrorCodes.NOT_A_REPO, message: `Not a git repository: ${projectPath}`, hint: 'Initialize a git repository with `git init`' };
        }
        return { ok: true, data: { isRepo } };
      } catch (err) {
        const { code, hint } = mapGitError(err, 'isRepo');
        return { ok: false, code, message: err.message, hint };
      }
    },

    /**
     * Gets repository status
     * @returns {Promise<GitResponse<{branch: string|null, ahead: number, behind: number, modified: string[], staged: string[], untracked: string[], conflicted: string[]}>>}
     */
    async status() {
      try {
        const status = await git.status();
        return { ok: true, data: parseStatus(status) };
      } catch (err) {
        const { code, hint } = mapGitError(err, 'status');
        return { ok: false, code, message: err.message, hint };
      }
    },

    /**
     * Creates a new branch
     * @param {string} name - Branch name
     * @param {string} [from] - Starting point (commit/ref), defaults to HEAD
     * @param {boolean} [switchTo=false] - Whether to switch to the new branch
     * @returns {Promise<GitResponse<{created: boolean, name: string, from_sha: string, switched: boolean}>>}
     */
    async createBranch(name, from, switchTo = false) {
      try {
        const fromRef = from || 'HEAD';
        const options = switchTo ? ['-b', name, fromRef] : [name, fromRef];

        if (switchTo) {
          await git.checkoutBranch(name, fromRef);
        } else {
          await git.branch([name, fromRef]);
        }

        const rev = await git.revparse([fromRef]);

        return { ok: true, data: { created: true, name, from_sha: rev.trim(), switched: switchTo } };
      } catch (err) {
        const { code, hint } = mapGitError(err, 'createBranch');
        return { ok: false, code, message: err.message, hint };
      }
    },

    /**
     * Gets diff output
     * @param {boolean} [staged=false] - Whether to show staged diff
     * @param {string} [path] - Optional path filter
     * @param {number} [maxLines=500] - Maximum lines to return
     * @returns {Promise<GitResponse<{diff: string, files: string[], truncated: boolean, lines_total: number}>>}
     */
    async diff(staged = false, path, maxLines = 500) {
      try {
        const args = [];
        if (staged) args.push('--cached');
        if (path) args.push(path);

        const diff = await git.diff(args);
        const lines = diff.split('\n');
        const truncated = lines.length > maxLines;
        const diffText = truncated ? lines.slice(0, maxLines).join('\n') : diff;

        // Parse affected files
        const files = [];
        const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
        let match;
        while ((match = fileRegex.exec(diff)) !== null) {
          files.push(match[1]);
        }

        return { ok: true, data: { diff: diffText, files: [...new Set(files)], truncated, lines_total: lines.length } };
      } catch (err) {
        const { code, hint } = mapGitError(err, 'diff');
        return { ok: false, code, message: err.message, hint };
      }
    },

    /**
     * Commits changes
     * @param {string} message - Commit message
     * @param {string|string[]} [paths] - Optional paths to commit
     * @returns {Promise<GitResponse<{sha: string, short_sha: string, message: string, files: string[]}>>}
     */
    async commit(message, paths) {
      try {
        let filesToCommit = undefined;
        if (paths) {
          filesToCommit = Array.isArray(paths) ? paths : [paths];
          await git.add(filesToCommit);
        }

        const result = await git.commit(message, filesToCommit);

        if (!result.commit) {
          return { ok: false, code: GitErrorCodes.NOTHING_TO_COMMIT, message: 'Nothing to commit', hint: 'Stage changes before committing' };
        }

        const sha = result.commit;
        return { ok: true, data: { sha, short_sha: sha.slice(0, 7), message, files: filesToCommit || [] } };
      } catch (err) {
        const { code, hint } = mapGitError(err, 'commit');
        const effectiveCode = code === GitErrorCodes.UNKNOWN && err.message.includes('nothing to commit') ? GitErrorCodes.NOTHING_TO_COMMIT : code;
        return { ok: false, code: effectiveCode, message: err.message, hint };
      }
    },

    /**
     * Gets detected gh CLI path
     * @returns {Promise<{found: boolean, path: string|null}>}
     */
    async getGhPath() {
      // В read-only режиме детектить `gh` можно, а создавать каталог и писать
      // кеш — нет: режим ровно про это.
      const detectedPath = await detectGhCli(stateWritable ? stateDir : null);
      return { found: detectedPath !== null, path: detectedPath };
    },

    /**
     * Gets raw simple-git instance (advanced usage)
     * @returns {import('simple-git').SimpleGit}
     */
    raw() {
      return git;
    }
  };

  // Validate repo on creation
  const wrappedClient = {};
  for (const [key, fn] of Object.entries(client)) {
    wrappedClient[key] = async (...args) => {
      // Only validate on repo-sensitive operations
      if (['isRepo', 'status', 'createBranch', 'diff', 'commit'].includes(key)) {
        try {
          const exists = await fs.access(`${projectPath}/.git`).then(() => true).catch(() => false);
          if (!exists && key !== 'isRepo') {
            return { ok: false, code: GitErrorCodes.NOT_A_REPO, message: `Not a git repository: ${projectPath}`, hint: 'Initialize a git repository with `git init`' };
          }
        } catch {}
      }
      return fn(...args);
    };
  }

  return wrappedClient;
}

export default { createGitClient, GitErrorCodes };
