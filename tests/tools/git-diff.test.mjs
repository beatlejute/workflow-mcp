import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import gitTools from '../../src/tools/git.mjs';
import { positionalTool } from '../helpers/tool-call.mjs';

const git_diff_tool = positionalTool(gitTools, 'git_diff');

function createTestProject(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });

  execSync('git init', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: projectPath, stdio: 'pipe' });

  return projectPath;
}

describe('git_diff tool', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'git-diff-tool-'));
    projectPath = createTestProject(testDir);
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Empty diff on clean repo', () => {
    it('returns empty diff for a clean repository with no changes', async () => {
      fs.writeFileSync(path.join(projectPath, 'README.md'), 'initial content');
      execSync('git add README.md', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_diff_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.diff).toBe('');
      expect(result.data.files).toEqual([]);
      expect(result.data.truncated).toBe(false);
      expect(result.data.lines_total).toBe(0);
    });
  });

  describe('staged=true vs staged=false return different diffs', () => {
    it('staged=false shows unstaged working tree changes', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'modified');

      const result = await git_diff_tool('test-project', { staged: false });

      expect(result.ok).toBe(true);
      expect(result.data.diff).toContain('original');
      expect(result.data.diff).toContain('modified');
      expect(result.data.files).toContain('file.txt');
    });

    it('staged=true shows staged index changes', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'staged-content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_diff_tool('test-project', { staged: true });

      expect(result.ok).toBe(true);
      expect(result.data.diff).toContain('original');
      expect(result.data.diff).toContain('staged-content');
      expect(result.data.files).toContain('file.txt');
    });

    it('staged=true vs staged=false return different content', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'staged-change');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'unstaged-change');

      const stagedResult = await git_diff_tool('test-project', { staged: true });
      const unstagedResult = await git_diff_tool('test-project', { staged: false });

      expect(stagedResult.ok).toBe(true);
      expect(unstagedResult.ok).toBe(true);
      expect(stagedResult.data.diff).not.toBe(unstagedResult.data.diff);
      expect(stagedResult.data.diff).toContain('staged-change');
      expect(unstagedResult.data.diff).toContain('unstaged-change');
    });

    it('staged=true returns empty when nothing is staged', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'original');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'modified');

      const result = await git_diff_tool('test-project', { staged: true });

      expect(result.ok).toBe(true);
      expect(result.data.diff).toBe('');
    });
  });

  describe('max_lines truncation', () => {
    it('truncates diff when lines exceed max_lines and sets truncated=true', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'initial');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      fs.writeFileSync(path.join(projectPath, 'file.txt'), lines);

      const result = await git_diff_tool('test-project', { max_lines: 5 });

      expect(result.ok).toBe(true);
      expect(result.data.truncated).toBe(true);
      expect(result.data.lines_total).toBeGreaterThan(5);
      const diffLines = result.data.diff.split('\n');
      expect(diffLines.length).toBeLessThanOrEqual(5);
    });

    it('does not truncate when max_lines is sufficient', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'initial');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'changed');

      const result = await git_diff_tool('test-project', { max_lines: 500 });

      expect(result.ok).toBe(true);
      expect(result.data.truncated).toBe(false);
      expect(result.data.lines_total).toBeGreaterThan(0);
    });

    it('lines_total reflects actual line count before truncation', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'initial');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const bigContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      fs.writeFileSync(path.join(projectPath, 'file.txt'), bigContent);

      const fullResult = await git_diff_tool('test-project', { max_lines: 500 });
      const truncatedResult = await git_diff_tool('test-project', { max_lines: 5 });

      expect(truncatedResult.data.lines_total).toBe(fullResult.data.lines_total);
    });
  });

  describe('Binary files marked [binary]', () => {
    it('marks binary files with [binary] in the files list', async () => {
      fs.writeFileSync(path.join(projectPath, 'readme.txt'), 'text');
      const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
      fs.writeFileSync(path.join(projectPath, 'image.png'), binaryContent);
      execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const newBinary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x02]);
      fs.writeFileSync(path.join(projectPath, 'image.png'), newBinary);

      const result = await git_diff_tool('test-project');

      expect(result.ok).toBe(true);
      expect(result.data.diff).toContain('Binary files');
      expect(result.data.files.some(f => f.includes('[binary]'))).toBe(true);
      expect(result.data.files).toContain('image.png [binary]');
    });
  });

  describe('Path traversal rejection', () => {
    it('rejects path traversal with ../etc/passwd', async () => {
      const result = await git_diff_tool('test-project', { path: '../etc/passwd' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PATH');
    });

    it('rejects path starting with ./ ', async () => {
      const result = await git_diff_tool('test-project', { path: './secrets' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PATH');
    });

    it('rejects path with .. in the middle', async () => {
      const result = await git_diff_tool('test-project', { path: 'src/../../../etc/passwd' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PATH');
    });

    it('accepts valid relative path', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'initial');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'modified');

      const result = await git_diff_tool('test-project', { path: 'file.txt' });

      expect(result.ok).toBe(true);
      expect(result.data.files).toContain('file.txt');
    });
  });

  describe('max_lines > 5000 returns TOO_MANY_LINES', () => {
    it('rejects max_lines exceeding 5000', async () => {
      const result = await git_diff_tool('test-project', { max_lines: 5001 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOO_MANY_LINES');
    });

    it('rejects max_lines = 10000', async () => {
      const result = await git_diff_tool('test-project', { max_lines: 10000 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOO_MANY_LINES');
    });

    it('accepts max_lines = 5000', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'initial');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_diff_tool('test-project', { max_lines: 5000 });

      expect(result.ok).toBe(true);
    });

    it('error message mentions the requested and maximum values', async () => {
      const result = await git_diff_tool('test-project', { max_lines: 9999 });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('9999');
      expect(result.message).toContain('5000');
    });
  });

  describe('Invalid project', () => {
    it('returns INVALID_PROJECT for unknown project', async () => {
      const result = await git_diff_tool('nonexistent-project');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT');
    });
  });
});
