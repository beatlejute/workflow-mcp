/**
 * Tests for pause_pipeline and resume_pipeline tools
 * Tests pause → resume cycle on live spawned process, marker validation, idempotency, and notifications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import process from 'process';
import { pausePipelineImpl, resumePipelineImpl } from '../../src/tools/pipeline.mjs';
import * as resources from '../../src/resources/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('pause_pipeline and resume_pipeline tools', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let stateDir;
  let logsDir;
  let originalCwd;
  let notifyMock;

  beforeEach(() => {
    // Save original working directory
    originalCwd = process.cwd();

    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-resume-test-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    stateDir = path.join(workflowDir, 'state');
    logsDir = path.join(workflowDir, 'logs');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Change to test directory so resolveProjectRoot works correctly
    process.chdir(projectPath);

    // Mock the notification handler
    notifyMock = vi.fn();
    resources.setPipelineStateNotificationHandler(notifyMock);
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

    // Restore notification handler
    resources.setPipelineStateNotificationHandler(null);
  });

  // Helper to create marker file (must be in .workflow/logs/)
  function createMarker() {
    const markerPath = path.join(logsDir, '.mcp-started-by');
    // Use same mcp_instance_id calculation as the implementation
    const hash = createHash('sha256').update(projectPath).digest('hex');
    const mcp_instance_id = `workflow-mcp@${hash.slice(0, 12)}`;
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      mcp_instance_id,
      started_at: new Date().toISOString(),
      pid: process.pid
    }), 'utf-8');
  }

  describe('TC-001: pause → resume cycle on live spawned process', () => {
    it.skipIf(process.platform === 'win32')('should pause and resume a running process on POSIX', async () => {
      // Create a long-running mock process (sleep)
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

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

      // Call pause_pipeline
      const pauseResult = await pausePipelineImpl('.');

      expect(pauseResult.ok).toBe(true);
      expect(pauseResult.pid).toBe(childPid);
      expect(pauseResult.state).toBe('paused');
      expect(pauseResult.paused_at).toBeDefined();

      // Small delay for signal delivery
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call resume_pipeline
      const resumeResult = await resumePipelineImpl('.');

      expect(resumeResult.ok).toBe(true);
      expect(resumeResult.pid).toBe(childPid);
      expect(resumeResult.state).toBe('running');

      // Clean up process
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });

  describe('TC-002: pause without marker → MARKER_VALIDATION_FAILED error', () => {
    it('should reject pause when marker validation fails', async () => {
      const dummyPid = 12345;

      // Create .runner-pids file (so PID exists)
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, dummyPid.toString(), 'utf-8');

      // DO NOT create marker file — this should fail validation

      // Call pause_pipeline
      const result = await pausePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('MARKER_VALIDATION_FAILED');
    });
  });

  describe('TC-003: pause with foreign pipeline → MARKER_VALIDATION_FAILED error', () => {
    it('should reject pause when marker is from different MCP instance', async () => {
      const dummyPid = 12345;

      // Create .runner-pids file
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

      // Call pause_pipeline
      const result = await pausePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('MARKER_VALIDATION_FAILED');
    });
  });

  describe('TC-004: resume not paused → NOT_PAUSED error', () => {
    it('should return NOT_PAUSED when trying to resume a process that was never paused', async () => {
      const dummyPid = 12345;

      // Create marker file
      createMarker();

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, dummyPid.toString(), 'utf-8');

      // Try to resume WITHOUT pausing first (no pause state file)
      const result = await resumePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_PAUSED');
    });
  });

  describe('TC-005: resume with different PID → NOT_PAUSED error', () => {
    it('should return NOT_PAUSED when pause state PID differs from current runner PID', async () => {
      const pausedPid = 11111;
      const currentPid = 22222;

      // Create marker file
      createMarker();

      // Create .runner-pids with current PID
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, currentPid.toString(), 'utf-8');

      // Create pause state with different PID
      const pauseStateFile = path.join(stateDir, 'pipeline-pause.json');
      fs.writeFileSync(pauseStateFile, JSON.stringify({
        pid: pausedPid,
        paused_at: new Date().toISOString()
      }), 'utf-8');

      // Try to resume — should fail because PID mismatch
      const result = await resumePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_PAUSED');
    });
  });

  describe('TC-006: notification on pause_pipeline state', () => {
    it.skipIf(process.platform === 'win32')('should emit notification when pause_pipeline succeeds', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Call pause_pipeline
      const result = await pausePipelineImpl('.');

      expect(result.ok).toBe(true);

      // Verify notification was called
      expect(notifyMock).toHaveBeenCalled();

      // Clean up
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });

  describe('TC-007: notification on resume_pipeline state', () => {
    it.skipIf(process.platform === 'win32')('should emit notification when resume_pipeline succeeds', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // First pause
      const pauseResult = await pausePipelineImpl('.');
      expect(pauseResult.ok).toBe(true);

      // Reset mock to check for resume notification
      notifyMock.mockClear();

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Call resume_pipeline
      const resumeResult = await resumePipelineImpl('.');

      expect(resumeResult.ok).toBe(true);

      // Verify notification was called
      expect(notifyMock).toHaveBeenCalled();

      // Clean up
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });

  describe('TC-008: idempotent pause → ALREADY_PAUSED', () => {
    it.skipIf(process.platform === 'win32')('should return ALREADY_PAUSED on repeated pause with same PID', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // First pause
      const firstPause = await pausePipelineImpl('.');
      expect(firstPause.ok).toBe(true);
      expect(firstPause.code).toBeUndefined(); // ok=true, no code field

      const firstPausedAt = firstPause.paused_at;

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second pause (should be idempotent)
      const secondPause = await pausePipelineImpl('.');
      expect(secondPause.ok).toBe(true);
      expect(secondPause.code).toBe('ALREADY_PAUSED');
      expect(secondPause.paused_at).toBe(firstPausedAt); // Same timestamp

      // Clean up
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });

  describe('TC-009: pause with no .runner-pids file → NO_RUNNER_PIDS error', () => {
    it('should return NO_RUNNER_PIDS when .runner-pids file does not exist', async () => {
      // Create marker file first
      createMarker();

      // Do NOT create .runner-pids file
      // This should fail at the .runner-pids check, not at marker validation

      // Call pause_pipeline
      const result = await pausePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_RUNNER_PIDS');
    });
  });

  describe('TC-010: resume with no .runner-pids file → NO_RUNNER_PIDS error', () => {
    it('should return NO_RUNNER_PIDS when .runner-pids file does not exist', async () => {
      // Create marker file first
      createMarker();

      // Do NOT create .runner-pids file
      // This should fail at the .runner-pids check, not at marker validation

      // Call resume_pipeline
      const result = await resumePipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_RUNNER_PIDS');
    });
  });

  describe('TC-011: pause clears pause state on resume', () => {
    it.skipIf(process.platform === 'win32')('should remove pause state file after successful resume', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Pause
      const pauseResult = await pausePipelineImpl('.');
      expect(pauseResult.ok).toBe(true);

      // Verify pause state file exists
      const pauseStateFile = path.join(stateDir, 'pipeline-pause.json');
      expect(fs.existsSync(pauseStateFile)).toBe(true);

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Resume
      const resumeResult = await resumePipelineImpl('.');
      expect(resumeResult.ok).toBe(true);

      // Verify pause state file is removed
      expect(fs.existsSync(pauseStateFile)).toBe(false);

      // Clean up
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });

  describe('TC-012: pause state file is correctly persisted', () => {
    it.skipIf(process.platform === 'win32')('should persist pause state with correct structure', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['30'], {
        detached: false,
        stdio: 'ignore'
      });

      const childPid = proc.pid;

      // Create .runner-pids file
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, childPid.toString(), 'utf-8');

      // Create marker file
      createMarker();

      // Pause
      const pauseResult = await pausePipelineImpl('.');
      expect(pauseResult.ok).toBe(true);

      // Verify pause state file content
      const pauseStateFile = path.join(stateDir, 'pipeline-pause.json');
      const pauseState = JSON.parse(fs.readFileSync(pauseStateFile, 'utf-8'));

      expect(pauseState.pid).toBe(childPid);
      expect(pauseState.paused_at).toBeDefined();
      expect(new Date(pauseState.paused_at)).toBeInstanceOf(Date);

      // Clean up
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        proc.on('close', () => resolve());
      });
    });
  });
});
