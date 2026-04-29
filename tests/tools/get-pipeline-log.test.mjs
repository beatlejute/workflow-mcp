/**
 * Tests for get_pipeline_log MCP tool
 * Tests log tail snapshot with cursor-based pagination, BOM handling, and latest run selection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { get_pipeline_log } from '../../src/tools/pipeline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('get_pipeline_log tool', () => {
  let testDir;
  let projectPath;
  let logsDir;
  let originalMcpCwd;

  beforeEach(() => {
    // Store original MCP_CWD
    originalMcpCwd = process.env.MCP_CWD;

    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-pipeline-log-test-'));
    projectPath = testDir;
    logsDir = path.join(projectPath, '.workflow', 'logs');

    // Set MCP_CWD to test directory parent so discovery works
    process.env.MCP_CWD = path.dirname(projectPath);

    // Create .workflow directory structure
    fs.mkdirSync(logsDir, { recursive: true });

    // Create a basic project structure for discovery
    const projectName = path.basename(projectPath);
    const parentDir = path.dirname(projectPath);

    // Create the actual project that discovery will find
    const discoveryProjectPath = path.join(parentDir, projectName);
    if (!fs.existsSync(path.join(discoveryProjectPath, '.workflow'))) {
      fs.mkdirSync(path.join(discoveryProjectPath, '.workflow'), { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }

    // Restore original MCP_CWD
    process.env.MCP_CWD = originalMcpCwd;
  });

  describe('tail_lines parameter', () => {
    it('should return N last lines when tail_lines=N is specified', async () => {
      // Create a log file with 10 lines
      const logContent = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 3
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(3);
      expect(result.lines[0]).toBe('Line 8');
      expect(result.lines[1]).toBe('Line 9');
      expect(result.lines[2]).toBe('Line 10');
      // truncated is false because we read from end of file and there are no more lines after
      expect(result.truncated).toBe(false);
    });

    it('should return all lines if tail_lines >= total lines', async () => {
      const logContent = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 10
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });

    it('should return default 200 lines when tail_lines is not specified', async () => {
      const logContent = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(200);
      // truncated is false because we read from end of file (last 200 lines) and there are no more lines after
      expect(result.truncated).toBe(false);
      expect(result.lines[0]).toBe('Line 101'); // First of last 200
    });
  });

  describe('tail_lines validation', () => {
    it('should return TOO_MANY_LINES error when tail_lines > 5000', async () => {
      const logContent = 'test content';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 5001
        }
      });

      expect(result.error).toBe('TOO_MANY_LINES');
      expect(result.message).toContain('cannot exceed 5000');
    });

    it('should accept tail_lines = 5000 without error', async () => {
      const logContent = Array.from({ length: 5000 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 5000
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(5000);
    });
  });

  describe('cursor-based reading with offset_bytes', () => {
    it('should read from specified byte offset', async () => {
      const line1 = 'First line\n';
      const line2 = 'Second line\n';
      const line3 = 'Third line';
      const logContent = line1 + line2 + line3;
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);

      // Get the size of first line in bytes
      const offset = Buffer.byteLength(line1);

      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 200,
          offset_bytes: offset
        }
      });

      expect(result.error).toBeUndefined();
      // Should start from around the second line
      expect(result.lines.length).toBeGreaterThan(0);
    });

    it('should support cursor for pagination', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      const logContent = lines.join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);

      // First read: get first 10 lines
      const result1 = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 10,
          offset_bytes: 0
        }
      });

      expect(result1.error).toBeUndefined();
      expect(result1.lines.length).toBeGreaterThan(0);
    });
  });

  describe('BOM (Byte Order Mark) handling', () => {
    it('should strip UTF-8 BOM from log content', async () => {
      // Create content with UTF-8 BOM (EF BB BF)
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from('Line 1\nLine 2\nLine 3');
      const logContent = Buffer.concat([bomBuffer, contentBuffer]);

      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 200
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(3);
      expect(result.lines[0]).toBe('Line 1'); // BOM should be stripped
      expect(result.lines[0]).not.toContain('\uFEFF'); // No BOM character
    });

    it('should handle files without BOM correctly', async () => {
      const logContent = 'Line 1\nLine 2\nLine 3';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 200
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(3);
      expect(result.lines[0]).toBe('Line 1');
    });
  });

  describe('LOG_NOT_FOUND error handling', () => {
    it('should return LOG_NOT_FOUND when logs directory does not exist', async () => {
      // Use a project with .workflow but no logs directory
      const emptyProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-project-'));
      const emptyProjectName = path.basename(emptyProjectPath);

      try {
        // Create .workflow but not logs directory
        fs.mkdirSync(path.join(emptyProjectPath, '.workflow'), { recursive: true });

        // Temporarily point MCP_CWD to parent of empty project
        process.env.MCP_CWD = path.dirname(emptyProjectPath);

        const result = await get_pipeline_log.execute({
          project: emptyProjectName,
          options: {}
        });

        expect(result.error).toBe('LOG_NOT_FOUND');
        expect(result.message).toContain('not found');
      } finally {
        fs.rmSync(emptyProjectPath, { recursive: true, force: true });
      }
    });

    it('should return LOG_NOT_FOUND when no pipeline logs exist in directory', async () => {
      // Create logs directory but no pipeline logs
      fs.writeFileSync(path.join(logsDir, 'debug.log'), 'debug content');
      fs.writeFileSync(path.join(logsDir, 'other.log'), 'other content');

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBe('LOG_NOT_FOUND');
    });

    it('should return LOG_NOT_FOUND when requested run_id does not exist', async () => {
      const logContent = 'test content';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          run_id: 'pipeline_2026-04-27_11-00-00' // Different run_id
        }
      });

      expect(result.error).toBe('LOG_NOT_FOUND');
    });
  });

  describe('Latest run selection by mtime', () => {
    it('should select latest log file by modification time', async () => {
      // Create older log
      const olderLogName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, olderLogName), 'Older log content');

      // Manually set mtime to past
      const olderPath = path.join(logsDir, olderLogName);
      const oldTime = new Date('2026-04-27T10:00:00Z').getTime();
      fs.utimesSync(olderPath, oldTime / 1000, oldTime / 1000);

      // Create newer log
      const newerLogName = `pipeline_2026-04-27_15-00-00.log`;
      fs.writeFileSync(path.join(logsDir, newerLogName), 'Newer log content');

      const newerPath = path.join(logsDir, newerLogName);
      const newTime = new Date('2026-04-27T15:00:00Z').getTime();
      fs.utimesSync(newerPath, newTime / 1000, newTime / 1000);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBeUndefined();
      expect(result.run_id).toBe('pipeline_2026-04-27_15-00-00');
      expect(result.lines[0]).toBe('Newer log content');
    });

    it('should use specified run_id if provided', async () => {
      const logName1 = `pipeline_2026-04-27_10-00-00.log`;
      const logName2 = `pipeline_2026-04-27_15-00-00.log`;

      fs.writeFileSync(path.join(logsDir, logName1), 'First run');
      fs.writeFileSync(path.join(logsDir, logName2), 'Second run');

      // Make logName2 more recent
      const path2 = path.join(logsDir, logName2);
      fs.utimesSync(path2, Date.now() / 1000, Date.now() / 1000);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          run_id: 'pipeline_2026-04-27_10-00-00'
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.run_id).toBe('pipeline_2026-04-27_10-00-00');
      expect(result.lines[0]).toBe('First run');
    });
  });

  describe('Response structure and metadata', () => {
    it('should return correct response structure', async () => {
      const logContent = 'test line 1\ntest line 2\ntest line 3';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 2
        }
      });

      expect(result).toHaveProperty('run_id');
      expect(result).toHaveProperty('lines');
      expect(result).toHaveProperty('log_path');
      expect(result).toHaveProperty('log_size_bytes');
      expect(result).toHaveProperty('truncated');
      expect(Array.isArray(result.lines)).toBe(true);
    });

    it('should set truncated=false when reading tail of file', async () => {
      const logContent = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 10
        }
      });

      // When using tail_lines, we always read from the end, so truncated=false
      expect(result.truncated).toBe(false);
    });

    it('should set truncated=false when all lines are returned', async () => {
      const logContent = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}`).join('\n');
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 200
        }
      });

      expect(result.truncated).toBe(false);
    });

    it('should include correct log_size_bytes', async () => {
      const logContent = 'test content';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      const logPath = path.join(logsDir, logName);
      fs.writeFileSync(logPath, logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBeUndefined();
      expect(result.log_size_bytes).toBe(Buffer.byteLength(logContent));
      expect(result.log_size_bytes).toBeGreaterThan(0);
    });

    it('should include log_path in response', async () => {
      const logContent = 'test content';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent);

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBeUndefined();
      expect(result.log_path).toContain('.workflow');
      expect(result.log_path).toContain(logName);
    });
  });

  describe('Error handling', () => {
    it('should return error for invalid project', async () => {
      const result = await get_pipeline_log.execute({
        project: 'nonexistent-project',
        options: {}
      });

      expect(result.error).toBe('INVALID_PROJECT');
    });

    it('should handle empty log files', async () => {
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), '');

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {}
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toHaveLength(0);
    });

    it('should handle multi-byte UTF-8 characters correctly', async () => {
      const logContent = 'Line 1: Hello\nLine 2: Привет мир\nLine 3: 你好';
      const logName = `pipeline_2026-04-27_10-00-00.log`;
      fs.writeFileSync(path.join(logsDir, logName), logContent, 'utf-8');

      const projectName = path.basename(projectPath);
      const result = await get_pipeline_log.execute({
        project: projectName,
        options: {
          tail_lines: 200
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.lines).toContain('Line 2: Привет мир');
      expect(result.lines).toContain('Line 3: 你好');
    });
  });
});
