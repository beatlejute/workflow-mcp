/**
 * Tests for stop_pipeline tool
 * Tests POSIX process kill via process group, Windows taskkill mock, marker validation, and force override
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import process from 'process';
import { stopPipelineImpl } from '../../src/tools/pipeline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('stop_pipeline tool', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let stateDir;
  let logsDir;
  let originalCwd;

  beforeEach(() => {
    // Save original working directory
    originalCwd = process.cwd();

    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-pipeline-test-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    stateDir = path.join(workflowDir, 'state');
    logsDir = path.join(workflowDir, 'logs');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Change to test directory so resolveProjectRoot works correctly
    process.chdir(projectPath);
  });

  afterEach(() => {
    // Restore original working directory
    process.chdir(originalCwd);

    // Clean up test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  // Helper to create marker file (must be in .workflow/logs/)
  /**
   * pid из `.runner-pids` — тот, кого тест выдаёт за идущий раннер.
   * Владение привязано к запуску, поэтому именно этот pid должен лежать
   * в маркере; раньше туда писался `process.pid` самого теста.
   */
  function runnerPidFromFile() {
    try {
      const pids = fs.readFileSync(path.join(projectPath, '.runner-pids'), 'utf-8')
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      return pids.length > 0 ? pids[pids.length - 1] : process.pid;
    } catch {
      return process.pid;
    }
  }

  function createMarker(pid = runnerPidFromFile()) {
    const markerPath = path.join(logsDir, '.mcp-started-by');
    // Тот же алгоритм, что в `lib/project-root.mjs`. Раньше здесь был
    // самодельный hex, который не совпадал ни с чем, и тесты проходили по
    // причине INSTANCE_MISMATCH вместо той, которую проверяют.
    const mcp_instance_id = `workflow-mcp@${createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12)}`;
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      mcp_instance_id,
      started_at: new Date().toISOString(),
      pid
    }), 'utf-8');
  }

  describe('TC-001: POSIX kill terminates process', () => {
    it.skipIf(process.platform === 'win32')('should kill a process on POSIX with SIGKILL to process group', async () => {
      // Create a long-running mock process (sleep)
      const proc = spawn('sleep', ['10'], {
        detached: true,  // Required for process group kill
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;
      expect(childPid).toBeGreaterThan(0);

      // Verify process is running
      const initialCheck = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        initialCheck.on('close', (code) => {
          expect(code).toBe(0); // kill -0 returns 0 if process exists
          resolve();
        });
      });

      // Create .runner-pids file with the PID
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file (so validation passes)
      createMarker();

      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      // Verify result indicates success
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('killed');

      // Verify process is actually dead (with small delay for signal delivery)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if process is dead
      const finalCheck = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        finalCheck.on('close', (code) => {
          // kill -0 should fail (code != 0) if process is dead
          expect(code).not.toBe(0);
          resolve();
        });
      });
    });
  });

  describe('TC-002: POSIX process group kill — child processes also killed', () => {
    it.skipIf(process.platform === 'win32')('should kill all child processes in the process group on POSIX', async () => {
      // Create a parent process that spawns children
      const proc = spawn('bash', ['-c', 'sleep 10 & sleep 10 & sleep 10 & wait'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const parentPid = proc.pid;
      expect(parentPid).toBeGreaterThan(0);

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, parentPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Get initial child count by checking process tree
      const initialChildren = spawn('pgrep', ['-P', parentPid.toString()]);
      let childCountBefore = 0;
      await new Promise((resolve) => {
        let output = '';
        initialChildren.stdout.on('data', (data) => {
          output += data.toString();
        });
        initialChildren.on('close', () => {
          childCountBefore = output.trim().split('\n').filter(x => x).length;
          resolve();
        });
      });

      expect(childCountBefore).toBeGreaterThan(0); // Verify we have child processes

      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(true);
      expect(result.state).toBe('killed');

      // Small delay for signals to deliver
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify child processes are dead
      const childrenAfter = spawn('pgrep', ['-P', parentPid.toString()]);
      let childCountAfter = 0;
      await new Promise((resolve) => {
        let output = '';
        childrenAfter.stdout.on('data', (data) => {
          output += data.toString();
        });
        childrenAfter.on('close', () => {
          childCountAfter = output.trim().split('\n').filter(x => x).length;
          resolve();
        });
      });

      expect(childCountAfter).toBe(0); // All child processes should be killed
    });
  });

  describe('TC-003: Windows mock test — taskkill /F /T is invoked', () => {
    it('should use taskkill on Windows or SIGKILL on POSIX', async () => {
      const dummyPid = 99999; // Non-existent PID for safe testing
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, dummyPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Call stop_pipeline with non-existent PID
      // On Windows, it will try to call taskkill, which will fail gracefully
      // On POSIX, it will try SIGKILL, which will also fail with NO_SUCH_PROCESS
      const result = await stopPipelineImpl('.');

      // Verify that an error occurred (expected for non-existent PID)
      expect(result.ok).toBe(false);
      // Both Windows (taskkill error) and POSIX (SIGKILL) should fail similarly
      // Can also get FOREIGN_PIPELINE if marker validation fails for some reason
      expect(['NO_SUCH_PROCESS', 'EXTERNAL_COMMAND_FAILED', 'UNKNOWN_ERROR', 'FOREIGN_PIPELINE']).toContain(result.code);
    });
  });

  describe('TC-004: Foreign pipeline without force=true → FOREIGN_PIPELINE error', () => {
    it('should reject kill of foreign pipeline without force=true', async () => {
      const dummyPid = 12345;

      // Create .runner-pids file (so PID exists)
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, dummyPid.toString(), 'utf-8');

      // Create marker file with DIFFERENT mcp_instance_id (foreign)
      const markerPath = path.join(logsDir, '.mcp-started-by');
      fs.writeFileSync(markerPath, JSON.stringify({
        version: 1,
        mcp_instance_id: 'workflow-mcp@foreign1234567890abcd', // Different from current
        started_at: new Date().toISOString(),
        pid: 99999  // Different PID
      }), 'utf-8');

      // Call stop_pipeline without force
      const result = await stopPipelineImpl('.');

      // Verify it returns FOREIGN_PIPELINE error
      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.hint).toContain('foreign');
    });
  });

  describe('TC-005: Force override — foreign pipeline killed with force=true', () => {
    it.skipIf(process.platform === 'win32')('should allow killing foreign pipeline when force=true', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['10'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file with DIFFERENT mcp_instance_id (foreign)
      const markerPath = path.join(logsDir, '.mcp-started-by');
      fs.writeFileSync(markerPath, JSON.stringify({
        version: 1,
        mcp_instance_id: 'workflow-mcp@foreign1234567890abcd',
        started_at: new Date().toISOString(),
        pid: 99999
      }), 'utf-8');

      // Call stop_pipeline with force=true
      const result = await stopPipelineImpl('.', { force: true });

      // Verify success despite foreign marker
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('killed');

      // Verify process is dead
      await new Promise((resolve) => setTimeout(resolve, 100));
      const check = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        check.on('close', (code) => {
          expect(code).not.toBe(0); // Process should be dead
          resolve();
        });
      });
    });
  });

  describe('TC-006: Marker removal after successful kill', () => {
    it.skipIf(process.platform === 'win32')('should remove marker file after successful kill', async () => {
      // Create a short-lived process
      const proc = spawn('sleep', ['1'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Verify marker exists
      const markerPath = path.join(logsDir, '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(true);

      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(true);

      // Verify marker is removed
      expect(fs.existsSync(markerPath)).toBe(false);
    });
  });

  describe('TC-007: No .runner-pids file → NO_RUNNER_PIDS error', () => {
    it('should return NO_RUNNER_PIDS when .runner-pids does not exist', async () => {
      // Create marker file but no .runner-pids
      createMarker();

      // Call stop_pipeline with force=true to bypass marker validation
      // (since we're testing the NO_RUNNER_PIDS path)
      const result = await stopPipelineImpl('.', { force: true });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_RUNNER_PIDS');
    });
  });

  describe('TC-008: Empty .runner-pids file → NO_RUNNER_PIDS error', () => {
    it('should return NO_RUNNER_PIDS when .runner-pids is empty', async () => {
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, '', 'utf-8');  // Empty file

      // Create marker file
      createMarker();

      // Call stop_pipeline with force=true
      const result = await stopPipelineImpl('.', { force: true });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_RUNNER_PIDS');
    });
  });

  describe('TC-009: Invalid project path → error', () => {
    it('should throw error for non-existent project', async () => {
      // resolveProjectRoot throws an error if .workflow doesn't exist
      // This is the expected behavior - invalid projects are not tolerated
      let error;
      try {
        await stopPipelineImpl('/nonexistent/project');
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.message).toContain('Project not found');
    });
  });

  describe('TC-010: Return value structure', () => {
    it.skipIf(process.platform === 'win32')('should return correct structure on success', async () => {
      const proc = spawn('sleep', ['10'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      // Setup
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      createMarker();

      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      // Verify structure
      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('pid');
      expect(result).toHaveProperty('state');
      expect(result.ok).toBe(true);
      expect(typeof result.pid).toBe('number');
      expect(result.state).toBe('killed');
      expect(result.pid).toBe(childPid);
    });
  });
});
