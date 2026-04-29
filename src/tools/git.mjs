#!/usr/bin/env node

import { createGitClient, GitErrorCodes, mapGitError } from '../git/client.mjs';
import { discoverProjects } from '../discovery.mjs';
import { spawn } from 'child_process';
import { z } from 'zod';

/**
 * Detects conflicted files by checking git status with porcelain format
 * Looks for XX/UU/AA/DD markers indicating unmerged entries
 * @param {import('simple-git').SimpleGit} git - Simple-git instance
 * @returns {Promise<string[]>} Array of conflicted file paths
 */
async function detectConflicted(git) {
  try {
    // Get status with porcelain format to detect conflicts
    // UU = both modified, AA = both added, DD = both deleted, etc.
    const statusLines = await git.raw(['status', '--porcelain']);
    const conflicted = [];

    for (const line of statusLines.split('\n')) {
      if (line.length < 3) continue;

      // First two chars are the status codes
      const status = line.substring(0, 2);

      // Check for unmerged status indicators
      // XX and UU are unmerged (one of them is a conflict marker)
      if (status.includes('U') || (status[0] === 'A' && status[1] === 'A') ||
          (status[0] === 'D' && status[1] === 'D')) {
        const filePath = line.substring(3).trim();
        if (filePath) {
          conflicted.push(filePath);
        }
      }
    }

    return conflicted;
  } catch (err) {
    // If porcelain format fails, return empty (status() has conflicted field anyway)
    return [];
  }
}

/**
 * Extracts the first URL from a string using regex
 * @param {string} text - Text to search for URLs
 * @returns {string|null} First URL found or null
 */
function extractUrl(text) {
  const urlRegex = /https?:\/\/[^\s]+/;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

/**
 * Extracts PR number from URL
 * @param {string} url - PR URL
 * @returns {number|null} PR number or null
 */
function extractPrNumber(url) {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * MCP Tool: git_status(project) → {branch, ahead, behind, modified[], staged[], untracked[], conflicted[]}
 *
 * @param {string} project - Project name (must be registered via discovery)
 * @returns {Promise<Object>} Status object with git state or error
 */
async function git_status(project) {
  // Validate project through discovery
  const cwd = process.cwd();
  const discoveredProjects = discoverProjects(cwd);
  const projectInfo = discoveredProjects.find(p => p.name === project);

  if (!projectInfo) {
    return {
      ok: false,
      code: 'INVALID_PROJECT',
      message: `Project "${project}" not found in discovery`,
      hint: `Available projects: ${discoveredProjects.map(p => p.name).join(', ') || 'none'}`
    };
  }

  // Create git client for the project
  const client = createGitClient(projectInfo.path);

  // Check if it's a git repository
  const isRepoResult = await client.isRepo();
  if (!isRepoResult.ok) {
    return {
      ok: false,
      code: isRepoResult.code,
      message: isRepoResult.message,
      hint: isRepoResult.hint
    };
  }

  // Get repository status
  const statusResult = await client.status();
  if (!statusResult.ok) {
    return {
      ok: false,
      code: statusResult.code,
      message: statusResult.message,
      hint: statusResult.hint
    };
  }

  const status = statusResult.data;

  // Detect detached HEAD state using simple-git's detached flag
  const detached = status.detached || false;
  const branch = detached ? null : (status.branch || null);

  // ahead/behind are already null when no upstream (parseStatus checks status.tracking)
  // Also null when detached HEAD has no meaningful tracking
  const ahead = detached ? null : status.ahead;
  const behind = detached ? null : status.behind;

  // Detect conflicted files (enhanced detection with porcelain format)
  let conflicted = status.conflicted || [];
  if (conflicted.length === 0) {
    // Try porcelain-based detection as backup
    try {
      const rawGit = await client.raw();
      const porcelainConflicted = await detectConflicted(rawGit);
      if (porcelainConflicted.length > 0) {
        conflicted = porcelainConflicted;
      }
    } catch {
      // Keep status.conflicted result
    }
  }

  return {
    ok: true,
    data: {
      branch,
      detached,
      ahead,
      behind,
      modified: status.modified || [],
      staged: status.staged || [],
      untracked: status.untracked || [],
      conflicted: conflicted || [],
      // Additional useful fields
      deleted: status.deleted || [],
      created: status.created || []
    }
  };
}

/**
 * MCP Tool: git_create_branch(project, {name, from?='HEAD', switch?=true}) → {created, name, from_sha, switched}
 *
 * Creates a new git branch and optionally switches to it.
 *
 * @param {string} project - Project name (must be registered via discovery)
 * @param {Object} options - Branch creation options
 * @param {string} options.name - Branch name (validated against regex ^[a-zA-Z0-9._/-]{1,200}$)
 * @param {string} [options.from='HEAD'] - Starting point (commit/ref), validated via revparse
 * @param {boolean} [options.switch=true] - Whether to switch to the new branch after creation
 * @returns {Promise<Object>} Result object or error
 */
async function git_create_branch(project, { name, from = 'HEAD', switch: switchTo = true }) {
  // Validate project through discovery
  const cwd = process.cwd();
  const discoveredProjects = discoverProjects(cwd);
  const projectInfo = discoveredProjects.find(p => p.name === project);

  if (!projectInfo) {
    return {
      ok: false,
      code: 'INVALID_PROJECT',
      message: `Project "${project}" not found in discovery`,
      hint: `Available projects: ${discoveredProjects.map(p => p.name).join(', ') || 'none'}`
    };
  }

  // Create git client for the project
  const client = createGitClient(projectInfo.path);

  // Validate branch name
  const branchNameRegex = /^[a-zA-Z0-9._/-]{1,200}$/;
  if (!branchNameRegex.test(name)) {
    return {
      ok: false,
      code: 'INVALID_BRANCH_NAME',
      message: `Invalid branch name "${name}". Must match pattern ^[a-zA-Z0-9._/-]{{1,200}}$`,
      hint: 'Branch names can contain letters, numbers, dots, underscores, dashes, and slashes (1-200 characters)'
    };
  }

  // Validate 'from' reference using revparse
  try {
    const rawGit = await client.raw();
    await rawGit.revparse([from]);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_FROM_REF',
      message: `Invalid 'from' reference "${from}": ${err.message}`,
      hint: 'The from parameter must be a valid commit, branch, tag, or other git reference'
    };
  }

  // Check if branch already exists before attempting creation
  try {
    const rawGit = await client.raw();
    const existingBranches = await rawGit.branch(['--list', name]);
    if (existingBranches.includes(name)) {
      return {
        ok: false,
        code: GitErrorCodes.BRANCH_EXISTS,
        message: `Branch "${name}" already exists`,
        hint: 'Choose a different branch name or delete the existing branch'
      };
    }
  } catch (err) {
    // If branch listing fails, continue and let createBranch handle it
  }

  // Check for dirty working tree if switch is requested
  if (switchTo) {
    try {
      const statusResult = await client.status();
      if (!statusResult.ok) {
        return {
          ok: false,
          code: statusResult.code,
          message: statusResult.message,
          hint: statusResult.hint
        };
      }

      const status = statusResult.data;
      const hasUncommittedChanges = (status.modified?.length > 0) ||
                                    (status.staged?.length > 0) ||
                                    (status.untracked?.length > 0);

      if (hasUncommittedChanges) {
        return {
          ok: false,
          code: GitErrorCodes.DIRTY_TREE,
          message: `Cannot switch to new branch with uncommitted changes`,
          hint: 'Commit or stash your changes before switching branches'
        };
      }
    } catch (err) {
      const { code, hint } = mapGitError(err, 'status');
      return { ok: false, code, message: err.message, hint };
    }
  }

  // Perform branch creation (and optional switch)
  const result = await client.createBranch(name, from, switchTo);

  if (!result.ok) {
    return result;
  }

  return { ok: true, data: result.data };
}

/**
 * MCP Tool: git_diff(project, {staged?=false, path?, max_lines=500})
 * → {diff: string, files: string[], truncated: bool, lines_total: number}
 *
 * Returns a diff snapshot with optional staged/path filters and line-count cap.
 *
 * @param {string} project - Project name (must be registered via discovery)
 * @param {Object} options
 * @param {boolean} [options.staged=false] - Show staged diff (index vs HEAD)
 * @param {string} [options.path] - Optional path filter (relative to repo root)
 * @param {number} [options.max_lines=500] - Max lines to return (hard limit: 5000)
 * @returns {Promise<Object>}
 */
async function git_diff(project, { staged = false, path: filePath, max_lines = 500 } = {}) {
  // Enforce hard limit before any git operation
  if (max_lines > 5000) {
    return {
      ok: false,
      code: 'TOO_MANY_LINES',
      message: `max_lines ${max_lines} exceeds maximum allowed value of 5000`,
      hint: 'Use max_lines ≤ 5000'
    };
  }

  // Validate project through discovery
  const cwd = process.cwd();
  const discoveredProjects = discoverProjects(cwd);
  const projectInfo = discoveredProjects.find(p => p.name === project);

  if (!projectInfo) {
    return {
      ok: false,
      code: 'INVALID_PROJECT',
      message: `Project "${project}" not found in discovery`,
      hint: `Available projects: ${discoveredProjects.map(p => p.name).join(', ') || 'none'}`
    };
  }

  // Validate path: must be relative to repo root, pattern ^[^./].*
  if (filePath !== undefined && filePath !== null && filePath !== '') {
    if (/^[./]/.test(filePath) || filePath.includes('..')) {
      return {
        ok: false,
        code: 'INVALID_PATH',
        message: `Invalid path "${filePath}": must be relative to repository root (pattern ^[^./].*) and cannot contain ..`,
        hint: 'Provide a relative path like "src/index.js"'
      };
    }
  }

  // Create git client for the project
  const client = createGitClient(projectInfo.path);

  // Check if it's a git repository
  const isRepoResult = await client.isRepo();
  if (!isRepoResult.ok) {
    return isRepoResult;
  }

  // Get diff via client
  const diffResult = await client.diff(staged, filePath || undefined, max_lines);

  if (!diffResult.ok) {
    return diffResult;
  }

  const { diff, truncated, lines_total } = diffResult.data;
  let { files } = diffResult.data;

  // Empty diff
  if (!diff) {
    return {
      ok: true,
      data: { diff: '', files: [], truncated: false, lines_total: 0 }
    };
  }

  // Detect binary files and mark them in the files list
  const binaryRegex = /^Binary files a\/(.+) and b\/(.+) differ$/gm;
  const binaryFiles = new Set();
  let binaryMatch;
  while ((binaryMatch = binaryRegex.exec(diff)) !== null) {
    binaryFiles.add(binaryMatch[1]);
  }

  if (binaryFiles.size > 0) {
    files = files.map(f => (binaryFiles.has(f) ? `${f} [binary]` : f));
  }

  return {
    ok: true,
    data: { diff, files, truncated, lines_total }
  };
}

/**
 * MCP Tool: git_commit(project, {message, paths?, co_authors?}) → {sha, message, files: string[], short_sha}
 *
 * Commits only staged changes or explicitly provided paths. NEVER does git add -A.
 * Validates message length (1-5000 chars). When paths are provided, each path is
 * validated via git_status (must be in modified/added). Returns NOTHING_TO_COMMIT
 * when no staged changes and no paths provided. Never uses --no-verify.
 * Supports optional co_authors[] for Co-Authored-By trailers.
 */
async function git_commit(project, { message, paths, co_authors }) {
  // Validate project through discovery
  const cwd = process.cwd();
  const discoveredProjects = discoverProjects(cwd);
  const projectInfo = discoveredProjects.find(p => p.name === project);

  if (!projectInfo) {
    return {
      ok: false,
      code: 'INVALID_PROJECT',
      message: `Project "${project}" not found in discovery`,
      hint: `Available projects: ${discoveredProjects.map(p => p.name).join(', ') || 'none'}`
    };
  }

  // Create git client for the project
  const client = createGitClient(projectInfo.path);

  // Check if it's a git repository
  const isRepoResult = await client.isRepo();
  if (!isRepoResult.ok) {
    return {
      ok: false,
      code: isRepoResult.code,
      message: isRepoResult.message,
      hint: isRepoResult.hint
    };
  }

  // Validate message length: 1-5000 characters
  if (typeof message !== 'string' || message.length < 1 || message.length > 5000) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: `Commit message must be between 1 and 5000 characters (got ${message?.length || 0})`,
      hint: 'Provide a non-empty commit message up to 5000 characters'
    };
  }

  // Get current status to check staged files and validate paths
  const statusResult = await client.status();
  if (!statusResult.ok) {
    return {
      ok: false,
      code: statusResult.code,
      message: statusResult.message,
      hint: statusResult.hint
    };
  }
  const status = statusResult.data;

  // Determine what to commit
  let filesToCommit = undefined;
  const hasStaged = (status.staged?.length || 0) > 0;

  if (paths && paths.length > 0) {
    // Validate each path via git_status
    const validStatuses = ['modified', 'added', 'staged'];
    const invalidPaths = [];
    const normalizedPaths = [];

    for (const p of paths) {
      if (typeof p !== 'string') {
        invalidPaths.push({ path: p, reason: 'not a string' });
        continue;
      }
      // Check all status arrays for this path
      let found = false;
      for (const statusKey of validStatuses) {
        const files = status[statusKey] || [];
        if (files.includes(p)) {
          found = true;
          break;
        }
      }
      if (found) {
        normalizedPaths.push(p);
      } else {
        invalidPaths.push({ path: p, reason: 'not in modified/added/staged status' });
      }
    }

    if (invalidPaths.length > 0) {
      return {
        ok: false,
        code: 'INVALID_PATHS',
        message: `Some paths are not in a commit-ready state: ${invalidPaths.map(ip => `${ip.path} (${ip.reason})`).join(', ')}`,
        hint: 'Only files that are modified, added, or already staged can be committed. Stage changes first.'
      };
    }

    filesToCommit = normalizedPaths;
  }

  // No staged changes and no paths provided → nothing to commit
  if (!hasStaged && (!paths || paths.length === 0)) {
    return {
      ok: false,
      code: GitErrorCodes.NOTHING_TO_COMMIT,
      message: 'Nothing to commit: no staged changes and no paths provided',
      hint: 'Stage changes with `git add` before committing, or provide explicit paths to commit'
    };
  }

  // Build commit with optional Co-Authored-By trailers
  let commitMessage = message;
  if (co_authors && Array.isArray(co_authors) && co_authors.length > 0) {
    const trailers = co_authors
      .map(a => {
        if (typeof a === 'string') {
          return `Co-Authored-By: ${a}`;
        }
        if (a && typeof a === 'object' && a.name && a.email) {
          return `Co-Authored-By: ${a.name} <${a.email}>`;
        }
        return null;
      })
      .filter(Boolean);
    if (trailers.length > 0) {
      commitMessage = `${message.trim()}\n\n${trailers.join('\n')}`;
    }
  }

  // Perform the commit WITHOUT --no-verify
  // Use git client's commit method WITHOUT auto-staging when paths are provided
  try {
    const rawGit = await client.raw();

    if (filesToCommit) {
      // Add the specific files first (this is explicit staging, not -A)
      await rawGit.add(filesToCommit);
    }

    const result = await rawGit.commit(commitMessage);

    if (!result.commit) {
      return {
        ok: false,
        code: GitErrorCodes.NOTHING_TO_COMMIT,
        message: 'Nothing to commit',
        hint: 'No changes were staged for commit'
      };
    }

    // Get the list of files in the commit
    const sha = result.commit;
    let committedFiles = [];
    try {
      const showResult = await rawGit.show([sha, '--name-only', '--pretty=format:']);
      committedFiles = showResult.split('\n').filter(f => f.trim()).filter(f => f !== sha);
    } catch (e) {
      // Fallback: if we committed specific paths, use those; otherwise try to get from status
      if (filesToCommit) {
        committedFiles = filesToCommit;
      } else {
        // Use staged files before commit as best guess
        committedFiles = status.staged || [];
      }
    }

    return {
      ok: true,
      data: {
        sha,
        short_sha: sha.slice(0, 7),
        message,
        files: committedFiles
      }
    };
  } catch (err) {
    const { code, hint } = mapGitError(err, 'commit');
    const effectiveCode = code === GitErrorCodes.UNKNOWN && err.message?.includes('nothing to commit') ? GitErrorCodes.NOTHING_TO_COMMIT : code;
    return { ok: false, code: effectiveCode, message: err.message, hint };
  }
}

/**
 * MCP Tool: git_open_pr(project, {title, body?, base?='main', head?, draft?=false}) → {pr_url, pr_number, head, base, draft}
 *
 * Wrapper over `gh pr create`. Uses gh CLI path detected and cached by createGitClient.
 * Validates: gh available, clean working tree, branch pushed (has upstream tracking).
 * Body limited to 50000 chars.
 *
 * @param {string} project - Project name (must be registered via discovery)
 * @param {Object} options
 * @param {string} options.title - PR title (required)
 * @param {string} [options.body] - PR body (optional, max 50000 chars)
 * @param {string} [options.base='main'] - Target base branch
 * @param {string} [options.head] - Source branch (defaults to current branch)
 * @param {boolean} [options.draft=false] - Create as draft PR
 * @returns {Promise<Object>} Result object or error
 */
async function git_open_pr(project, { title, body, base = 'main', head, draft = false }) {
  // Validate project through discovery
  const cwd = process.cwd();
  const discoveredProjects = discoverProjects(cwd);
  const projectInfo = discoveredProjects.find(p => p.name === project);

  if (!projectInfo) {
    return {
      ok: false,
      code: 'INVALID_PROJECT',
      message: `Project "${project}" not found in discovery`,
      hint: `Available projects: ${discoveredProjects.map(p => p.name).join(', ') || 'none'}`
    };
  }

  // Create git client for the project
  const client = createGitClient(projectInfo.path);

  // Check if it's a git repository
  const isRepoResult = await client.isRepo();
  if (!isRepoResult.ok) {
    return {
      ok: false,
      code: isRepoResult.code,
      message: isRepoResult.message,
      hint: isRepoResult.hint
    };
  }

  // Check gh CLI availability
  const ghResult = await client.getGhPath();
  if (!ghResult.found || !ghResult.path) {
    return {
      ok: false,
      code: 'GH_CLI_UNAVAILABLE',
      message: 'gh CLI not found',
      hint: 'Install GitHub CLI from https://cli.github.com/ and ensure it is in your PATH'
    };
  }

  // Check for dirty working tree (unstaged or staged changes)
  const statusResult = await client.status();
  if (!statusResult.ok) {
    return {
      ok: false,
      code: statusResult.code,
      message: statusResult.message,
      hint: statusResult.hint
    };
  }

  const status = statusResult.data;
  const hasUncommittedChanges = (status.modified?.length > 0) ||
                                (status.staged?.length > 0) ||
                                (status.untracked?.length > 0);

  if (hasUncommittedChanges) {
    return {
      ok: false,
      code: 'DIRTY_TREE',
      message: 'Working tree has uncommitted changes',
      hint: 'Commit or stash your changes before creating a PR (use git_commit tool)'
    };
  }

  // Check if branch is pushed (has upstream tracking branch)
  if (!status.tracking) {
    return {
      ok: false,
      code: 'BRANCH_NOT_PUSHED',
      message: `Branch "${status.branch}" has no upstream tracking branch`,
      hint: 'Push your branch to remote with `git push -u origin <branch>` before creating a PR'
    };
  }

  // Validate body length
  if (body && body.length > 50000) {
    return {
      ok: false,
      code: 'BODY_TOO_LONG',
      message: `PR body exceeds 50000 character limit (got ${body.length})`,
      hint: 'Shorten the PR body to 50000 characters or fewer'
    };
  }

  // Determine head branch (current branch if not specified)
  const headBranch = head || status.branch;
  if (!headBranch) {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Could not determine current branch',
      hint: 'Specify the head branch explicitly'
    };
  }

  // Build gh pr create command arguments
  const args = ['pr', 'create', '--web'];
  args.push('--title', title);
  if (body) {
    args.push('--body', body);
  }
  args.push('--base', base);
  args.push('--head', headBranch);
  if (draft) {
    args.push('--draft');
  }

  // Spawn gh process
  return new Promise((resolve) => {
    const ghProcess = spawn(ghResult.path, args, {
      cwd: projectInfo.path,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ghProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ghProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ghProcess.on('close', (code) => {
      if (code === 0) {
        const prUrl = extractUrl(stdout) || extractUrl(stderr);
        const prNumber = prUrl ? extractPrNumber(prUrl) : null;
        resolve({
          ok: true,
          data: {
            pr_url: prUrl,
            pr_number: prNumber,
            head: headBranch,
            base,
            draft
          }
        });
      } else {
        resolve({
          ok: false,
          code: 'GH_CLI_FAILED',
          message: `gh pr create failed with exit code ${code}`,
          hint: `gh error: ${stderr || 'See gh CLI output for details'}`,  
          details: { exitCode: code, stderr, stdout }
        });
      }
    });

    ghProcess.on('error', (err) => {
      resolve({
        ok: false,
        code: 'GH_CLI_FAILED',
        message: `Failed to spawn gh process: ${err.message}`,
        hint: 'Ensure gh CLI is properly installed and executable'
      });
    });
  });
}

/**
 * Export MCP Tools
 */
export default [
  {
    name: 'git_open_pr',
    description: 'Open a GitHub pull request via gh CLI. Validates project, gh availability, clean tree, and pushed branch. Returns {pr_url, pr_number, head, base, draft}.',
    inputSchema: z.object({
      project: z.string().describe('Project name (must be registered in discovery)'),
      title: z.string().describe('PR title (required)'),
      body: z.string().optional().describe('PR body (optional, max 50000 chars)'),
      base: z.string().optional().describe('Target base branch (default: main)'),
      head: z.string().optional().describe('Source branch (defaults to current branch)'),
      draft: z.boolean().optional().describe('Create as draft PR')
    }),
    async execute(args) {
      const { project, ...rest } = args;
      return git_open_pr(project, rest);
    }
  },
  {
    name: 'git_status',
    description: 'Get structured Git repository status: branch, ahead/behind, modified/staged/untracked/conflicted files. Validates project through discovery.',
    inputSchema: z.object({
      project: z.string().describe('Project name (must be registered in discovery)')
    }),
    async execute(args) {
      return git_status(args.project);
    }
  },
  {
    name: 'git_create_branch',
    description: 'Create a new git branch with optional checkout. Validates branch name, checks for existing branch, protects uncommitted changes when switching. Returns {created, name, from_sha, switched}.',
    inputSchema: z.object({
      project: z.string().describe('Project name (must be registered in discovery)'),
      name: z.string().describe('Branch name (1-200 chars, alphanumeric with . _ / -)'),
      from: z.string().optional().describe('Starting point (commit/ref), defaults to HEAD'),
      switch: z.boolean().optional().describe('Whether to switch to the new branch after creation')
    }),
    async execute(args) {
      const { project, ...rest } = args;
      return git_create_branch(project, rest);
    }
  },
  {
    name: 'git_diff',
    description: 'Get a diff snapshot of the repository. Supports staged/unstaged, optional path filter, and line-count cap. Binary files are marked [binary]. Returns {diff, files, truncated, lines_total}.',
    inputSchema: z.object({
      project: z.string().describe('Project name (must be registered in discovery)'),
      staged: z.boolean().optional().describe('Show staged diff (index vs HEAD). Defaults to false'),
      path: z.string().optional().describe('Optional path filter relative to repository root'),
      max_lines: z.number().optional().describe('Maximum number of diff lines to return (default 500, hard limit 5000)')
    }),
    async execute(args) {
      const { project, ...rest } = args;
      return git_diff(project, rest);
    }
  },
  {
    name: 'git_commit',
    description: 'Commit staged changes or explicit paths. NEVER does git add -A. Requires message (1-5000 chars). Returns {sha, message, files, short_sha}.',
    inputSchema: z.object({
      project: z.string().describe('Project name (must be registered in discovery)'),
      message: z.string().describe('Commit message (1-5000 characters)'),
      paths: z.array(z.string()).optional().describe('Optional specific paths to commit'),
      co_authors: z.array(z.union([
        z.string(),
        z.object({ name: z.string(), email: z.string() })
      ])).optional().describe('Optional Co-Authored-By trailers')
    }),
    async execute(args) {
      const { project, ...rest } = args;
      return git_commit(project, rest);
    }
  }
];
