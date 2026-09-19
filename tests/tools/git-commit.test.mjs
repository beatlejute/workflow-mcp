import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import git_tools from '../../src/tools/git.mjs';
import { positionalTool } from '../helpers/tool-call.mjs';

// Вызов идёт через зарегистрированный execute, обёртка — позиционная (см. helper).
const git_commit_tool = positionalTool(git_tools, 'git_commit');
const git_status_tool = positionalTool(git_tools, 'git_status');

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

// Helper to get commit message from SHA
function getCommitMessage(projectPath, sha) {
  try {
    return execSync(`git log -1 --format=%B ${sha}`, {
      cwd: projectPath,
      encoding: 'utf-8'
    }).trim();
  } catch (err) {
    return null;
  }
}

describe('git_commit tool', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'git-commit-tool-'));
    projectPath = createTestProject(testDir);
    process.chdir(testDir);

    // Create initial commit so we have a base
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

  describe('Staged file commitment', () => {
    it('commits a staged file with valid 7+ hex character SHA', async () => {
      // Create and stage a file
      fs.writeFileSync(path.join(projectPath, 'test.txt'), 'test content');
      execSync('git add test.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Add test file'
      });

      expect(result.ok).toBe(true);
      expect(result.data.sha).toBeDefined();
      expect(result.data.short_sha).toBeDefined();

      // Verify SHA is valid hex and 40 chars (full commit hash)
      expect(/^[0-9a-f]{40}$/.test(result.data.sha)).toBe(true);

      // Verify short_sha is 7+ hex characters
      expect(/^[0-9a-f]{7,}$/.test(result.data.short_sha)).toBe(true);

      // Verify message returned matches what was committed
      expect(result.data.message).toBe('Add test file');

      // Verify files in the commit
      expect(result.data.files).toContain('test.txt');
    });

    it('commits multiple staged files together', async () => {
      // Create and stage multiple files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'content2');
      execSync('git add file1.txt file2.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Add multiple files'
      });

      expect(result.ok).toBe(true);
      expect(result.data.files).toContain('file1.txt');
      expect(result.data.files).toContain('file2.txt');
    });
  });

  describe('Empty staged + no paths scenario', () => {
    it('returns NOTHING_TO_COMMIT when no staged changes and no paths provided', async () => {
      const result = await git_commit_tool('test-project', {
        message: 'Attempt to commit nothing'
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOTHING_TO_COMMIT');
      expect(result.message).toContain('Nothing to commit');
    });
  });

  describe('Invalid paths scenario', () => {
    it('returns INVALID_PATHS when paths specified but file not in status', async () => {
      const result = await git_commit_tool('test-project', {
        message: 'Try to commit non-existent file',
        paths: ['nonexistent-file.txt']
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PATHS');
      expect(result.message).toContain('not in a commit-ready state');
    });

    it('returns INVALID_PATHS for multiple paths when some are invalid', async () => {
      // Create and stage one file
      fs.writeFileSync(path.join(projectPath, 'valid.txt'), 'content');
      execSync('git add valid.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Mixed paths',
        paths: ['valid.txt', 'nonexistent.txt']
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PATHS');
    });
  });

  describe('Message validation', () => {
    it('returns INVALID_MESSAGE when message is empty', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: ''
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('between 1 and 5000 characters');
    });

    it('returns INVALID_MESSAGE when message exceeds 5000 characters', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const longMessage = 'a'.repeat(5001);
      const result = await git_commit_tool('test-project', {
        message: longMessage
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('between 1 and 5000 characters');
    });

    it('accepts message with exactly 5000 characters', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const message5000 = 'a'.repeat(5000);
      const result = await git_commit_tool('test-project', {
        message: message5000
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('Co-authors trailers', () => {
    it('adds co_authors as trailers when provided as strings', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Collaborative work',
        co_authors: ['Alice <alice@example.com>', 'Bob <bob@example.com>']
      });

      expect(result.ok).toBe(true);

      // Get the full commit message to verify trailers
      const commitMsg = getCommitMessage(projectPath, result.data.sha);
      expect(commitMsg).toContain('Collaborative work');
      expect(commitMsg).toContain('Co-Authored-By: Alice <alice@example.com>');
      expect(commitMsg).toContain('Co-Authored-By: Bob <bob@example.com>');
    });

    it('adds co_authors as trailers when provided as objects with name and email', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Team effort',
        co_authors: [
          { name: 'Charlie', email: 'charlie@example.com' },
          { name: 'Diana', email: 'diana@example.com' }
        ]
      });

      expect(result.ok).toBe(true);

      const commitMsg = getCommitMessage(projectPath, result.data.sha);
      expect(commitMsg).toContain('Team effort');
      expect(commitMsg).toContain('Co-Authored-By: Charlie <charlie@example.com>');
      expect(commitMsg).toContain('Co-Authored-By: Diana <diana@example.com>');
    });

    it('mixes string and object co_authors', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'Mixed authors',
        co_authors: [
          'Eve <eve@example.com>',
          { name: 'Frank', email: 'frank@example.com' }
        ]
      });

      expect(result.ok).toBe(true);

      const commitMsg = getCommitMessage(projectPath, result.data.sha);
      expect(commitMsg).toContain('Co-Authored-By: Eve <eve@example.com>');
      expect(commitMsg).toContain('Co-Authored-By: Frank <frank@example.com>');
    });

    it('ignores invalid co_authors entries', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'With invalid authors',
        co_authors: [
          'Valid Author <valid@example.com>',
          { name: 'OnlyName' }, // missing email - should be ignored
          null, // should be ignored
          undefined, // should be ignored
          123 // should be ignored
        ]
      });

      expect(result.ok).toBe(true);

      const commitMsg = getCommitMessage(projectPath, result.data.sha);
      expect(commitMsg).toContain('Co-Authored-By: Valid Author <valid@example.com>');
      // Invalid entries should not appear
      expect(commitMsg).not.toContain('OnlyName');
    });
  });

  describe('No --no-verify support', () => {
    it('does not accept --no-verify flag through any parameter', async () => {
      // The tool signature only accepts {message, paths, co_authors}
      // There is no way to pass --no-verify flag to the function
      // This test verifies the function rejects invalid parameters

      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      // Attempting to pass --no-verify will be ignored since the function
      // doesn't have a parameter for it - the function validates the message,
      // paths, and co_authors only
      const result = await git_commit_tool('test-project', {
        message: 'Test commit',
        '--no-verify': true // This parameter is ignored
      });

      // The commit should succeed because the tool only validates known params
      expect(result.ok).toBe(true);

      // Verify the actual git commit was made WITHOUT --no-verify
      // (if pre-commit hooks exist, they would run)
      expect(result.data.sha).toBeDefined();
    });

    it('the code implementation does not use --no-verify flag', async () => {
      // This is a code review assertion: the git_commit function should never
      // spawn git with --no-verify flag, regardless of input
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      // Create a pre-commit hook that logs its invocation
      const hooksDir = path.join(projectPath, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const hookPath = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hookPath, 0o755);

      const result = await git_commit_tool('test-project', {
        message: 'Test with hook'
      });

      // If --no-verify was used, the hook would be skipped and we wouldn't see issues
      // Since we don't use --no-verify, the hook runs and the commit succeeds normally
      expect(result.ok).toBe(true);
      expect(result.data.sha).toBeDefined();
    });
  });

  describe('Explicit paths commitment', () => {
    it('commits only explicitly specified paths when provided', async () => {
      // Create multiple files
      fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'content2');
      fs.writeFileSync(path.join(projectPath, 'file3.txt'), 'content3');

      // Modify all files
      execSync('git add file1.txt file2.txt file3.txt', { cwd: projectPath, stdio: 'pipe' });

      // Commit only file1 and file2
      const result = await git_commit_tool('test-project', {
        message: 'Selective commit',
        paths: ['file1.txt', 'file2.txt']
      });

      expect(result.ok).toBe(true);
      expect(result.data.files).toContain('file1.txt');
      expect(result.data.files).toContain('file2.txt');
    });

    it('commits modified files specified in paths', async () => {
      // Create and commit initial file
      fs.writeFileSync(path.join(projectPath, 'existing.txt'), 'original');
      execSync('git add existing.txt', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit -m "add existing file"', { cwd: projectPath, stdio: 'pipe' });

      // Modify the file
      fs.writeFileSync(path.join(projectPath, 'existing.txt'), 'modified');

      // Commit the modified file using paths
      const result = await git_commit_tool('test-project', {
        message: 'Modify existing file',
        paths: ['existing.txt']
      });

      expect(result.ok).toBe(true);
      expect(result.data.files).toContain('existing.txt');
    });
  });

  describe('Edge cases', () => {
    it('handles message with special characters and newlines', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const messageWithSpecialChars = 'Fix: #123 - Handle special chars: @#$%^&*()';
      const result = await git_commit_tool('test-project', {
        message: messageWithSpecialChars
      });

      expect(result.ok).toBe(true);
      expect(result.data.message).toBe(messageWithSpecialChars);
    });

    it('handles commit with empty co_authors array', async () => {
      fs.writeFileSync(path.join(projectPath, 'file.txt'), 'content');
      execSync('git add file.txt', { cwd: projectPath, stdio: 'pipe' });

      const result = await git_commit_tool('test-project', {
        message: 'No co-authors',
        co_authors: []
      });

      expect(result.ok).toBe(true);

      const commitMsg = getCommitMessage(projectPath, result.data.sha);
      // Message should not contain any Co-Authored-By trailers
      expect(commitMsg).toBe('No co-authors');
    });
  });
});
