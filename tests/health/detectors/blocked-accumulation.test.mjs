import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectBlockedAccumulation } from '../../../src/health/detectors/blocked-accumulation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('blocked-accumulation.mjs', () => {
  let testDir;
  let projectPath;
  let blockedDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'blocked-test-'));
    projectPath = testDir;
    blockedDir = path.join(projectPath, '.workflow', 'tickets', 'blocked');

    // Create .workflow/tickets/blocked directory
    fs.mkdirSync(blockedDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
  });

  describe('detectBlockedAccumulation', () => {
    it('should return null when blocked directory does not exist', () => {
      // Remove the blocked directory
      fs.rmSync(blockedDir, { recursive: true });

      const result = detectBlockedAccumulation(projectPath, 5);
      expect(result).toBeNull();
    });

    it('should return null when blocked directory is empty', () => {
      const result = detectBlockedAccumulation(projectPath, 5);
      expect(result).toBeNull();
    });

    it('should return null when ticket count is below threshold', () => {
      // Create 4 ticket files
      for (let i = 1; i <= 4; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);
      expect(result).toBeNull();
    });

    it('should return alert when ticket count equals threshold', () => {
      // Create 5 ticket files (exactly at threshold)
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.type).toBe('blocked_accumulation');
      expect(result.severity).toBe('warning');
      expect(result.message).toContain('5 tickets blocked');
      expect(result.message).toContain('threshold: 5');
    });

    it('should return alert when ticket count exceeds threshold', () => {
      // Create 6 ticket files
      for (let i = 1; i <= 6; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.type).toBe('blocked_accumulation');
      expect(result.severity).toBe('warning');
      expect(result.message).toContain('6 tickets blocked');
      expect(result.message).toContain('threshold: 5');
    });

    it('should not count .gitkeep file in ticket count', () => {
      // Create 4 ticket files + .gitkeep
      for (let i = 1; i <= 4; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }
      fs.writeFileSync(path.join(blockedDir, '.gitkeep'), '', 'utf8');

      const result = detectBlockedAccumulation(projectPath, 5);

      // 4 tickets + .gitkeep (not counted) = 4, which is below threshold 5
      expect(result).toBeNull();
    });

    it('should not count README.md file in ticket count', () => {
      // Create 4 ticket files + README.md
      for (let i = 1; i <= 4; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }
      fs.writeFileSync(path.join(blockedDir, 'README.md'), 'readme', 'utf8');

      const result = detectBlockedAccumulation(projectPath, 5);

      // 4 tickets + README.md (not counted) = 4, which is below threshold 5
      expect(result).toBeNull();
    });

    it('should handle mixed ticket prefixes correctly', () => {
      // Create tickets with different prefixes
      fs.writeFileSync(path.join(blockedDir, 'QA-1.md'), 'content', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'IMPL-2.md'), 'content', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'PLAN-3.md'), 'content', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'DOC-4.md'), 'content', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'TEST-5.md'), 'content', 'utf8');

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.message).toContain('5 tickets blocked');
    });

    it('should only count files matching ticket pattern ^[A-Z]+-\\d+\\.md$', () => {
      // Create valid ticket files
      fs.writeFileSync(path.join(blockedDir, 'QA-1.md'), 'content', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'QA-2.md'), 'content', 'utf8');

      // Create invalid files that should not be counted
      fs.writeFileSync(path.join(blockedDir, 'qa-3.md'), 'content', 'utf8'); // lowercase prefix
      fs.writeFileSync(path.join(blockedDir, 'QA3.md'), 'content', 'utf8'); // no hyphen
      fs.writeFileSync(path.join(blockedDir, 'QA-.md'), 'content', 'utf8'); // no number
      fs.writeFileSync(path.join(blockedDir, 'QA-1.txt'), 'content', 'utf8'); // wrong extension
      fs.writeFileSync(path.join(blockedDir, '.gitkeep'), '', 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'notes.md'), 'content', 'utf8');

      const result = detectBlockedAccumulation(projectPath, 5);

      // Only 2 valid ticket files, which is below threshold 5
      expect(result).toBeNull();
    });

    it('should include fingerprint in alert', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.fingerprint).toBeDefined();
      expect(result.fingerprint).toContain('blocked_accumulation');
      expect(result.fingerprint).toContain('5');
    });

    it('should include detected_at timestamp in alert', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const beforeTime = new Date().toISOString();
      const result = detectBlockedAccumulation(projectPath, 5);
      const afterTime = new Date().toISOString();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      expect(result.detected_at >= beforeTime).toBe(true);
      expect(result.detected_at <= afterTime).toBe(true);
    });

    it('should include suggested_actions in alert', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.suggested_actions).toBeDefined();
      expect(Array.isArray(result.suggested_actions)).toBe(true);
      expect(result.suggested_actions).toContain('get_pipeline_log');
    });

    it('should extract project name from path', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.project).toBeDefined();
      // Project name should be the last directory in the path
      expect(result.fingerprint).toContain(result.project);
    });

    it('should use run_id "unknown" when no logs directory exists', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('unknown');
    });

    it('should extract run_id from most recent pipeline log', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      // Create .workflow/logs directory with pipeline log
      const logsDir = path.join(projectPath, '.workflow', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'pipeline_test-run-123.log'), 'log content', 'utf8');

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('test-run-123');
    });

    it('should use most recent pipeline log when multiple exist', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      // Create .workflow/logs directory with multiple pipeline logs
      const logsDir = path.join(projectPath, '.workflow', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const oldLogPath = path.join(logsDir, 'pipeline_old-run.log');
      const newLogPath = path.join(logsDir, 'pipeline_new-run.log');

      fs.writeFileSync(oldLogPath, 'old log', 'utf8');
      fs.writeFileSync(newLogPath, 'new log', 'utf8');

      // Make old log actually old
      const oldMtime = Date.now() - 100000;
      fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.run_id).toBe('new-run');
    });

    it('should have empty ticket_id in alert', () => {
      // Create 5 ticket files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      const result = detectBlockedAccumulation(projectPath, 5);

      expect(result).not.toBeNull();
      expect(result.ticket_id).toBe('');
    });

    it('should handle different thresholds correctly', () => {
      // Create 3 ticket files
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(blockedDir, `QA-${i}.md`), 'content', 'utf8');
      }

      // threshold 3 → should alert
      expect(detectBlockedAccumulation(projectPath, 3)).not.toBeNull();

      // threshold 4 → should not alert
      expect(detectBlockedAccumulation(projectPath, 4)).toBeNull();
    });
  });
});
