import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectCrashed } from '../../../src/health/detectors/crashed.mjs';
import * as pidCheck from '../../../src/health/pid-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('detectCrashed (tests/health/detectors/crashed.test.mjs)', () => {
  let testDir;
  let projectPath;
  let logsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'crashed-detector-test-'));
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
    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('Basic functionality', () => {
    it('should return null when .runner-pids does not exist', () => {
      const result = detectCrashed(projectPath, {});
      expect(result).toBeNull();
    });

    it('should return null when .runner-pids is empty', () => {
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), '', 'utf8');
      const result = detectCrashed(projectPath, {});
      expect(result).toBeNull();
    });

    it('should return null when .runner-pids contains only comments', () => {
      const pidsContent = '# Comment line\n# Another comment\n';
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');
      const result = detectCrashed(projectPath, {});
      expect(result).toBeNull();
    });

    it('should return null when .runner-pids contains invalid lines', () => {
      const pidsContent = 'abc\n\n123notvalid\n  \n';
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');
      const result = detectCrashed(projectPath, {});
      expect(result).toBeNull();
    });

    it('should return null when all PIDs are alive', () => {
      // Use current process PID (known to be alive)
      const pidsContent = `${process.pid}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      // Create a fresh log file
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });
  });

  describe('Dead PID detection', () => {
    it('should return alert for dead PID with fresh log', () => {
      // Use a non-existent PID
      const deadPid = 999999;
      const pidsContent = `${deadPid}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      // Create a fresh log file
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      // Mock isProcessAlive to return false for our test PID
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => {
        return pid !== deadPid;
      });

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.type).toBe('crashed');
      expect(result.severity).toBe('critical');
      expect(result.pid).toBe(deadPid);
      expect(result.fingerprint).toContain('crashed');
      expect(result.fingerprint).toContain(String(deadPid));
      expect(result.message).toContain(String(deadPid));
      expect(result.suggested_actions).toEqual(['get_pipeline_log', 'restart_pipeline']);
    });

    it('should return null for dead PID with stale log (old mtime)', () => {
      const deadPid = 999999;
      const pidsContent = `${deadPid}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      // Create an old log file (more than 60 seconds old)
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');
      const oldMtime = Date.now() - 120000; // 2 minutes ago
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      // Mock isProcessAlive to return false for our test PID
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => {
        return pid !== deadPid;
      });

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });

    it('should handle multiple PIDs and return alert for first dead one with fresh log', () => {
      const livePid = process.pid;
      const deadPid = 999999;
      const pidsContent = `${livePid}\n${deadPid}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      // Create a fresh log
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      // Mock isProcessAlive
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => {
        return pid === livePid;
      });

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.pid).toBe(deadPid);
    });

    it('should return null when multiple PIDs but all are alive', () => {
      const livePid1 = process.pid;
      const livePid2 = process.pid + 1;
      const pidsContent = `${livePid1}\n${livePid2}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      // Create a fresh log
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      // Mock isProcessAlive to return true for all
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => true);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });
  });

  describe('Whitespace and format handling', () => {
    it('should handle whitespace in .runner-pids correctly', () => {
      const deadPid = 999999;
      const pidsContent = `  \n${deadPid}  \n \n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.pid).toBe(deadPid);
    });
  });

  describe('Configuration handling', () => {
    it('should use default freshness (60 sec) when not specified', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Create a log that's 50 seconds old (fresh with default 60-sec threshold)
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');
      const oldMtime = Date.now() - 50000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      // Call without config
      const result = detectCrashed(projectPath, {});
      expect(result).not.toBeNull();
    });

    it('should respect custom crash_mtime_freshness_sec configuration', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Create a log that's 150 seconds old
      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');
      const oldMtime = Date.now() - 150000;
      fs.utimesSync(logPath, oldMtime / 1000, oldMtime / 1000);

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      // With custom 200-sec threshold, should return alert
      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 200 });
      expect(result).not.toBeNull();
    });
  });

  describe('Log file handling', () => {
    it('should find most recent log when multiple exist', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Create multiple log files
      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      fs.writeFileSync(oldLogPath, 'old log', 'utf8');
      fs.writeFileSync(newLogPath, 'new log', 'utf8');

      // Make old log actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('new-run');
    });

    it('should return null when logs directory cannot be read', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Remove logs directory to simulate read error
      fs.rmSync(logsDir, { recursive: true });

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });

    it('should return null when no pipeline logs exist', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Create a non-pipeline log file
      fs.writeFileSync(path.join(logsDir, 'other.log'), 'other log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });
  });

  describe('Alert object properties', () => {
    it('should include detected_at timestamp in alert', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const beforeTime = new Date().toISOString();
      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
    });

    it('should include project name in fingerprint and alert', () => {
      // Create a project with a specific name
      const projectName = 'my-test-project';
      const namedTestDir = path.join('/tmp', 'crashed-detector-test-', projectName);
      const namedLogsDir = path.join(namedTestDir, '.workflow', 'logs');
      fs.mkdirSync(namedLogsDir, { recursive: true });

      const deadPid = 999999;
      fs.writeFileSync(path.join(namedLogsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      const logPath = path.join(namedLogsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(namedTestDir, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain(projectName);
      expect(result.project).toBe(projectName);

      // Cleanup
      fs.rmSync(namedTestDir, { recursive: true, force: true });
    });
  });

  describe('Windows platform support', () => {
    it('should work with Windows-specific isProcessAlive behavior (mocked)', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      // Mock Windows tasklist response: "No tasks running"
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => {
        if (pid === deadPid) {
          // Simulate Windows tasklist command returning "No tasks running"
          return false;
        }
        return true;
      });

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.pid).toBe(deadPid);
      expect(result.type).toBe('crashed');
    });

    it('should handle multiple PIDs with Windows mock where some are dead', () => {
      const livePid1 = 100;
      const deadPid1 = 200;
      const deadPid2 = 300;
      const pidsContent = `${livePid1}\n${deadPid1}\n${deadPid2}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      // Mock Windows behavior: only livePid1 is alive
      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => {
        return pid === livePid1;
      });

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      // Should return alert for first dead PID
      expect(result).not.toBeNull();
      expect([deadPid1, deadPid2]).toContain(result.pid);
    });
  });

  describe('Edge cases', () => {
    it('should handle negative PIDs gracefully', () => {
      const pidsContent = '-1\n-100\n';
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      const result = detectCrashed(projectPath, {});
      expect(result).toBeNull();
    });

    it('should handle very large PID numbers', () => {
      const largePid = 2147483647; // Max 32-bit int
      const pidsContent = `${largePid}\n`;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).not.toBeNull();
      expect(result.pid).toBe(largePid);
    });

    it('should handle floating-point PID values (should be ignored)', () => {
      const pidsContent = '123.456\n789\n';
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), pidsContent, 'utf8');

      const logPath = path.join(logsDir, 'pipeline_test-run-1.log');
      fs.writeFileSync(logPath, 'test log', 'utf8');

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => pid !== 789);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      // Should only detect issue with valid PID 789
      expect(result).not.toBeNull();
      expect(result.pid).toBe(789);
    });
  });
});
