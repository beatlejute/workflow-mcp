import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { positionalTool } from '../helpers/tool-call.mjs';

function createTestProject(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });

  execSync('git init', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: projectPath, stdio: 'pipe' });

  return projectPath;
}

function makeInitialCommit(projectPath) {
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'initial content');
  execSync('git add README.md', { cwd: projectPath, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: projectPath, stdio: 'pipe' });
}

const MOCK_GH_PATH = '__MOCK_GH__';
let mockSpawnResult = null;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: function (cmd, args, options) {
      if (cmd === MOCK_GH_PATH && mockSpawnResult) {
        const result = mockSpawnResult;
        return {
          stdout: {
            on: (event, handler) => { if (event === 'data') handler(Buffer.from(result.stdout || '')); }
          },
          stderr: {
            on: (event, handler) => { if (event === 'data') handler(Buffer.from(result.stderr || '')); }
          },
          on: (event, handler) => { if (event === 'close') handler(result.exitCode); },
          kill: () => {},
          pid: 12345
        };
      }
      return actual.spawn(cmd, args, options);
    }
  };
});

function createMockClient(overrides = {}) {
  const defaultStatus = {
    branch: 'feature/test',
    detached: false,
    tracking: 'origin/feature/test',
    ahead: 1,
    behind: 0,
    modified: [],
    staged: [],
    untracked: [],
    conflicted: [],
    deleted: [],
    created: []
  };

  return {
    isRepo: async () => ({ ok: true, data: { isRepo: true } }),
    status: async () => ({ ok: true, data: { ...defaultStatus, ...(overrides.statusData || {}) } }),
    getGhPath: overrides.getGhPath || (async () => ({ found: true, path: MOCK_GH_PATH })),
    raw: () => { throw new Error('not used'); }
  };
}

vi.mock('../../src/git/client.mjs', () => {
  let currentOverrides = {};

  return {
    createGitClient: () => createMockClient(currentOverrides),
    GitErrorCodes: {
      NOT_A_REPO: 'NOT_A_REPO',
      DIRTY_TREE: 'DIRTY_TREE',
      BRANCH_EXISTS: 'BRANCH_EXISTS',
      NOTHING_TO_COMMIT: 'NOTHING_TO_COMMIT',
      MERGE_CONFLICT: 'MERGE_CONFLICT',
      TIMEOUT: 'TIMEOUT',
      UNKNOWN: 'UNKNOWN'
    },
    mapGitError: (err) => ({ code: 'UNKNOWN', hint: 'Test hint' }),
    __setOverrides: (o) => { currentOverrides = o; },
    __resetOverrides: () => { currentOverrides = {}; }
  };
});

describe('git_open_pr tool', () => {
  let testDir;
  let projectPath;
  let git_open_pr_tool;
  let setOverrides;
  let resetOverrides;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'git-open-pr-test-'));
    projectPath = createTestProject(testDir);
    process.chdir(testDir);
    makeInitialCommit(projectPath);

    mockSpawnResult = null;

    vi.resetModules();

    const clientModule = await import('../../src/git/client.mjs');
    setOverrides = clientModule.__setOverrides;
    resetOverrides = clientModule.__resetOverrides;
    resetOverrides();

    const gitModule = await import('../../src/tools/git.mjs');
    git_open_pr_tool = positionalTool(gitModule.default, 'git_open_pr');
  });

  afterEach(() => {
    mockSpawnResult = null;
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('GH_CLI_UNAVAILABLE — gh CLI not found', () => {
    it('returns GH_CLI_UNAVAILABLE when gh CLI is not available', async () => {
      setOverrides({ getGhPath: async () => ({ found: false, path: null }) });

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('GH_CLI_UNAVAILABLE');
      expect(result.message).toContain('gh CLI not found');
      expect(result.hint).toBeDefined();
    });
  });

  describe('GH exit=0 — URL parsed correctly', () => {
    it('parses PR URL from gh stdout when exit code is 0', async () => {
      mockSpawnResult = {
        exitCode: 0,
        stdout: 'https://github.com/owner/repo/pull/42\n',
        stderr: ''
      };

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR',
        body: 'PR description'
      });

      expect(result.ok).toBe(true);
      expect(result.data.pr_url).toBe('https://github.com/owner/repo/pull/42');
      expect(result.data.pr_number).toBe(42);
      expect(result.data.head).toBe('feature/test');
      expect(result.data.base).toBe('main');
      expect(result.data.draft).toBe(false);
    });

    it('parses PR URL from stderr when stdout is empty', async () => {
      mockSpawnResult = {
        exitCode: 0,
        stdout: '',
        stderr: 'https://github.com/owner/repo/pull/99\n'
      };

      const result = await git_open_pr_tool('test-project', {
        title: 'Another PR'
      });

      expect(result.ok).toBe(true);
      expect(result.data.pr_url).toBe('https://github.com/owner/repo/pull/99');
      expect(result.data.pr_number).toBe(99);
    });
  });

  describe('GH_CLI_FAILED — gh exit≠0 with stderr', () => {
    it('returns GH_CLI_FAILED with stderr when gh exits non-zero', async () => {
      mockSpawnResult = {
        exitCode: 1,
        stdout: '',
        stderr: 'error: no upstream branch'
      };

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR',
        body: 'PR description'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('GH_CLI_FAILED');
      expect(result.message).toContain('gh pr create failed');
      expect(result.details.stderr).toContain('no upstream branch');
      expect(result.details.exitCode).toBe(1);
    });

    it('returns GH_CLI_FAILED with error details when stderr is empty', async () => {
      mockSpawnResult = {
        exitCode: 128,
        stdout: 'some output',
        stderr: ''
      };

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('GH_CLI_FAILED');
      expect(result.details.exitCode).toBe(128);
    });
  });

  describe('DIRTY_TREE — uncommitted changes', () => {
    it('returns DIRTY_TREE when working tree has modified files', async () => {
      setOverrides({ statusData: { modified: ['README.md'] } });

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('DIRTY_TREE');
      expect(result.message).toContain('uncommitted changes');
    });

    it('returns DIRTY_TREE when working tree has staged files', async () => {
      setOverrides({ statusData: { staged: ['newfile.txt'] } });

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('DIRTY_TREE');
    });

    it('returns DIRTY_TREE when working tree has untracked files', async () => {
      setOverrides({ statusData: { untracked: ['untracked.txt'] } });

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('DIRTY_TREE');
    });
  });

  describe('BRANCH_NOT_PUSHED — no upstream tracking', () => {
    it('returns BRANCH_NOT_PUSHED when branch has no upstream tracking', async () => {
      setOverrides({ statusData: { tracking: null, ahead: null, behind: null } });

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('BRANCH_NOT_PUSHED');
      expect(result.message).toContain('no upstream tracking branch');
      expect(result.hint).toBeDefined();
    });
  });

  describe('BODY_TOO_LONG — body exceeds 50000 chars', () => {
    it('returns BODY_TOO_LONG when body exceeds 50000 characters', async () => {
      const longBody = 'x'.repeat(50001);

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR',
        body: longBody
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('BODY_TOO_LONG');
      expect(result.message).toContain('50000');
      expect(result.message).toContain('50001');
      expect(result.hint).toBeDefined();
    });

    it('accepts body with exactly 50000 characters', async () => {
      const body50000 = 'x'.repeat(50000);

      mockSpawnResult = {
        exitCode: 0,
        stdout: 'https://github.com/owner/repo/pull/55\n',
        stderr: ''
      };

      const result = await git_open_pr_tool('test-project', {
        title: 'Test PR',
        body: body50000
      });

      expect(result.code).not.toBe('BODY_TOO_LONG');
    });
  });

  describe('Invalid project', () => {
    it('returns INVALID_PROJECT for non-existent project', async () => {
      const result = await git_open_pr_tool('non-existent-project', {
        title: 'Test PR'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT');
      expect(result.message).toContain('not found in discovery');
    });
  });
});
