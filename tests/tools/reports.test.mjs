import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { list_reports, get_report } from '../../src/tools/reports.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Tools: list_reports and get_report', () => {
  let testProjectDir;
  let originalCwd;
  let reportsDir;

  beforeAll(() => {
    // Setup test project directory
    testProjectDir = path.join(__dirname, '../../', 'test-project-reports');
    originalCwd = process.cwd();

    // Create test project structure
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testProjectDir, { recursive: true });

    // Create .workflow/reports directory
    reportsDir = path.join(testProjectDir, '.workflow', 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    // Create test reports with various timestamps
    const report1 = {
      id: 'REPORT-001',
      title: 'First Report',
      type: 'qa',
      created_at: '2026-04-25T10:00:00Z'
    };
    const report1Content = `---
id: ${report1.id}
title: ${report1.title}
type: ${report1.type}
created_at: ${report1.created_at}
---
First report body content`;
    fs.writeFileSync(path.join(reportsDir, 'REPORT-001.md'), report1Content, 'utf8');

    const report2 = {
      id: 'REPORT-002',
      title: 'Second Report (Latest)',
      type: 'impl',
      created_at: '2026-04-27T15:30:00Z'
    };
    const report2Content = `---
id: ${report2.id}
title: ${report2.title}
type: ${report2.type}
created_at: ${report2.created_at}
---
Second report body content with more details`;
    fs.writeFileSync(path.join(reportsDir, 'REPORT-002.md'), report2Content, 'utf8');

    const report3 = {
      id: 'REPORT-003',
      title: 'Third Report (Middle)',
      type: 'docs',
      created_at: '2026-04-26T12:00:00Z'
    };
    const report3Content = `---
id: ${report3.id}
title: ${report3.title}
type: ${report3.type}
created_at: ${report3.created_at}
---
Third report body`;
    fs.writeFileSync(path.join(reportsDir, 'REPORT-003.md'), report3Content, 'utf8');

    // Create report with empty frontmatter fields
    const report4 = `---
id: REPORT-004
title: Report without type
created_at: 2026-04-28T08:00:00Z
---
Fourth report body`;
    fs.writeFileSync(path.join(reportsDir, 'REPORT-004.md'), report4, 'utf8');

    // Change to test project directory
    process.chdir(testProjectDir);
  });

  afterAll(() => {
    // Restore original working directory
    process.chdir(originalCwd);

    // Cleanup test project
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  describe('list_reports', () => {
    it('should return all reports sorted by created_at DESC', async () => {
      const result = await list_reports.execute({ project: testProjectDir });

      const data = result;

      expect(data).toHaveLength(4);
      // Check sorting: latest first
      expect(data[0].id).toBe('REPORT-004'); // 2026-04-28
      expect(data[1].id).toBe('REPORT-002'); // 2026-04-27
      expect(data[2].id).toBe('REPORT-003'); // 2026-04-26
      expect(data[3].id).toBe('REPORT-001'); // 2026-04-25
    });

    it('should filter reports by created_at using since parameter', async () => {
      const result = await list_reports.execute({
        project: testProjectDir,
        since: '2026-04-26T00:00:00Z'
      });

      const data = result;

      // Should include only reports with created_at >= 2026-04-26
      expect(data).toHaveLength(3);
      expect(data.map(r => r.id)).toEqual(['REPORT-004', 'REPORT-002', 'REPORT-003']);
    });

    it('should respect limit parameter', async () => {
      const result = await list_reports.execute({
        project: testProjectDir,
        limit: 2
      });

      const data = result;

      expect(data).toHaveLength(2);
      expect(data[0].id).toBe('REPORT-004');
      expect(data[1].id).toBe('REPORT-002');
    });

    it('should return empty array when reports directory does not exist', async () => {
      const tempProject = path.join(testProjectDir, '..', 'test-empty-project');
      fs.mkdirSync(tempProject, { recursive: true });
      fs.mkdirSync(path.join(tempProject, '.workflow'), { recursive: true });

      try {
        const result = await list_reports.execute({ project: tempProject });

        const data = result;
        expect(data).toEqual([]);
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });

    it('should handle reports with partial frontmatter fields', async () => {
      // Reports with missing fields should still be included
      const result = await list_reports.execute({ project: testProjectDir });

      const data = result;

      // REPORT-004 has no 'type' field but should still be included
      const report4 = data.find(r => r.id === 'REPORT-004');
      expect(report4).toBeDefined();
      expect(report4.type).toBe('');  // empty type is OK
      expect(report4.title).toBe('Report without type');
    });

    it('should return object with required fields: id, title, type, created_at, path', async () => {
      const result = await list_reports.execute({ project: testProjectDir });
      const data = result;

      expect(data.length).toBeGreaterThan(0);
      const report = data[0];

      expect(report).toHaveProperty('id');
      expect(report).toHaveProperty('title');
      expect(report).toHaveProperty('type');
      expect(report).toHaveProperty('created_at');
      expect(report).toHaveProperty('path');
    });
  });

  describe('get_report', () => {
    it('should return report with valid report_id', async () => {
      const result = await get_report.execute({
        project: testProjectDir,
        report_id: 'REPORT-001'
      });

      const data = result;

      expect(data.frontmatter).toBeDefined();
      expect(data.frontmatter.id).toBe('REPORT-001');
      expect(data.frontmatter.title).toBe('First Report');
      expect(data.body).toContain('First report body content');
      expect(data.path).toContain('REPORT-001.md');
    });

    it('should return frontmatter and body separately', async () => {
      const result = await get_report.execute({
        project: testProjectDir,
        report_id: 'REPORT-002'
      });

      const data = result;

      expect(typeof data.frontmatter).toBe('object');
      expect(typeof data.body).toBe('string');
      expect(data.body.includes('---')).toBe(false); // Body should not contain frontmatter delimiters
    });

    it('should return error for non-existent report', async () => {
      await expect(get_report.execute({
        project: testProjectDir,
        report_id: 'NONEXISTENT'
      })).rejects.toThrow('Report not found');
    });

    it('should reject path traversal attack: ../../etc/passwd', async () => {
      await expect(get_report.execute({
        project: testProjectDir,
        report_id: '../../etc/passwd'
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('should reject path traversal attack with multiple dots: ..', async () => {
      await expect(get_report.execute({
        project: testProjectDir,
        report_id: '..\\REPORT-001'
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('should only accept alphanumeric and hyphen characters in report_id', async () => {
      const invalidIds = [
        'report_001',      // underscore
        'report 001',      // space
        'report/001',      // slash
        'report;001',      // semicolon
        'report(001)',     // parentheses
        '../../report',    // path traversal
        'report%20001'     // URL encoding
      ];

      for (const invalidId of invalidIds) {
        await expect(get_report.execute({
          project: testProjectDir,
          report_id: invalidId
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
    });

    it('should accept valid report_id formats: alphanumeric and hyphens only', async () => {
      const result = await get_report.execute({
        project: testProjectDir,
        report_id: 'REPORT-001'
      });

      expect(result.frontmatter.id).toBe('REPORT-001');
      expect(typeof result.body).toBe('string');
    });

    it('should return error for report with invalid frontmatter', async () => {
      // Create a report with invalid YAML in frontmatter
      const invalidFrontmatter = `---
invalid: [yaml: structure
---
Body content`;
      const invalidPath = path.join(reportsDir, 'INVALID-FM.md');
      fs.writeFileSync(invalidPath, invalidFrontmatter, 'utf8');

      try {
        await expect(get_report.execute({
          project: testProjectDir,
          report_id: 'INVALID-FM'
        })).rejects.toThrow();
      } finally {
        fs.unlinkSync(invalidPath);
      }
    });
  });

  describe('list_reports - filtering edge cases', () => {
    it('should handle since date at exact boundary', async () => {
      const result = await list_reports.execute({
        project: testProjectDir,
        since: '2026-04-26T12:00:00Z'
      });

      const data = result;

      // Should include REPORT-003 which has exactly this timestamp
      expect(data.some(r => r.id === 'REPORT-003')).toBe(true);
    });

    it('should return reports in consistent order across multiple calls', async () => {
      const result1 = await list_reports.execute({ project: testProjectDir });
      const result2 = await list_reports.execute({ project: testProjectDir });

      const data1 = result1;
      const data2 = result2;

      expect(data1.map(r => r.id)).toEqual(data2.map(r => r.id));
    });
  });

  describe('Integration: list and get together', () => {
    it('should be able to get reports returned from list', async () => {
      const listResult = await list_reports.execute({ project: testProjectDir });
      const listData = listResult;

      for (const reportMeta of listData) {
        const getResult = await get_report.execute({
          project: testProjectDir,
          report_id: reportMeta.id
        });

        const getData = getResult;

        expect(getData.frontmatter.id).toBe(reportMeta.id);
        expect(getData.frontmatter.title).toBe(reportMeta.title);
      }
    });
  });
});
