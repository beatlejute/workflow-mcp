/**
 * E2E tests for foreign-pipeline protection
 * Simulates: pipeline started via CLI → MCP cannot stop it without force override
 * Tests foreign-pipeline detection and WORKFLOW_MCP_FORCE_FOREIGN=1 override behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import process from 'process';
import { fileURLToPath } from 'url';
import { writeRunnerLock, runnerLockPath } from '../helpers/pipeline-lock.mjs';
import { readPipelineLock } from '../../src/process/run-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('E2E: foreign-pipeline protection', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let logsDir;
  let stateDir;
  let originalCwd;
  let originalEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = { ...process.env };

    // Create temporary test project structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-pipeline-e2e-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    logsDir = path.join(workflowDir, 'logs');
    stateDir = path.join(workflowDir, 'state');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Create minimal workflow config
    const configDir = path.join(workflowDir, 'configs');
    fs.mkdirSync(configDir, { recursive: true });

    process.chdir(projectPath);
  });

  afterEach(() => {
    // Restore environment
    process.env = { ...originalEnv };
    process.chdir(originalCwd);

    // Kill any remaining test processes.
    // Раньше здесь парсился `.runner-pids` — одно число в файле. Lock раннера
    // это JSON, и `parseInt` над ним даёт NaN: уборка молча не выполнялась и
    // оставляла процессы-сироты. Читаем поле `pid`.
    if (fs.existsSync(runnerLockPath(projectPath))) {
      try {
        const lock = readPipelineLock(projectPath);
        const pid = lock ? lock.pid : 0;
        if (pid > 0 && process.platform !== 'win32') {
          try {
            process.kill(-pid, 'SIGKILL'); // Kill process group
          } catch {
            // Ignore if already dead
          }
        }
      } catch {
        // Ignore
      }
    }

    // Clean up test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  });

  describe('TC-001: Foreign pipeline detection — MCP rejects stop without force', () => {
    it('should return FOREIGN_PIPELINE error when stopping pipeline started via CLI', async () => {
      // Simulate a pipeline started via CLI
      // Create a long-running test process
      const proc = spawn('sleep', ['30'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const foreignPid = proc.pid;
      expect(foreignPid).toBeGreaterThan(0);

      // Lock, как его пишет запуск из CLI: `started_by: 'cli'`. По умолчанию
      // помощник ставит `'mcp'`, и фикстура описывала бы не тот сценарий.
      writeRunnerLock(projectPath, foreignPid, { started_by: 'cli' });

      // Файла владения от MCP нет вовсе: с 3.0.0 его не существует.
      expect(fs.existsSync(path.join(logsDir, '.mcp-started-by'))).toBe(false);

      // Dynamically import stopPipelineImpl from tools/pipeline.mjs
      const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

      // Try to stop the foreign pipeline (should fail)
      const result = await stopPipelineImpl('.');

      // Verify FOREIGN_PIPELINE error
      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.hint).toBeDefined();
      expect(result.hint.toLowerCase()).toContain('foreign');

      // Verify process is still alive (not killed)
      expect(() => {
        // Verify PID still exists by checking /proc on Unix or equivalent
        if (process.platform !== 'win32') {
          // On POSIX, send signal 0 to check if process exists
          process.kill(foreignPid, 0);
        }
      }).not.toThrow();

      // Clean up
      if (process.platform !== 'win32') {
        try {
          process.kill(-foreignPid, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
    });
  });

  describe('TC-002: Force override with env var — WORKFLOW_MCP_FORCE_FOREIGN=1 allows stop', () => {
    it.skipIf(process.platform === 'win32')(
      'should allow stopping foreign pipeline when WORKFLOW_MCP_FORCE_FOREIGN=1',
      async () => {
        // Create another test process (foreign)
        const proc = spawn('sleep', ['30'], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();

        const foreignPid = proc.pid;

        // Чужой запуск: lock из CLI
        writeRunnerLock(projectPath, foreignPid, { started_by: 'cli', started_by_id: null });

        // Set env var to override protection
        process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';

        const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

        // Try to stop with override
        const result = await stopPipelineImpl('.');

        // Should succeed despite foreign pipeline
        expect(result.ok).toBe(true);
        expect(result.pid).toBe(foreignPid);
        expect(result.state).toBe('killed');

        // Verify process is actually killed
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check if process is dead
        if (process.platform !== 'win32') {
          const checkProc = spawn('kill', ['-0', foreignPid.toString()]);
          await new Promise((resolve) => {
            checkProc.on('close', (code) => {
              expect(code).not.toBe(0); // kill -0 should fail
              resolve();
            });
          });
        }
      }
    );
  });

  describe('TC-003: Owned pipeline can be stopped without force', () => {
    it.skipIf(process.platform === 'win32')(
      'should allow stopping an owned pipeline (lock carries our mark) without force',
      async () => {
        // Create test process
        const proc = spawn('sleep', ['30'], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();

        const ownedPid = proc.pid;

        // Lock нашего запуска: помощник ставит `started_by: 'mcp'` и метку
        // нашей рабочей области — ровно то, что пишет настоящий раннер.
        writeRunnerLock(projectPath, ownedPid);

        const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

        // Stop without force should work (pipeline is owned)
        const result = await stopPipelineImpl('.');

        expect(result.ok).toBe(true);
        expect(result.pid).toBe(ownedPid);
        expect(result.state).toBe('killed');

        // Verify process is dead
        await new Promise((resolve) => setTimeout(resolve, 100));
        const checkProc = spawn('kill', ['-0', ownedPid.toString()]);
        await new Promise((resolve) => {
          checkProc.on('close', (code) => {
            expect(code).not.toBe(0); // Process should be dead
            resolve();
          });
        });
      }
    );
  });

  describe('TC-004: Foreign vs owned distinction in the lock', () => {
    it('should correctly identify foreign pipelines by the instance mark', async () => {
      // Create test process
      const proc = spawn('sleep', ['30'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const pid = proc.pid;

      // Lock того же вида, но с меткой другого экземпляра MCP.
      writeRunnerLock(projectPath, pid, { started_by_id: 'workflow-mcp@differenti' });

      const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.reason).toBe('INSTANCE_MISMATCH');

      // Clean up
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    });
  });

  describe('TC-005: Warning message on force override', () => {
    it.skipIf(process.platform === 'win32')(
      'should emit warning when WORKFLOW_MCP_FORCE_FOREIGN=1 is used',
      async () => {
        // Setup foreign pipeline
        const proc = spawn('sleep', ['30'], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();

        const foreignPid = proc.pid;
        writeRunnerLock(projectPath, foreignPid, { started_by: 'cli', started_by_id: null });

        // Set override
        process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';

        // Capture stderr
        const stderrSpy = vi.spyOn(process.stderr, 'write');

        const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');
        const result = await stopPipelineImpl('.');

        // Verify warning was written
        expect(stderrSpy).toHaveBeenCalled();
        const stderrCalls = stderrSpy.mock.calls.map((args) => args[0]);
        const warningText = stderrCalls.join('');

        // Look for warning about override
        expect(warningText.toLowerCase()).toContain('force');
        expect(warningText.toLowerCase()).toContain('dangerous');

        stderrSpy.mockRestore();

        // Clean up
        try {
          process.kill(-foreignPid, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
    );
  });

  describe('TC-006: Multiple pipelines — only foreign ones rejected', () => {
    it.skipIf(process.platform === 'win32')(
      'should distinguish between owned and foreign pipelines',
      async () => {
        // Create two processes
        const proc1 = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        proc1.unref();
        const pid1 = proc1.pid;

        const proc2 = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        proc2.unref();
        const pid2 = proc2.pid;

        // В проекте идёт чужой запуск (pid2), а pid1 — посторонний живой
        // процесс. Владение описывает только lock, и он говорит «не наш».
        void pid1;
        writeRunnerLock(projectPath, pid2, { started_by: 'cli', started_by_id: null });

        const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

        // Try to stop pid2 (foreign)
        const result = await stopPipelineImpl('.');

        // Should be rejected as foreign
        expect(result.ok).toBe(false);
        expect(result.code).toBe('FOREIGN_PIPELINE');

        // Verify pid2 is still alive
        const checkProc = spawn('kill', ['-0', pid2.toString()]);
        await new Promise((resolve) => {
          checkProc.on('close', (code) => {
            expect(code).toBe(0); // Process still alive
            resolve();
          });
        });

        // Clean up
        try {
          process.kill(-pid1, 'SIGKILL');
          process.kill(-pid2, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
    );
  });
});
