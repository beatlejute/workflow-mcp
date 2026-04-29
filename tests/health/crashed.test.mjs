import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectCrashed } from '../../src/health/detectors/crashed.mjs';
import * as pidCheck from '../../src/health/pid-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('crashed.mjs', () => {
  let testDir;
  let projectPath;
  let logsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'crashed-test-'));
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

  describe('detectCrashed', () => {
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

    it('should return null for dead PID with stale log', () => {
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

    it('should handle multiple PIDs and return alert for first dead one', () => {
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

    it('should return null when logs directory cannot be read', () => {
      const deadPid = 999999;
      fs.writeFileSync(path.join(logsDir, '.runner-pids'), `${deadPid}\n`, 'utf8');

      // Remove logs directory to simulate read error
      fs.rmSync(logsDir, { recursive: true });

      vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(() => false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).toBeNull();
    });

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
  });
});
