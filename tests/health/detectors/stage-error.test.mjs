import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectStageError } from '../../../src/health/detectors/stage-error.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('detectStageError (tests/health/detectors/stage-error.test.mjs)', () => {
  let testDir;
  let projectPath;
  let logsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'stage-error-detector-test-'));
    projectPath = testDir;
    logsDir = path.join(projectPath, '.workflow', 'logs');

    // Create .workflow/logs directory
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
  });

  describe('Basic functionality', () => {
    it('should return null when logs directory does not exist', () => {
      // Remove logs directory
      fs.rmSync(logsDir, { recursive: true });
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });

    it('should return null when no pipeline logs exist', () => {
      // Create a non-pipeline log file
      fs.writeFileSync(path.join(logsDir, 'other.log'), 'other log', 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });

    it('should return null when pipeline log is empty', () => {
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), '', 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });

    it('should return null when pipeline log has no COMPLETE steps', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Current stage: build
START stage="build" agent="impl-agent" skill="execute-task"
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });
  });

  describe('Stage error detection - exitCode', () => {
    it('should return alert when last COMPLETE has exitCode=1', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Current stage: build
START stage="build" agent="impl-agent" skill="execute-task"
OUTPUT ↓
task started
OUTPUT ↑
COMPLETE stage="build" status="success" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.type).toBe('stage_error');
      expect(result.severity).toBe('warning');
      expect(result.stage).toBe('build');
      expect(result.step_number).toBe(1);
      expect(result.message).toContain('exitCode=1');
      expect(result.suggested_actions).toEqual(['get_pipeline_log', 'get_pipeline_status']);
    });

    it('should return alert when last COMPLETE has exitCode=127', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="test" agent="impl-agent"
COMPLETE stage="test" status="success" exitCode=127 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-2.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.type).toBe('stage_error');
      expect(result.message).toContain('127');
    });

    it('should return null when last COMPLETE has exitCode=0', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=0 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).toBeNull();
    });
  });

  describe('Stage error detection - status', () => {
    it('should return alert when last COMPLETE has status=error and exitCode=0', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="deploy" agent="impl-agent"
COMPLETE stage="deploy" status="error" exitCode=0 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.type).toBe('stage_error');
      expect(result.message).toContain('error');
    });

    it('should return null when last COMPLETE has status=success and exitCode=0', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=0 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).toBeNull();
    });
  });

  describe('Multiple COMPLETE steps - only last matters', () => {
    it('should ignore previous error steps and only check the last COMPLETE', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]

[2026-04-25 13:37:31] [INFO] [PipelineRunner] Step 2
START stage="test" agent="impl-agent"
COMPLETE stage="test" status="success" exitCode=0 [2026-04-25 13:37:40]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      // Last COMPLETE is successful, so no error should be reported
      expect(result).toBeNull();
    });

    it('should report error only for the last COMPLETE step even if multiple errors exist', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]

[2026-04-25 13:37:31] [INFO] [PipelineRunner] Step 2
START stage="test" agent="impl-agent"
COMPLETE stage="test" status="error" exitCode=1 [2026-04-25 13:37:40]

[2026-04-25 13:37:41] [INFO] [PipelineRunner] Step 3
START stage="deploy" agent="impl-agent"
COMPLETE stage="deploy" status="success" exitCode=0 [2026-04-25 13:37:50]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      // Last COMPLETE is successful, so no error
      expect(result).toBeNull();
    });

    it('should report the error of the last COMPLETE step when it fails', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=0 [2026-04-25 13:37:30]

[2026-04-25 13:37:31] [INFO] [PipelineRunner] Step 2
START stage="test" agent="impl-agent"
COMPLETE stage="test" status="success" exitCode=0 [2026-04-25 13:37:40]

[2026-04-25 13:37:41] [INFO] [PipelineRunner] Step 3
START stage="deploy" agent="impl-agent"
COMPLETE stage="deploy" status="error" exitCode=1 [2026-04-25 13:37:50]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.stage).toBe('deploy');
      expect(result.step_number).toBe(3);
      expect(result.message).toContain('exitCode=1');
    });
  });

  describe('Alert object properties', () => {
    it('should include correct fingerprint format', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result.fingerprint).toBeDefined();
      expect(result.fingerprint).toContain('stage_error');
      expect(result.fingerprint).toContain('build');
      expect(result.fingerprint).toContain('1');
    });

    it('should include detected_at timestamp', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');

      const beforeTime = new Date().toISOString();
      const result = detectStageError(projectPath);
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
    });

    it('should include project name from directory path', () => {
      const namedTestDir = path.join('/tmp', 'my-test-project');
      const namedLogsDir = path.join(namedTestDir, '.workflow', 'logs');
      fs.mkdirSync(namedLogsDir, { recursive: true });

      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(namedLogsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(namedTestDir);

      expect(result).not.toBeNull();
      expect(result.project).toBe('my-test-project');
      expect(result.fingerprint).toContain('my-test-project');

      // Cleanup
      fs.rmSync(namedTestDir, { recursive: true, force: true });
    });

    it('should extract run_id from log filename', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_my-custom-run-id.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('my-custom-run-id');
    });

    it('should include message with stage and exit code', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.message).toContain('build');
      expect(result.message).toContain('error');
      expect(result.message).toContain('1');
    });
  });

  describe('Edge cases', () => {
    it('should handle COMPLETE steps with different status values', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="warning" exitCode=0 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).toBeNull();
    });

    it('should find most recent log when multiple logs exist', () => {
      // Create old log without error
      const oldLogContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=0 [2026-04-25 13:37:30]
      `;
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      fs.writeFileSync(oldLogPath, oldLogContent, 'utf8');

      // Create new log with error
      const newLogContent = `
[2026-04-25 14:00:00] [INFO] [PipelineRunner] Step 1
START stage="deploy" agent="impl-agent"
COMPLETE stage="deploy" status="error" exitCode=1 [2026-04-25 14:00:10]
      `;
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');
      fs.writeFileSync(newLogPath, newLogContent, 'utf8');

      // Set old log to be actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.stage).toBe('deploy');
      expect(result.run_id).toBe('new-run');
    });

    it('should handle completed_at=null (incomplete step)', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
OUTPUT ↓
Building...
OUTPUT ↑
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).toBeNull();
    });

    it('should handle context and result blocks in log', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="test" agent="impl-agent" skill="execute-task"
Context:
  ticket_id: IMPL-10
  priority: high
OUTPUT ↓
Running tests...
OUTPUT ↑
---RESULT---
coverage: 85%
tests_passed: 150
---RESULT---
COMPLETE stage="test" status="error" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);

      expect(result).not.toBeNull();
      expect(result.type).toBe('stage_error');
      expect(result.ticket_id).toBe('IMPL-10');
    });
  });

  describe('DoD verification', () => {
    it('DoD 1: exitCode=1 in last COMPLETE → alert', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=1 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);
      expect(result).not.toBeNull();
      expect(result.type).toBe('stage_error');
    });

    it('DoD 2: status=success in last COMPLETE → null', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="success" exitCode=0 [2026-04-25 13:37:30]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });

    it('DoD 3: no COMPLETE in log → null', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
OUTPUT ↓
Still building...
OUTPUT ↑
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });

    it('DoD 4: previous error does not affect if last COMPLETE succeeds → null', () => {
      const logContent = `
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 1
START stage="build" agent="impl-agent"
COMPLETE stage="build" status="error" exitCode=1 [2026-04-25 13:37:30]

[2026-04-25 13:37:31] [INFO] [PipelineRunner] Step 2
START stage="test" agent="impl-agent"
COMPLETE stage="test" status="success" exitCode=0 [2026-04-25 13:37:40]
      `;
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-1.log'), logContent, 'utf8');
      const result = detectStageError(projectPath);
      expect(result).toBeNull();
    });
  });
});
