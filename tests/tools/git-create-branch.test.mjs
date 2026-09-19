import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import git_status from '../../src/tools/git.mjs';
import { positionalTool } from '../helpers/tool-call.mjs';

// Extract the git_create_branch and git_status functions from the exported tools array
const git_create_branch_tool = positionalTool(git_status, 'git_create_branch');
const git_status_tool = positionalTool(git_status, 'git_status');

// Helper to create a test project with .workflow structure
function createTestProject(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  // Create .workflow structure to make it discoverable
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });

  // Initialize as git repo
  execSync('git init', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: projectPath, stdio: 'pipe' });

  return projectPath;
}

// Helper to get current HEAD branch
function getCurrentBranch(projectPath) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8'
    }).trim();
  } catch (err) {
    return null;
  }
}

// Helper to check if branch exists
function branchExists(projectPath, branchName) {
  try {
    const branches = execSync('git branch --list', {
      cwd: projectPath,
      encoding: 'utf-8'
    });
    return branches.includes(branchName);
  } catch (err) {
    return false;
  }
}

describe('git_create_branch tool', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'git-create-branch-tool-'));
    projectPath = createTestProject(testDir);
    process.chdir(testDir);

    // Create initial commit so we have a base to branch from
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'initial content');
    execSync('git add README.md', { cwd: projectPath, stdio: 'pipe' });
    execSync('git commit -m "initial commit"', { cwd: projectPath, stdio: 'pipe' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  describe('Basic branch creation', () => {
    it('creates a new branch with switch=true and changes HEAD', async () => {
      const initialBranch = getCurrentBranch(projectPath);
      expect(initialBranch).toBe('master');

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/new-feature',
        switch: true
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(result.data.name).toBe('feature/new-feature');
      expect(result.data.switched).toBe(true);

      // Verify HEAD changed
      const newBranch = getCurrentBranch(projectPath);
      expect(newBranch).toBe('feature/new-feature');

      // Verify branch exists
      expect(branchExists(projectPath, 'feature/new-feature')).toBe(true);
    });

    it('creates a new branch with switch=false and does not change HEAD', async () => {
      const initialBranch = getCurrentBranch(projectPath);
      expect(initialBranch).toBe('master');

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/another-branch',
        switch: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(result.data.name).toBe('feature/another-branch');
      expect(result.data.switched).toBe(false);

      // Verify HEAD did not change
      const currentBranch = getCurrentBranch(projectPath);
      expect(currentBranch).toBe('master');

      // Verify branch still exists
      expect(branchExists(projectPath, 'feature/another-branch')).toBe(true);
    });
  });

  describe('Branch already exists', () => {
    it('returns BRANCH_EXISTS error when attempting to create duplicate branch', async () => {
      // Create first branch
      const firstResult = await git_create_branch_tool('test-project', {
        name: 'feature/test',
        switch: false
      });
      expect(firstResult.ok).toBe(true);

      // Try to create same branch again
      const secondResult = await git_create_branch_tool('test-project', {
        name: 'feature/test',
        switch: false
      });

      expect(secondResult.ok).toBe(false);
      expect(secondResult.code).toBe('BRANCH_EXISTS');
      expect(secondResult.message).toContain('already exists');
      expect(secondResult.hint).toBeDefined();
    });
  });

  describe('Dirty working tree protection', () => {
    it('returns DIRTY_TREE error when trying to switch with uncommitted changes', async () => {
      // Modify a file
      fs.writeFileSync(path.join(projectPath, 'README.md'), 'modified content');

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/test-dirty',
        switch: true
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('DIRTY_TREE');
      expect(result.message).toContain('Cannot switch to new branch with uncommitted changes');
      expect(result.hint).toBeDefined();

      // Verify branch was not created
      expect(branchExists(projectPath, 'feature/test-dirty')).toBe(false);
    });

    it('allows branch creation with switch=false when tree is dirty', async () => {
      // Modify a file
      fs.writeFileSync(path.join(projectPath, 'README.md'), 'modified content');

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/test-dirty-no-switch',
        switch: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(result.data.switched).toBe(false);

      // Verify branch was created
      expect(branchExists(projectPath, 'feature/test-dirty-no-switch')).toBe(true);

      // Verify HEAD didn't change
      expect(getCurrentBranch(projectPath)).toBe('master');
    });

    it('returns DIRTY_TREE when trying to switch with staged changes', async () => {
      // Create and stage a new file
      fs.writeFileSync(path.join(projectPath, 'newfile.txt'), 'new content');
      execSync('git add newfile.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/test-staged',
        switch: true
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('DIRTY_TREE');
    });
  });

  describe('Branch from specific commit', () => {
    it('creates branch from a specific commit', async () => {
      // Get the current commit SHA
      const currentSha = execSync('git rev-parse HEAD', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      // Make a new commit
      fs.writeFileSync(path.join(projectPath, 'newfile.txt'), 'content');
      execSync('git add newfile.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "second commit"', { cwd: projectPath, stdio: 'pipe' });

      // Create branch from the first commit
      const result = await git_create_branch_tool('test-project', {
        name: 'feature/from-first-commit',
        from: currentSha.substring(0, 7), // Use short SHA
        switch: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(result.data.name).toBe('feature/from-first-commit');

      // Verify branch points to the correct commit
      const branchSha = execSync(`git rev-list -n 1 feature/from-first-commit`, {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      expect(branchSha.startsWith(currentSha.substring(0, 7))).toBe(true);
    });

    it('creates branch from a branch name', async () => {
      // Create and checkout to master
      const currentBranch = getCurrentBranch(projectPath);
      expect(currentBranch).toBe('master');

      // Create another branch
      const tempBranchResult = await git_create_branch_tool('test-project', {
        name: 'temp-branch',
        switch: false
      });
      expect(tempBranchResult.ok).toBe(true);

      // Create branch from temp-branch
      const result = await git_create_branch_tool('test-project', {
        name: 'feature/from-branch',
        from: 'temp-branch',
        switch: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);

      // Both branches should point to same commit
      const masterSha = execSync('git rev-list -n 1 master', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
      const featureSha = execSync('git rev-list -n 1 feature/from-branch', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      expect(masterSha).toBe(featureSha);
    });
  });

  describe('Invalid branch names', () => {
    it('rejects branch name with invalid characters', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: 'feature@invalid',
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_BRANCH_NAME');
      expect(result.message).toContain('Invalid branch name');
      expect(result.hint).toBeDefined();
    });

    it('rejects empty branch name', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: '',
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_BRANCH_NAME');
    });

    it('rejects branch name exceeding 200 characters', async () => {
      const longName = 'feature/' + 'a'.repeat(200);
      const result = await git_create_branch_tool('test-project', {
        name: longName,
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_BRANCH_NAME');
    });

    it('rejects branch name with spaces', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: 'invalid name with spaces',
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_BRANCH_NAME');
    });

    it('allows valid special characters in branch name', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: 'feature/sub-folder_name.test',
        switch: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);
      expect(branchExists(projectPath, 'feature/sub-folder_name.test')).toBe(true);
    });
  });

  describe('Invalid from reference', () => {
    it('rejects non-existent commit reference', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: 'feature/from-invalid',
        from: 'nonexistent-commit-sha',
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_FROM_REF');
      expect(result.message).toContain('Invalid \'from\' reference');
    });
  });

  describe('Default parameters', () => {
    it('uses HEAD as default from parameter', async () => {
      const result = await git_create_branch_tool('test-project', {
        name: 'feature/default-from'
        // from defaults to 'HEAD'
      });

      expect(result.ok).toBe(true);
      expect(result.data.created).toBe(true);

      // Verify it was created at HEAD
      const masterSha = execSync('git rev-list -n 1 master', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
      const featureSha = execSync('git rev-list -n 1 feature/default-from', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      expect(masterSha).toBe(featureSha);
    });

    it('uses switch=true as default', async () => {
      const initialBranch = getCurrentBranch(projectPath);

      const result = await git_create_branch_tool('test-project', {
        name: 'feature/default-switch'
        // switch defaults to true
      });

      expect(result.ok).toBe(true);
      expect(result.data.switched).toBe(true);

      // Verify HEAD changed
      const newBranch = getCurrentBranch(projectPath);
      expect(newBranch).toBe('feature/default-switch');
      expect(newBranch).not.toBe(initialBranch);
    });
  });

  describe('Invalid project', () => {
    it('returns error for non-existent project', async () => {
      const result = await git_create_branch_tool('non-existent-project', {
        name: 'feature/test',
        switch: false
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT');
      expect(result.message).toContain('not found in discovery');
    });
  });
});
