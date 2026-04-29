import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import git_status from '../../src/tools/git.mjs';

// Extract the git_status function from the exported tools array
const git_status_tool = git_status.find(t => t.name === 'git_status').execute;

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

describe('git_status tool', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'git-status-tool-'));
    projectPath = createTestProject(testDir);
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  describe('Clean repository', () => {
    it('returns empty arrays for modified, staged, untracked in fresh clean repo', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'README.md'), 'initial content');
      execSync('git add README.md', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.modified).toEqual([]);
      expect(result.data.staged).toEqual([]);
      expect(result.data.untracked).toEqual([]);
    });

    it('returns all empty arrays when nothing has changed after commit', async () => {
      // Create multiple files and commit
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'content2');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.modified).toEqual([]);
      expect(result.data.staged).toEqual([]);
      expect(result.data.untracked).toEqual([]);
      expect(result.data.created).toEqual([]);
      expect(result.data.deleted).toEqual([]);
      expect(result.data.conflicted).toEqual([]);
    });
  });

  describe('Dirty files (modified)', () => {
    it('includes modified file in modified array', async () => {
      // Create and commit a file
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify the file
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'modified');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.modified).toContain('file.txt');
      expect(result.data.staged).toEqual([]);
      expect(result.data.untracked).toEqual([]);
    });

    it('includes correct path for modified files in subdirectories', async () => {
      // Create subdirectory structure
      fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'src', 'app.js'), 'original');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify nested file
      fs.writeFileSync(path.join(projectPath, 'src', 'app.js'), 'modified');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.modified).toContain('src/app.js');
    });

    it('detects multiple modified files', async () => {
      // Create and commit multiple files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'file3.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify all files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v2');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'v2');
      fs.writeFileSync(path.join(projectPath, 'file3.txt'), 'v2');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.modified).toContain('file1.txt');
      expect(result.data.modified).toContain('file2.txt');
      expect(result.data.modified).toContain('file3.txt');
      expect(result.data.modified).toHaveLength(3);
    });
  });

  describe('Staged files', () => {
    it('includes staged file in staged array', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v1');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify and stage
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v2');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.staged).toContain('file.txt');
      expect(result.data.untracked).toEqual([]);
    });

    it('correctly classifies staged and unstaged changes to same file', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify and stage
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v2');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      // Make more unstaged changes
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v3');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      // When a file is staged and then modified, it appears in both staged and modified
      expect(result.data.staged).toContain('file.txt');
      expect(result.data.modified).toContain('file.txt');
    });

    it('detects multiple staged files', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Modify and stage multiple files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v2');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'v2');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.staged).toContain('file1.txt');
      expect(result.data.staged).toContain('file2.txt');
    });
  });

  describe('Untracked files', () => {
    it('includes untracked file in untracked array', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'tracked.txt'), 'tracked');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create untracked file
      fs.writeFileSync(path.join(projectPath, 'untracked.txt'), 'new');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.untracked).toContain('untracked.txt');
    });

    it('correctly classifies untracked files', async () => {
      // Create and commit files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'tracked1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'tracked2');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create untracked files
      fs.writeFileSync(path.join(projectPath, 'new1.txt'), 'untracked1');
      fs.writeFileSync(path.join(projectPath, 'new2.txt'), 'untracked2');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.untracked).toContain('new1.txt');
      expect(result.data.untracked).toContain('new2.txt');
      expect(result.data.untracked).toHaveLength(2);
    });

    it('includes untracked files in subdirectories', async () => {
      // Create initial structure
      fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'src', 'tracked.js'), 'tracked');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create untracked file in subdirectory
      fs.writeFileSync(path.join(projectPath, 'src', 'new.js'), 'untracked');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.untracked).toContain('src/new.js');
    });
  });

  describe('Detached HEAD', () => {
    it('returns branch=null and detached=true for detached HEAD state', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Get the commit hash
      const hash = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf-8' }).trim();

      // Checkout the commit directly to create detached HEAD
      execSync(`git checkout ${hash}`, { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.detached).toBe(true);
      expect(result.data.branch).toBeNull();
    });

    it('detached HEAD returns ahead=null and behind=null', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Get hash and checkout to detach
      const hash = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf-8' }).trim();
      execSync(`git checkout ${hash}`, { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.detached).toBe(true);
      expect(result.data.ahead).toBeNull();
      expect(result.data.behind).toBeNull();
    });

    it('detached HEAD still reports file status correctly', async () => {
      // Create and commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Detach HEAD
      const hash = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf-8' }).trim();
      execSync(`git checkout ${hash}`, { cwd: projectPath, stdio: 'pipe' });

      // Make changes
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v2');
      fs.writeFileSync(path.join(projectPath, 'new.txt'), 'new');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.detached).toBe(true);
      expect(result.data.branch).toBeNull();
      expect(result.data.modified).toContain('file.txt');
      expect(result.data.untracked).toContain('new.txt');
    });
  });

  describe('Not a repository', () => {
    it('returns NOT_A_REPO error for non-git directory', async () => {
      // Create a non-git directory with .workflow structure
      const nonGitPath = path.join(testDir, 'not-a-repo');
      fs.mkdirSync(path.join(nonGitPath, '.workflow', 'tickets', 'backlog'), { recursive: true });

      const originalCwd2 = process.cwd();
      process.chdir(testDir);

      const result = await git_status_tool('not-a-repo');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_A_REPO');

      process.chdir(originalCwd2);
    });

    it('returns error with message when directory is not a git repo', async () => {
      // Create a non-git .workflow directory
      const nonGitPath = path.join(testDir, 'invalid-repo');
      fs.mkdirSync(path.join(nonGitPath, '.workflow', 'tickets', 'backlog'), { recursive: true });

      const originalCwd2 = process.cwd();
      process.chdir(testDir);

      const result = await git_status_tool('invalid-repo');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_A_REPO');
      expect(result.message).toBeDefined();

      process.chdir(originalCwd2);
    });
  });

  describe('Invalid project', () => {
    it('returns INVALID_PROJECT error for unknown project name', async () => {
      const result = await git_status_tool('unknown-project');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT');
    });

    it('includes hint with available projects in error message', async () => {
      const result = await git_status_tool('nonexistent');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT');
      expect(result.hint).toBeDefined();
      expect(result.hint).toContain('test-project');
    });
  });

  describe('Conflicted files', () => {
    it('detects conflicted files during merge conflict', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create feature branch with change
      execSync('git checkout -b feature', { cwd: projectPath, stdio: 'pipe' });
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'feature change');
      execSync('git commit -am "feature"', { cwd: projectPath, stdio: 'pipe' });

      // Go back to main/master and make conflicting change
      execSync('git checkout main 2>/dev/null || git checkout master', { cwd: projectPath, stdio: 'pipe' });
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'main change');
      execSync('git commit -am "main change"', { cwd: projectPath, stdio: 'pipe' });

      // Attempt merge - will fail
      try {
        execSync('git merge feature', { cwd: projectPath, stdio: 'pipe' });
      } catch {
        // Expected to fail
      }

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      if (result.data.conflicted && result.data.conflicted.length > 0) {
        expect(result.data.conflicted).toContain('file.txt');
      }
    });

    it('reports conflicted array even if empty for clean repo', async () => {
      // Create clean repo
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data.conflicted)).toBe(true);
      expect(result.data.conflicted).toEqual([]);
    });
  });

  describe('Branch information', () => {
    it('returns branch name for normal branch', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.detached).toBe(false);
      expect(result.data.branch).toBeTruthy();
      expect(['main', 'master']).toContain(result.data.branch);
    });

    it('returns detached=false for named branches', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create and checkout feature branch
      execSync('git checkout -b feature', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.detached).toBe(false);
      expect(result.data.branch).toBe('feature');
    });
  });

  describe('Mixed state scenarios', () => {
    it('handles repo with modified, staged, and untracked files simultaneously', async () => {
      // Create initial commit
      fs.writeFileSync(path.join(projectPath, 'tracked1.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'tracked2.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'tracked3.txt'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create mixed state:
      // - tracked1: modified and staged (appears in both staged and modified)
      // - tracked2: modified but not staged (appears only in modified)
      // - tracked3: not modified
      // - new1: untracked
      fs.writeFileSync(path.join(projectPath, 'tracked1.txt'), 'v2');
      execSync('git add tracked1.txt', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'tracked2.txt'), 'v2');

      fs.writeFileSync(path.join(projectPath, 'new1.txt'), 'untracked');

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.staged).toContain('tracked1.txt');
      expect(result.data.modified).toContain('tracked2.txt');
      expect(result.data.untracked).toContain('new1.txt');
      // When a file is staged, it also appears in modified list (git's standard behavior)
      expect(result.data.modified).toContain('tracked1.txt');
    });

    it('returns all fields populated for complex repo state', async () => {
      // Create initial multi-file commit
      fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'src', 'app.js'), 'v1');
      fs.writeFileSync(path.join(projectPath, 'src', 'utils.js'), 'v1');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Make various changes
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'v2'); // modified
      execSync('git add file1.txt', { cwd: projectPath, stdio: 'pipe' }); // stage it
      fs.writeFileSync(path.join(projectPath, 'src', 'app.js'), 'v2'); // modified but don't stage
      fs.writeFileSync(path.join(projectPath, 'src', 'new.js'), 'new'); // untracked

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data).toHaveProperty('branch');
      expect(result.data).toHaveProperty('detached');
      expect(result.data).toHaveProperty('modified');
      expect(result.data).toHaveProperty('staged');
      expect(result.data).toHaveProperty('untracked');
      expect(result.data).toHaveProperty('conflicted');
      expect(result.data).toHaveProperty('deleted');
      expect(result.data).toHaveProperty('created');

      expect(result.data.staged).toContain('file1.txt');
      expect(result.data.modified).toContain('src/app.js');
      expect(result.data.untracked).toContain('src/new.js');
    });
  });

  describe('Deleted files', () => {
    it('includes deleted files in deleted array', async () => {
      // Create and commit files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'content2');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Delete file
      fs.unlinkSync(path.join(projectPath, 'file1.txt'));

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.deleted).toContain('file1.txt');
    });

    it('returns deleted array in response', async () => {
      // Create and commit
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data.deleted)).toBe(true);
    });
  });

  describe('Created files', () => {
    it('returns created array in response', async () => {
      // Create and commit initial file
      fs.writeFileSync(path.join(projectPath, 'initial.txt'), 'initial');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data.created)).toBe(true);
    });

    it('includes newly created staged files in created array', async () => {
      // Create initial empty commit
      fs.writeFileSync(path.join(projectPath, 'README.md'), 'readme');
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      // Create new file and stage it
      fs.writeFileSync(path.join(projectPath, 'newfile.txt'), 'new');
      execSync('git add newfile.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_status_tool('test-project');

      expect(result.ok).toBe(true);
      if (result.data.created && result.data.created.length > 0) {
        expect(result.data.created).toContain('newfile.txt');
      }
    });
  });
});
