/**
 * E2E tests for foreign-pipeline protection
 * Simulates: pipeline started via CLI (no MCP marker) → MCP cannot stop it without force override
 * Tests foreign-pipeline detection and WORKFLOW_MCP_FORCE_FOREIGN=1 override behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import process from 'process';
import { fileURLToPath } from 'url';

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

    // Kill any remaining test processes
    const runnerPidsPath = path.join(projectPath, '.runner-pids');
    if (fs.existsSync(runnerPidsPath)) {
      try {
        const pidStr = fs.readFileSync(runnerPidsPath, 'utf-8').trim();
        const pid = parseInt(pidStr);
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
      // Simulate pipeline started via CLI (no MCP marker created)
      // Create a long-running test process
      const proc = spawn('sleep', ['30'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const foreignPid = proc.pid;
      expect(foreignPid).toBeGreaterThan(0);

      // Write .runner-pids as if CLI started the pipeline
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, foreignPid.toString(), 'utf-8');

      // Intentionally NO marker file (.mcp-started-by) — simulating CLI-started pipeline
      const markerPath = path.join(logsDir, '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(false);

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

        // Setup foreign pipeline state
        const runnerPidsPath = path.join(projectPath, '.runner-pids');
        fs.writeFileSync(runnerPidsPath, foreignPid.toString(), 'utf-8');

        // No marker file
        const markerPath = path.join(logsDir, '.mcp-started-by');
        expect(fs.existsSync(markerPath)).toBe(false);

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
      'should allow stopping owned pipeline (with marker) without force',
      async () => {
        // Create test process
        const proc = spawn('sleep', ['30'], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();

        const ownedPid = proc.pid;

        // Create proper MCP marker.
        // Маркер свой: `pid` — pid идущего раннера, `mcp_instance_id` — настоящий.
        // Раньше здесь был самодельный hex-идентификатор, который не совпадал ни
        // с чем, и тест проходил бы по ложной причине.
        const markerPath = path.join(logsDir, '.mcp-started-by');
        const { mcpInstanceId } = await import('../../src/lib/project-root.mjs');
        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            version: 1,
            mcp_instance_id: mcpInstanceId(),
            started_at: new Date().toISOString(),
            pid: ownedPid
          }),
          'utf-8'
        );

        // Setup .runner-pids
        const runnerPidsPath = path.join(projectPath, '.runner-pids');
        fs.writeFileSync(runnerPidsPath, ownedPid.toString(), 'utf-8');

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

  describe('TC-004: Foreign vs owned distinction in marker', () => {
    it('should correctly identify foreign pipelines via marker validation', async () => {
      // Create test process
      const proc = spawn('sleep', ['30'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const pid = proc.pid;

      // Create marker with DIFFERENT instance ID (simulating foreign pipeline)
      const markerPath = path.join(logsDir, '.mcp-started-by');
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          version: 1,
          mcp_instance_id: 'workflow-mcp@differentinstance9999', // Foreign
          started_at: new Date().toISOString(),
          pid: 99999  // Different PID in marker
        }),
        'utf-8'
      );

      // Setup .runner-pids with actual PID
      const runnerPidsPath = path.join(projectPath, '.runner-pids');
      fs.writeFileSync(runnerPidsPath, pid.toString(), 'utf-8');

      const { stopPipelineImpl } = await import('../../src/tools/pipeline.mjs');

      // Should reject as foreign (marker has different instance ID)
      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');

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
        const runnerPidsPath = path.join(projectPath, '.runner-pids');
        fs.writeFileSync(runnerPidsPath, foreignPid.toString(), 'utf-8');

        // No marker
        const markerPath = path.join(logsDir, '.mcp-started-by');
        expect(fs.existsSync(markerPath)).toBe(false);

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

        // pid1 is owned (has marker), pid2 is foreign (no marker)
        const markerPath = path.join(logsDir, '.mcp-started-by');
        const mcp_instance_id = `workflow-mcp@${Buffer.from(projectPath).toString('hex').slice(0, 12)}`;

        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            version: 1,
            mcp_instance_id,
            started_at: new Date().toISOString(),
            pid: pid1
          }),
          'utf-8'
        );

        // .runner-pids contains pid2 (the one we're trying to stop)
        const runnerPidsPath = path.join(projectPath, '.runner-pids');
        fs.writeFileSync(runnerPidsPath, pid2.toString(), 'utf-8');

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
