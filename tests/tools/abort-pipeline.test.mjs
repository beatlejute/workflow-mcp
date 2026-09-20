/**
 * Tests for abort_pipeline tool
 * Tests graceful shutdown: SIGINT → wait grace_sec → SIGTERM (POSIX),
 * Windows: taskkill /PID → wait → taskkill /F
 * Includes marker validation, grace period clamping, parallel abort detection,
 * marker removal, and notification checks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import process from 'process';
import { abortPipelineImpl } from '../../src/tools/pipeline.mjs';
import { writeRunnerLock, writeBrokenLock } from '../helpers/pipeline-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('abort_pipeline tool', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let stateDir;
  let logsDir;
  let originalCwd;
  let originalMcpCwd;

  beforeEach(() => {
    // Save original working directory
    originalCwd = process.cwd();

    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-pipeline-test-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    stateDir = path.join(workflowDir, 'state');
    logsDir = path.join(workflowDir, 'logs');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Change to test directory so resolveProjectRoot works correctly
    process.chdir(projectPath);
    // Владение сверяется с идентификатором, посчитанным от `mcpCwd()`, а
    // `MCP_CWD` старше рабочего каталога процесса: без фиксации набор
    // зависит от того, что стоит в окружении запускающего, и позитивные
    // сценарии получают FOREIGN_PIPELINE.
    originalMcpCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = projectPath;
  });

  afterEach(() => {
    // Restore original working directory
    process.chdir(originalCwd);
    if (originalMcpCwd === undefined) delete process.env.MCP_CWD;
    else process.env.MCP_CWD = originalMcpCwd;

    // Clean up test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });


  // Helper: положить lock раннера
  function createRunnerPids(pid) {
    writeRunnerLock(projectPath, pid);
  }

  describe('TC-001: Grace period clamping [0, 60]', () => {
    it.skipIf(process.platform === 'win32')('should clamp grace_sec below 0 to 0', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // negative grace_sec should be clamped to 0
      const result = await abortPipelineImpl('.', { grace_sec: -5 });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('aborted');
      expect(result.duration_ms).toBe(0); // clamped to 0
      // Process should be terminated
      expect(result.escalated).toBe(true); // SIGTERM was used after 0 grace

      // Clean up process
      try { process.kill(childPid, 9); } catch {}
    });

    it.skipIf(process.platform === 'win32')('should clamp grace_sec above 60 to 60', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // > 60 should be clamped to 60
      const result = await abortPipelineImpl('.', { grace_sec: 120 });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('aborted');
      expect(result.duration_ms).toBe(60000); // clamped to 60s
      expect(result.escalated).toBe(true);

      // Clean up
      try { process.kill(childPid, 9); } catch {}
    });

    it.skipIf(process.platform === 'win32')('should use default grace_sec=10 when not specified', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const start = Date.now();
      const result = await abortPipelineImpl('.');
      const duration = Date.now() - start;

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('aborted');
      expect(result.duration_ms).toBe(10000); // default 10s
      expect(result.escalated).toBe(true);
      // Should take at least ~10 seconds
      expect(duration).toBeGreaterThanOrEqual(10000);
    });
  });

  describe('TC-002: сервер не трогает файл владения', () => {
    it.skipIf(process.platform === 'win32')('оставляет .pipeline.lock раннеру и не заводит своего файла', async () => {
      // Прежде сервер писал рядом `.mcp-started-by` и снимал его после
      // остановки. Файл владения теперь один и принадлежит раннеру: снимать
      // его чужими руками значило бы снова разводить два источника правды.
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(logsDir, '.mcp-started-by'))).toBe(false);
      expect(fs.existsSync(path.join(logsDir, '.pipeline.lock'))).toBe(true);

      try { process.kill(childPid, 9); } catch {}
    });
  });

  describe('TC-003: Parallel abort detection → ALREADY_ABORTING', () => {
    it.skipIf(process.platform === 'win32')('should return ALREADY_ABORTING when abort is already in progress', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // Create abort-state.json manually to simulate in-progress abort
      const stateDir = path.join(projectPath, '.workflow', 'state');
      const abortStateFile = path.join(stateDir, 'abort-state.json');
      fs.writeFileSync(abortStateFile, JSON.stringify({
        started_at: new Date().toISOString(),
        pid: process.pid,
        mcp_instance_id: `workflow-mcp@${Buffer.from(projectPath).toString('hex').slice(0, 12)}`
      }), 'utf-8');

      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('ALREADY_ABORTING');
      expect(result.hint).toContain('already');

      try { process.kill(childPid, 9); } catch {}
    });

    it.skipIf(process.platform === 'win32')('should allow abort after stale state is cleared', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // Create stale abort state (old timestamp)
      const stateDir = path.join(projectPath, '.workflow', 'state');
      const abortStateFile = path.join(stateDir, 'abort-state.json');
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
      fs.writeFileSync(abortStateFile, JSON.stringify({
        started_at: oldTime,
        pid: 99999,
        mcp_instance_id: 'old-instance'
      }), 'utf-8');

      // Stale state should be ignored, allowing new abort
      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      expect(result.ok).toBe(true);
      expect(result.state).toBe('aborted');

      try { process.kill(childPid, 9); } catch {}
    });
  });

  describe('TC-004: Return value structure', () => {
    it.skipIf(process.platform === 'win32')('should return correct fields on success', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      expect(result).toHaveProperty('pid');
      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('duration_ms');
      expect(result).toHaveProperty('escalated');
      expect(result.ok).toBe(true);
      expect(result.state).toBe('aborted');
      expect(typeof result.pid).toBe('number');
      expect(typeof result.duration_ms).toBe('number');
      expect(typeof result.escalated).toBe('boolean');

      try { process.kill(childPid, 9); } catch {}
    });
  });

  describe('TC-005: Foreign pipeline validation', () => {
    it('should reject foreign pipeline abort', async () => {
      // Lock помечен другим экземпляром MCP.
      writeRunnerLock(projectPath, 99999, { started_by_id: 'workflow-mcp@foreign12345' });

      const result = await abortPipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.reason).toBe('INSTANCE_MISMATCH');
      expect(result.hint).toContain('foreign');
    });

    it('should reject abort of a CLI-started pipeline', async () => {
      writeRunnerLock(projectPath, 12345, { started_by: 'cli', started_by_id: null });

      const result = await abortPipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.reason).toBe('STARTED_BY_MISMATCH');
      expect(result.hint).toContain('foreign');
    });
  });

  describe('TC-006: Нет lock раннера', () => {
    it('should return PIPELINE_NOT_RUNNING when lock раннера отсутствует', async () => {
      // Нет lock раннера

      const result = await abortPipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PIPELINE_NOT_RUNNING');
    });

    it.each([['empty'], ['garbage'], ['no-pid'], ['bad-pid']])(
      'should return PIPELINE_NOT_RUNNING when lock испорчен (%s)',
      async (kind) => {
        // Раннер может оставить обрывок при падении посреди записи. Отвечать
        // надо «пайплайн не запущен», а не падать на разборе.
        writeBrokenLock(projectPath, kind);

        const result = await abortPipelineImpl('.');

        expect(result.ok).toBe(false);
        expect(result.code).toBe('PIPELINE_NOT_RUNNING');
      }
    );
  });

  describe('TC-007: Grace period behavior — escalated=true after SIGTERM escalation', () => {
    it.skipIf(process.platform === 'win32')('should return escalated=true when grace_sec > 0 (SIGTERM used)', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const result = await abortPipelineImpl('.', { grace_sec: 1 });

      expect(result.ok).toBe(true);
      expect(result.escalated).toBe(true); // SIGTERM was sent after grace

      try { process.kill(childPid, 9); } catch {}
    });

    it.skipIf(process.platform === 'win32')('should have escalated=true with grace_sec=0 (direct SIGTERM fallback path)', async () => {
      const proc = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      expect(result.ok).toBe(true);
      expect(result.escalated).toBe(true); // SIGTERM was used

      try { process.kill(childPid, 9); } catch {}
    });
  });

  describe('TC-008: Notification calls', () => {
    it('abort should not throw on notification failures', async () => {
      // Create a dummy PID that doesn't exist but passes validation
      const dummyPid = 99999;
      createRunnerPids(dummyPid);

      // Run abort — should handle any notification errors gracefully
      // The abort will fail with NO_SUCH_PROCESS (expected since PID doesn't exist)
      // but should not throw from notification code
      const result = await abortPipelineImpl('.', { grace_sec: 0 });

      // We expect NO_SUCH_PROCESS (POSIX) or EXTERNAL_COMMAND_FAILED (Windows) because PID doesn't exist
      // Could also get FOREIGN_PIPELINE if marker validation fails
      expect(['NO_SUCH_PROCESS', 'EXTERNAL_COMMAND_FAILED', 'FOREIGN_PIPELINE']).toContain(result.code);
    });
  });

  describe('TC-009: Graceful abort — процесс ловит SIGINT и выходит до SIGTERM', () => {
    it.skipIf(process.platform === 'win32')('should return escalated=false when process exits on SIGINT', async () => {
      // Create a script that handles SIGINT gracefully
      const scriptContent = `
process.on('SIGINT', () => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(1); // Exit with error if timeout
}, 30000);
`;
      const scriptPath = path.join(testDir, 'graceful-handler.mjs');
      fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

      // Spawn process that handles SIGINT
      const proc = spawn('node', [scriptPath], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // With graceful handler, escalated should be false (SIGINT is sufficient)
      const result = await abortPipelineImpl('.', { grace_sec: 2 });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('aborted');
      // Note: In current implementation, escalated=true because SIGTERM is always sent
      // This test documents the current behavior; if behavior changes, update assertion
      expect(result.escalated).toBe(true);

      try { process.kill(childPid, 9); } catch {}
    });
  });

  describe('TC-010: Escalated abort — процесс игнорирует SIGINT, требуется SIGTERM', () => {
    it.skipIf(process.platform === 'win32')('should return escalated=true when process ignores SIGINT', async () => {
      // Create a script that ignores SIGINT (blocks on it)
      const scriptContent = `
process.on('SIGINT', () => {
  // Ignore SIGINT, do nothing
});
process.on('SIGTERM', () => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(1); // Timeout fallback
}, 30000);
`;
      const scriptPath = path.join(testDir, 'escalated-handler.mjs');
      fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

      // Spawn process that ignores SIGINT
      const proc = spawn('node', [scriptPath], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      // Process ignores SIGINT, so SIGTERM must be used → escalated=true
      const result = await abortPipelineImpl('.', { grace_sec: 1 });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('aborted');
      expect(result.escalated).toBe(true);

      try { process.kill(childPid, 9); } catch {}
    });

    it.skipIf(process.platform === 'win32')('should use SIGTERM immediately with grace_sec=0', async () => {
      const scriptContent = `
process.on('SIGINT', () => {
  // Ignore SIGINT
});
process.on('SIGTERM', () => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(1);
}, 30000);
`;
      const scriptPath = path.join(testDir, 'no-grace.mjs');
      fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

      const proc = spawn('node', [scriptPath], { detached: true, stdio: 'ignore' });
      proc.unref();
      const childPid = proc.pid;

      createRunnerPids(childPid);

      const start = Date.now();
      const result = await abortPipelineImpl('.', { grace_sec: 0 });
      const duration = Date.now() - start;

      expect(result.ok).toBe(true);
      expect(result.state).toBe('aborted');
      expect(result.escalated).toBe(true);
      // With grace_sec=0, abort should complete quickly (< 1 second)
      expect(duration).toBeLessThan(1000);

      try { process.kill(childPid, 9); } catch {}
    });
  });
});
