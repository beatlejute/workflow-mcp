import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectStuck } from '../../../src/health/detectors/stuck.mjs';
import * as pidCheck from '../../../src/health/pid-check.mjs';
import { writeRunnerLock } from '../../helpers/pipeline-lock.mjs';
import * as thresholds from '../../../src/health/thresholds.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('detectStuck (tests/health/detectors/stuck.test.mjs)', () => {
  let testDir;
  let projectPath;
  let logsDir;
  let configDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'stuck-detector-test-'));
    projectPath = testDir;
    logsDir = path.join(projectPath, '.workflow', 'logs');
    configDir = path.join(projectPath, '.workflow', 'config');

    // Create .workflow/logs and .workflow/config directories
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Create minimal pipeline.yaml for tests
    const pipelineYaml = `pipeline:
  stages:
    execute-task:
      timeout: 10
`;
    fs.writeFileSync(path.join(configDir, 'pipeline.yaml'), pipelineYaml, 'utf8');

    // Зависнуть может только идущий прогон, а идёт он пока лежит lock. Тесты
    // его не клали и ловили зависание по одному логу: ровно так детектор и
    // объявлял зависшим прогон, законченный полгода назад.
    writeRunnerLock(projectPath, process.pid);
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('Basic functionality', () => {
    it('should return null when no pipeline log files exist', () => {
      // Mock isProcessAlive to return true
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return null when logs directory does not exist', () => {
      // Remove logs directory
      fs.rmSync(logsDir, { recursive: true });

      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return null when log file is empty', () => {
      // Create an empty log file
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, '', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return null when PID is dead', () => {
      // Create a running stage log with mtime 20 seconds ago
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Lock раннера с мёртвым pid: такой прогон разбирает detectCrashed.
      // Прежде здесь писался `.runner-pids`, которого не пишет никто, и ветка
      // «pid мёртв» не проверялась вовсе.
      const deadPid = 999999999;
      writeRunnerLock(projectPath, deadPid);

      // Mock isProcessAlive to return false
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(false);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });
  });

  describe('Threshold detection', () => {
    it('should return alert when log age > timeout + headroom', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago (> timeout=10 + headroom=5)
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      expect(result.type).toBe('stuck');
      expect(result.severity).toBe('critical');
      expect(result.stage).toBe('execute-task');
      expect(result.fingerprint).toContain('stuck');
      expect(result.message).toContain('execute-task');
      expect(result.message).toContain('timeout is 10s');
      expect(result.suggested_actions).toEqual(['get_pipeline_log', 'get_pipeline_status']);
    });

    it('should return null when log age <= timeout + headroom', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 10 seconds ago (< timeout=10 + headroom=5)
      const oldMtime = Date.now() - 10000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should respect custom stuck_headroom_sec value', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 25 seconds ago
      const oldMtime = Date.now() - 25000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      // With headroom=20, threshold is 30 seconds, so 25 seconds should not trigger
      const result = detectStuck(projectPath, { stuck_headroom_sec: 20 });
      expect(result).toBeNull();
    });

    it('should use default stuck_headroom_sec when not specified', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 71 seconds ago (> timeout=10 + default_headroom=60)
      const oldMtime = Date.now() - 71000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      // Call without specifying stuck_headroom_sec
      const result = detectStuck(projectPath, {});
      expect(result).not.toBeNull();
      expect(result.type).toBe('stuck');
    });
  });

  describe('False-positive protection', () => {
    it('should return null for freshly started stage (1 sec old)', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 1 second ago
      const freshMtime = Date.now() - 1000;
      fs.utimesSync(logPath, freshMtime / 1000, freshMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return null when no running stage found', () => {
      // Create a completed stage log (has completed_at)
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 12:00:05] [INFO] [agent] COMPLETE stage="execute-task" status="success" exitCode=0
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return null without logging for STAGE_NOT_FOUND', () => {
      // Create a running stage log with non-existent stage
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: unknown-stage
[2026-04-26 12:00:00] [INFO] [agent] START stage="unknown-stage" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      // Расхождение лога с pipeline.yaml — состояние, а не событие: детектор
      // попадал в эту ветку каждый тик и каждый раз писал в stderr.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should alert when lock раннера отсутствует', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago (would normally trigger alert)
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Lock'а нет — pid проверять не у чего. Это не повод молчать: лог
      // висит, и стадия всё равно просрочена. Прежде здесь ожидался тот же
      // исход, но по другой причине — из-за отсутствия `.runner-pids`.

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      // Should alert because no PIDs means process is assumed alive
      expect(result).not.toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should find the most recent log when multiple pipeline logs exist', () => {
      // Create multiple log files
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      // Old log with completed stage
      const oldLogContent = `[2026-04-26 11:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 11:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 11:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 11:00:05] [INFO] [agent] COMPLETE stage="execute-task" status="success" exitCode=0
`;
      fs.writeFileSync(oldLogPath, oldLogContent, 'utf8');

      // New log with running stage
      const newLogContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      fs.writeFileSync(newLogPath, newLogContent, 'utf8');

      // Make old log actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      // Make new log 20 seconds old
      const freshMtime = Date.now() - 20000;
      fs.utimesSync(newLogPath, freshMtime / 1000, freshMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('new-run');
    });

    it('should handle log without valid START line gracefully', () => {
      // Create a log with completed step (all steps have completed_at)
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 12:00:05] [INFO] [agent] COMPLETE stage="execute-task" status="success" exitCode=0
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      // Should return null because all steps are completed (no running step)
      expect(result).toBeNull();
    });

    it('should include context.ticket_id in alert if present', () => {
      // Create a log with context that includes ticket_id
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 12:00:00] [INFO] [agent] Context:
[2026-04-26 12:00:00] [INFO] [agent]   ticket_id: QA-8
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      expect(result.ticket_id).toBe('QA-8');
    });

    it('should return null when context contains ticket_id but stage is not stuck', () => {
      // Create a log with context but recent mtime
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 12:00:00] [INFO] [agent] Context:
[2026-04-26 12:00:00] [INFO] [agent]   ticket_id: IMPL-14
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 5 seconds ago (well within timeout)
      const freshMtime = Date.now() - 5000;
      fs.utimesSync(logPath, freshMtime / 1000, freshMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });
  });

  describe('Alert object properties', () => {
    it('should include all required alert fields', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const beforeTime = new Date().toISOString();
      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.fingerprint).toBeDefined();
      expect(result.type).toBe('stuck');
      expect(result.severity).toBe('critical');
      expect(result.project).toBeDefined();
      expect(result.run_id).toBeDefined();
      expect(result.stage).toBe('execute-task');
      expect(result.step_number).toBeDefined();
      expect(result.ticket_id).toBeDefined();
      expect(result.message).toBeDefined();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
      expect(result.suggested_actions).toBeDefined();
    });

    it('should include correct threshold information in message', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      // Message should contain the timeout value (10 from pipeline.yaml)
      expect(result.message).toContain('timeout is 10s');
    });

    it('should include project name in fingerprint', () => {
      // Create a project with a specific name in path
      const projectName = 'my-workflow-project';
      const namedTestDir = path.join('/tmp', 'stuck-detector-test-', projectName);
      const namedLogsDir = path.join(namedTestDir, '.workflow', 'logs');
      const namedConfigDir = path.join(namedTestDir, '.workflow', 'config');
      fs.mkdirSync(namedLogsDir, { recursive: true });
      fs.mkdirSync(namedConfigDir, { recursive: true });

      const pipelineYaml = `pipeline:
  stages:
    execute-task:
      timeout: 10
`;
      fs.writeFileSync(path.join(namedConfigDir, 'pipeline.yaml'), pipelineYaml, 'utf8');

      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(namedLogsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Проект здесь свой, отдельный от того, что готовит beforeEach, — lock
      // нужен и ему: без lock прогон не считается идущим.
      writeRunnerLock(namedTestDir, process.pid);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(namedTestDir, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain(projectName);
      expect(result.project).toBe(projectName);

      // Cleanup
      fs.rmSync(namedTestDir, { recursive: true, force: true });
    });
  });

  describe('Boundary conditions', () => {
    it('should return null when log age is exactly equal to threshold', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to just under threshold (14.9 seconds < 15 second threshold)
      const mtimeMs = Date.now() - 14900;
      fs.utimesSync(logPath, mtimeMs / 1000, mtimeMs / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return alert when log age is slightly more than threshold', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 15.5 seconds ago (slightly more than threshold)
      const mtimeMs = Date.now() - 15500;
      fs.utimesSync(logPath, mtimeMs / 1000, mtimeMs / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).not.toBeNull();
      expect(result.type).toBe('stuck');
    });

    it('should return null when log age is exactly 1 second (fresh threshold)', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to exactly 1 second ago
      const mtimeMs = Date.now() - 1000;
      fs.utimesSync(logPath, mtimeMs / 1000, mtimeMs / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('should return alert when log age is 1001ms (just beyond fresh threshold)', () => {
      // Create a running stage log
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 1001ms ago (slightly more than fresh threshold but less than timeout)
      const mtimeMs = Date.now() - 1001;
      fs.utimesSync(logPath, mtimeMs / 1000, mtimeMs / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      // Should return null because 1001ms is still within timeout + headroom (15 seconds)
      expect(result).toBeNull();
    });
  });

  describe('Multiple stages handling', () => {
    it('should detect stuck for last running stage among multiple', () => {
      // Create a log with multiple stages where last one is running
      const logContent = `[2026-04-26 12:00:00] [INFO] [PipelineRunner] Step 1
[2026-04-26 12:00:00] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:00] [INFO] [agent] START stage="execute-task" agent="test-agent"
[2026-04-26 12:00:05] [INFO] [agent] COMPLETE stage="execute-task" status="success" exitCode=0
[2026-04-26 12:00:05] [INFO] [PipelineRunner] Step 2
[2026-04-26 12:00:05] [INFO] [PipelineRunner] Current stage: execute-task
[2026-04-26 12:00:05] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      // Set mtime to 20 seconds ago
      const oldMtime = Date.now() - 20000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock PIDs check
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });

      expect(result).not.toBeNull();
      expect(result.type).toBe('stuck');
    });
  });

  describe('Прогона нет вовсе', () => {
    /** Просроченная незакрытая стадия в логе, mtime — далеко в прошлом. */
    function writeOverdueLog(name = 'pipeline_2026-03-24_09-14-21.log') {
      const logContent = `[2026-03-24 09:14:21] [INFO] [PipelineRunner] Step 1
[2026-03-24 09:14:21] [INFO] [PipelineRunner] Current stage: execute-task
[2026-03-24 09:14:21] [INFO] [agent] START stage="execute-task" agent="test-agent"
`;
      const logPath = path.join(logsDir, name);
      fs.writeFileSync(logPath, logContent, 'utf8');
      const oldMtime = Date.now() - 180 * 24 * 3600 * 1000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);
      return logPath;
    }

    it('без lock зависания нет, каким бы старым ни был лог', () => {
      writeOverdueLog();
      fs.rmSync(path.join(projectPath, '.workflow', 'logs', '.pipeline.lock'), { force: true });

      // Процесс жив — но это чужой процесс, к прогону он отношения не имеет.
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('битый lock читается как отсутствие прогона', () => {
      writeOverdueLog();
      fs.writeFileSync(path.join(projectPath, '.workflow', 'logs', '.pipeline.lock'), '{ это не json', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).toBeNull();
    });

    it('тот же лог при живом lock даёт алерт', () => {
      // Контроль к двум проверкам выше: молчание там — от снятого lock, а не
      // от того, что лог перестал считаться просроченным.
      writeOverdueLog();
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(true);

      const result = detectStuck(projectPath, { stuck_headroom_sec: 5 });
      expect(result).not.toBeNull();
      expect(result.type).toBe('stuck');
    });
  });
});
