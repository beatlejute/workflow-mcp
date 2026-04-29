import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectGhostExecution } from '../../../src/health/detectors/ghost-execution.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ghost-execution.mjs', () => {
  let testDir;
  let projectPath;
  let logsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'ghost-execution-test-'));
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

  describe('detectGhostExecution', () => {
    // ===== Test Case 1: Marker found in log =====
    it('should return alert when marker "ghost-execution" is found in log', () => {
      // Create a log file with the marker
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some log content\nghost-execution\nMore content', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
      expect(result.severity).toBe('critical');
      expect(result.message).toContain('ghost-execution');
    });

    // ===== Test Case 2: Marker not found =====
    it('should return null when marker is not found in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some log content\nNo marker here\nMore content', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).toBeNull();
    });

    // ===== Test Case 3: Empty log =====
    it('should return null when log file is empty', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, '', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).toBeNull();
    });

    // ===== Test Case 4: Whitespace-only log =====
    it('should return null when log file contains only whitespace', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, '   \n\n  \t  ', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).toBeNull();
    });

    // ===== Test Case 5: No logs directory =====
    it('should return null when logs directory does not exist', () => {
      // Remove logs directory
      fs.rmSync(logsDir, { recursive: true });

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).toBeNull();
    });

    // ===== Test Case 6: No pipeline log files =====
    it('should return null when no pipeline_*.log files exist', () => {
      // Create other files but not pipeline logs
      fs.writeFileSync(path.join(logsDir, 'other-log.txt'), 'content', 'utf8');
      fs.writeFileSync(path.join(logsDir, 'debug.log'), 'content', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).toBeNull();
    });

    // ===== Test Case 7: Can't read log file =====
    it('should return null when log file cannot be read', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some content', 'utf8');

      // Make file unreadable (only on Unix-like systems)
      if (process.platform !== 'win32') {
        fs.chmodSync(logPath, 0o000);

        const result = detectGhostExecution(projectPath, 'ghost-execution');

        expect(result).toBeNull();

        // Restore permissions for cleanup
        fs.chmodSync(logPath, 0o644);
      }
    });

    // ===== Test Case 8: Custom marker parameter =====
    it('should detect custom marker when it exists in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some content\nmy-custom-marker\nEnd', 'utf8');

      const result = detectGhostExecution(projectPath, 'my-custom-marker');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
      expect(result.severity).toBe('critical');
      expect(result.message).toContain('my-custom-marker');
    });

    // ===== Test Case 9: Custom marker not found =====
    it('should return null when custom marker is not in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some content\nghost-execution\nEnd', 'utf8');

      const result = detectGhostExecution(projectPath, 'my-custom-marker');

      expect(result).toBeNull();
    });

    // ===== Test Case 10: Most recent log is used =====
    it('should use the most recent pipeline log when multiple exist', () => {
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      // Create both logs
      fs.writeFileSync(oldLogPath, 'No marker here', 'utf8');
      fs.writeFileSync(newLogPath, 'Some content\nghost-execution\nEnd', 'utf8');

      // Make old log actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('new-run');
    });

    // ===== Test Case 11: Alert includes required fields =====
    it('should include all required fields in alert when marker is found', () => {
      const logPath = path.join(logsDir, 'pipeline_test-run-456.log');
      fs.writeFileSync(logPath, 'ghost-execution detected', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.fingerprint).toBeDefined();
      expect(result.type).toBe('ghost_execution');
      expect(result.severity).toBe('critical');
      expect(result.project).toBeDefined();
      expect(result.run_id).toBe('test-run-456');
      expect(result.ticket_id).toBe('');
      expect(result.message).toBeDefined();
      expect(result.detected_at).toBeDefined();
      expect(result.suggested_actions).toBeDefined();
      expect(Array.isArray(result.suggested_actions)).toBe(true);
    });

    // ===== Test Case 12: Fingerprint includes run_id =====
    it('should include run_id in fingerprint', () => {
      const logPath = path.join(logsDir, 'pipeline_special-run-789.log');
      fs.writeFileSync(logPath, 'ghost-execution', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain('special-run-789');
    });

    // ===== Test Case 13: Marker as substring =====
    it('should find marker as substring within larger text', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Warning: ghost-execution detected in pipeline', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
    });

    // ===== Test Case 14: Case-sensitive marker matching =====
    it('should be case-sensitive when matching marker', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Ghost-Execution marker found', 'utf8');

      // Exact case doesn't match
      const result1 = detectGhostExecution(projectPath, 'ghost-execution');
      expect(result1).toBeNull();

      // Exact case matches
      const result2 = detectGhostExecution(projectPath, 'Ghost-Execution');
      expect(result2).not.toBeNull();
    });

    // ===== Test Case 15: Multiple markers in log (only need one match) =====
    it('should return alert if any instance of marker is found in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      const content = 'Start\nghost-execution\nMiddle\nghost-execution\nEnd';
      fs.writeFileSync(logPath, content, 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
    });

    // ===== Test Case 16: timestamp is current =====
    it('should set detected_at to current timestamp', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'ghost-execution', 'utf8');

      const beforeTime = new Date().toISOString();
      const result = detectGhostExecution(projectPath, 'ghost-execution');
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
    });

    // ===== Test Case 17: suggested_actions contains expected action =====
    it('should include "get_pipeline_log" in suggested_actions', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'ghost-execution', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.suggested_actions).toContain('get_pipeline_log');
    });
  });
});
