import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectRetryLoop } from '../../src/health/detectors/retry-loop.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('retry-loop.mjs', () => {
  let testDir;
  let projectPath;
  let stateDir;
  let logsDir;
  let configDir;
  let countersPath;

  beforeEach(() => {
    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join('/tmp', 'retry-loop-test-'));
    projectPath = testDir;
    stateDir = path.join(projectPath, '.workflow', 'state');
    logsDir = path.join(projectPath, '.workflow', 'logs');
    configDir = path.join(projectPath, '.workflow', 'config');
    countersPath = path.join(stateDir, 'counters.json');

    // Create directories
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
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

  describe('detectRetryLoop', () => {
    it('should return null when counter file does not exist (fresh start)', () => {
      // Mock getCounterLimit to return a valid limit
      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(3);

      // countersPath does not exist
      expect(fs.existsSync(countersPath)).toBe(false);

      const result = detectRetryLoop(projectPath, {});
      expect(result).toBeNull();
    });

    it('should return null when limit is not set in pipeline.yaml', () => {
      // Mock getCounterLimit to return null (limit not configured)
      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(null);

      // Create counter file with some data
      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: 2 }), 'utf8');

      // Ненастроенный лимит — выбор конфигурации, а не ошибка: детектор
      // молчит. Предупреждение убрано, потому что печаталось каждый тик по
      // каждому проекту, а тик теперь действительно происходит.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should return alert when current == limit - 1', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create counter file
      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      // Create a log file for run_id extraction
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.type).toBe('retry_loop');
      expect(result.severity).toBe('warning');
      expect(result.message).toContain('task_attempts');
      expect(result.message).toContain('2');
      expect(result.message).toContain('3');
      expect(result.message).toContain('last attempt');
      expect(result.fingerprint).toContain('retry_loop');
      expect(result.fingerprint).toContain('task_attempts');
      expect(result.fingerprint).toContain('2');
      expect(result.suggested_actions).toEqual(['get_pipeline_log']);
      expect(result.detected_at).toBeDefined();
    });

    it('should return null when current < limit - 1', () => {
      const limit = 3;
      const current = 1;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create counter file with current=1, limit=3
      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
    });

    it('should return null when current == 0 (early stage)', () => {
      const limit = 3;
      const current = 0;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
    });

    it('should return null when counter value is missing from file', () => {
      const limit = 3;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create counter file without task_attempts
      fs.writeFileSync(countersPath, JSON.stringify({ some_other_counter: 5 }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
    });

    it('should return null when counter value is not a number', () => {
      const limit = 3;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create counter file with non-numeric value
      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: 'invalid' }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
    });

    it('should return null when counter file is invalid JSON', () => {
      const limit = 3;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create invalid JSON file
      fs.writeFileSync(countersPath, 'invalid json {', 'utf8');

      // Capture console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = detectRetryLoop(projectPath, {});

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to parse counter file')
      );
      warnSpy.mockRestore();
    });

    it('should extract run_id from latest log file', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      // Create multiple log files
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      fs.writeFileSync(oldLogPath, 'old log', 'utf8');
      fs.writeFileSync(newLogPath, 'new log', 'utf8');

      // Make old log actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('new-run');
    });

    it('should set run_id to unknown when logs directory cannot be read', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      // Remove logs directory
      fs.rmSync(logsDir, { recursive: true });

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('unknown');
    });

    it('should set run_id to unknown when no pipeline log files exist', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      // Create a non-pipeline log file
      fs.writeFileSync(path.join(logsDir, 'other.log'), 'not a pipeline log', 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('unknown');
    });

    it('should include detected_at timestamp in alert', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const beforeTime = new Date().toISOString();
      const result = detectRetryLoop(projectPath, {});
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
    });

    it('should extract project name from path', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.project).toBeDefined();
      // Project name should be the last segment of projectPath
      expect(result.project).toBe(path.basename(projectPath));
    });

    it('should include ticket_id in alert (initially empty)', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.ticket_id).toBe('');
    });

    it('should handle current == limit scenario correctly', () => {
      const limit = 3;
      const current = 3;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      // current == 3, limit == 3, so current !== limit - 1
      expect(result).toBeNull();
    });

    it('should correctly handle boundary case when limit is very small', () => {
      const limit = 1;
      const current = 0;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.message).toContain('0/1');
      expect(result.message).toContain('last attempt');
    });

    it('should handle multiple counters and focus on task_attempts', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      // Create counter file with multiple counters
      fs.writeFileSync(
        countersPath,
        JSON.stringify({
          task_attempts: current,
          other_counter: 10,
          another_counter: 5
        }),
        'utf8'
      );

      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain('task_attempts');
      expect(result.message).toContain('task_attempts');
    });

    it('should use empty thresholds object parameter safely', () => {
      const limit = 3;
      const current = 2;

      vi.spyOn(thresholds, 'getCounterLimit').mockReturnValue(limit);

      fs.writeFileSync(countersPath, JSON.stringify({ task_attempts: current }), 'utf8');

      // Call with empty thresholds object
      const result = detectRetryLoop(projectPath, {});

      expect(result).not.toBeNull();
      expect(result.type).toBe('retry_loop');
    });
  });
});
