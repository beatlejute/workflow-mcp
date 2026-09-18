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
      fs.writeFileSync(logPath, 'Some log content\n[GHOST-EXECUTION] step=3\nMore content', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
      expect(result.severity).toBe('critical');
      expect(result.message).toContain('[GHOST-EXECUTION]');
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
      fs.writeFileSync(logPath, 'Some content\n[MY-CUSTOM-MARKER] step=1\nEnd', 'utf8');

      const result = detectGhostExecution(projectPath, 'my-custom-marker');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
      expect(result.severity).toBe('critical');
      expect(result.message).toContain('[MY-CUSTOM-MARKER]');
    });

    // ===== Test Case 9: Custom marker not found =====
    it('should return null when custom marker is not in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'Some content\n[GHOST-EXECUTION]\nEnd', 'utf8');

      const result = detectGhostExecution(projectPath, 'my-custom-marker');

      expect(result).toBeNull();
    });

    // ===== Test Case 10: Most recent log is used =====
    it('should use the most recent pipeline log when multiple exist', () => {
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      // Create both logs
      fs.writeFileSync(oldLogPath, 'No marker here', 'utf8');
      fs.writeFileSync(newLogPath, 'Some content\n[GHOST-EXECUTION]\nEnd', 'utf8');

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
      fs.writeFileSync(logPath, '[GHOST-EXECUTION] detected', 'utf8');

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
      fs.writeFileSync(logPath, '[GHOST-EXECUTION]', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain('special-run-789');
    });

    // ===== Test Case 13 (FIX-001): прозаическое упоминание НЕ детектится =====
    // Раньше подстрочный includes() давал critical-алерт на любой текст со словами
    // «ghost-execution»: тег тикета, commit message, имя файла, цитату из отчёта.
    // Прецедент 2026-08-04: скан по workflowAi вернул 12 записей, все ложные.
    it.each([
      ['commit message', 'Warning: ghost-execution detected in pipeline'],
      ['тег тикета', 'tags: [dod-fill, ticket-update, ghost-execution]'],
      ['имя файла', '  -a----  19.04.2026  14:11  4532 ghost-execution-qa-18.log'],
      ['цитата из отчёта', 'Новых ghost-execution не обнаружено'],
      ['commit в выводе агента', '71b8df6 fix(runner): add E2E ghost-execution gate']
    ])('не детектит маркер в прозе: %s', (_name, line) => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, line, 'utf8');

      expect(detectGhostExecution(projectPath, 'ghost-execution')).toBeNull();
    });

    // ===== Test Case 14: регистр структурного маркера =====
    it('матчит структурный маркер с учётом регистра', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, '[ghost-execution] lower case', 'utf8');

      // Нормализованный маркер — [GHOST-EXECUTION], нижний регистр не совпадает
      expect(detectGhostExecution(projectPath, 'ghost-execution')).toBeNull();

      // Структурный маркер из конфига берётся как есть
      expect(detectGhostExecution(projectPath, '[ghost-execution]')).not.toBeNull();
    });

    // ===== Test Case 14b: нормализация старого конфига =====
    it('голый маркер из старого конфига нормализуется в скобочную форму', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, 'step 3\n[GHOST-EXECUTION]\ndone', 'utf8');

      // Любой регистр голого слова приводится к [GHOST-EXECUTION]
      expect(detectGhostExecution(projectPath, 'ghost-execution')).not.toBeNull();
      expect(detectGhostExecution(projectPath, 'Ghost-Execution')).not.toBeNull();
    });

    // ===== Test Case 15: Multiple markers in log (only need one match) =====
    it('should return alert if any instance of marker is found in log', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      const content = 'Start\n[GHOST-EXECUTION]\nMiddle\n[GHOST-EXECUTION]\nEnd';
      fs.writeFileSync(logPath, content, 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.type).toBe('ghost_execution');
    });

    // ===== Test Case 16: timestamp is current =====
    it('should set detected_at to current timestamp', () => {
      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, '[GHOST-EXECUTION]', 'utf8');

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
      fs.writeFileSync(logPath, '[GHOST-EXECUTION]', 'utf8');

      const result = detectGhostExecution(projectPath, 'ghost-execution');

      expect(result).not.toBeNull();
      expect(result.suggested_actions).toContain('get_pipeline_log');
    });
  });
});
