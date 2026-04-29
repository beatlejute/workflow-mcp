import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { list_ghost_executions, list_blocked_tickets } from '../../src/tools/diagnostics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('list_ghost_executions', () => {
  let testDir;
  let projectPath;
  let logsDir;
  let originalMcpCwd;

  beforeEach(() => {
    // Store original MCP_CWD
    originalMcpCwd = process.env.MCP_CWD;

    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'ghost-executions-test-'));
    projectPath = testDir;
    logsDir = path.join(projectPath, '.workflow', 'logs');

    // Set MCP_CWD to test directory
    process.env.MCP_CWD = projectPath;

    // Create .workflow directory structure
    fs.mkdirSync(path.join(projectPath, '.workflow'), { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Create a basic MCP config file (.workflow-mcp.yaml at project root)
    fs.writeFileSync(path.join(projectPath, '.workflow-mcp.yaml'), 'health:\n  ghost_execution_log_marker: "ghost-execution"\n');
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

  describe('Tool registration and basic functionality', () => {
    it('should return empty results when no ghost executions found', async () => {
      const result = await list_ghost_executions.execute({});
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      
      expect(data.project_filter).toBe('all');
      expect(data.count).toBe(0);
      expect(data.executions).toEqual([]);
      expect(data.truncated).toBe(false);
    });

    it('should return empty results when no pipeline logs exist', async () => {
      // Create other files but not pipeline logs
      fs.writeFileSync(path.join(logsDir, 'other.log'), 'some content');
      fs.writeFileSync(path.join(logsDir, 'debug.log'), 'debug content');

      const result = await list_ghost_executions.execute({});
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      
      expect(data.count).toBe(0);
      expect(data.executions).toEqual([]);
    });

    it('should detect ghost execution in pipeline log', async () => {
      const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
[PipelineRunner] Current stage: build
[PipelineRunner] START stage="build" agent="builder"
Context:
ticket_id: IMPL-1
[PipelineRunner] Step 1 output
ghost-execution
[PipelineRunner] Step 1 output continued
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0
[2026-04-27 19:20:00] [INFO] [PipelineRunner] Step 2
[PipelineRunner] Current stage: test
[PipelineRunner] START stage="test" agent="tester"
Context:
ticket_id: IMPL-2
[PipelineRunner] Step 2 output
[PipelineRunner] COMPLETE stage="test" status="success" exitCode=0`;

      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      const result = await list_ghost_executions.execute({});
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      
      expect(data.count).toBe(1);
      expect(data.executions).toHaveLength(1);
      expect(data.executions[0]).toEqual({
        project: path.basename(projectPath),
        run_id: 'run-123',
        step_number: 1,
        ticket_id: 'IMPL-1',
        log_excerpt: expect.stringContaining('ghost-execution'),
        detected_at: expect.any(String)
      });
      expect(data.truncated).toBe(false);
    });

    it('should filter by project when project parameter provided', async () => {
      // Create second project
      const testDir2 = fs.mkdtempSync(path.join('/tmp', 'ghost-executions-test2-'));
      const projectPath2 = testDir2;
      const logsDir2 = path.join(projectPath2, '.workflow', 'logs');

      fs.mkdirSync(path.join(projectPath2, '.workflow'), { recursive: true });
      fs.mkdirSync(logsDir2, { recursive: true });
      fs.writeFileSync(path.join(projectPath2, '.workflow-mcp.yaml'), 'health:\n  ghost_execution_log_marker: "ghost-execution"\n');

      // Add ghost execution to second project only
      const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
ghost-execution
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

      fs.writeFileSync(path.join(logsDir2, 'pipeline_run-456.log'), logContent, 'utf8');

      // Test with first project (should have no results)
      const result1 = await list_ghost_executions.execute({ project: projectPath });
      expect(JSON.parse(result1.content[0].text).count).toBe(0);

      // Test with second project (should have results)
      const result2 = await list_ghost_executions.execute({ project: projectPath2 });
      expect(JSON.parse(result2.content[0].text).count).toBe(1);

      // Clean up second project
      fs.rmSync(testDir2, { recursive: true, force: true });
    });

    it('should filter by since parameter', async () => {
      // The key test here is that the mtime-based filtering works
      // File mtimes are set by fs.utimesSync and compared directly, without timezone issues

      const oldLogContent = `[2026-01-01 00:00:00] [INFO] [PipelineRunner] Step 1
ghost-execution
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

      const newLogContent = `[2026-12-31 23:59:59] [INFO] [PipelineRunner] Step 1
ghost-execution
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

      const oldLogPath = path.join(logsDir, 'pipeline_old.log');
      const newLogPath = path.join(logsDir, 'pipeline_new.log');

      fs.writeFileSync(oldLogPath, oldLogContent, 'utf8');
      fs.writeFileSync(newLogPath, newLogContent, 'utf8');

      // Set file mtimes to be far apart (Jan 1 and May 1)
      const oldMtimeMs = new Date('2026-01-15T00:00:00Z').getTime();
      fs.utimesSync(oldLogPath, oldMtimeMs / 1000, oldMtimeMs / 1000);

      const newMtimeMs = new Date('2026-05-15T00:00:00Z').getTime();
      fs.utimesSync(newLogPath, newMtimeMs / 1000, newMtimeMs / 1000);

      // Test without since filter (should find both)
      const result1 = await list_ghost_executions.execute({});
      expect(JSON.parse(result1.content[0].text).count).toBe(2);

      // Test with since=Apr 1 filter - should find only new log (mtime=May 15)
      const result2 = await list_ghost_executions.execute({
        since: '2026-04-01T00:00:00Z'
      });
      expect(JSON.parse(result2.content[0].text).count).toBe(1);

      // Test with future since filter (should find none)
      const result3 = await list_ghost_executions.execute({
        since: '2026-06-01T00:00:00Z'
      });
      expect(JSON.parse(result3.content[0].text).count).toBe(0);
    });

    it('should respect result limit of 100', async () => {
      // Create multiple log files with ghost executions
      for (let i = 0; i < 105; i++) {
        const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
ghost-execution
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

        fs.writeFileSync(
          path.join(logsDir, `pipeline_run-${String(i).padStart(3, '0')}.log`),
          logContent,
          'utf8'
        );
      }

      const result = await list_ghost_executions.execute({});
      const data = JSON.parse(result.content[0].text);

      // When results reach MAX_RESULTS (100), the count should be 100 and truncated=true
      expect(data.count).toBe(100);
      expect(data.executions).toHaveLength(100);
      expect(data.truncated).toBe(true);
    });

    it('should return correct log excerpt with ±5 lines', async () => {
      const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
Line 1
Line 2
Line 3
Line 4
Line 5
[PipelineRunner] Current stage: build
[PipelineRunner] START stage="build" agent="builder"
Context:
ticket_id: IMPL-1
[PipelineRunner] Step 1 output
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
Line 14
Line 15
ghost-execution
Line 16
Line 17
Line 18
Line 19
Line 20
Line 21
Line 22
Line 23
Line 24
Line 25
Line 26
Line 27
Line 28
Line 29
Line 30
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0
[2026-04-27 19:20:00] [INFO] [PipelineRunner] Step 2
Line 31
Line 32
Line 33
Line 34
Line 35
Line 36
Line 37
Line 38
Line 39
Line 40`;

      const logPath = path.join(logsDir, 'pipeline_run-123.log');
      fs.writeFileSync(logPath, logContent, 'utf8');

      const result = await list_ghost_executions.execute({});
      const data = JSON.parse(result.content[0].text);

      expect(data.executions).toHaveLength(1);
      const excerpt = data.executions[0].log_excerpt;

      // Check that excerpt is approximately ±5 lines around the marker
      const lines = excerpt.split('\n').filter(l => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(10); // at least ±5 lines
      expect(excerpt).toContain('ghost-execution');

      // Verify the excerpt contains nearby content (not content from far away)
      expect(excerpt).toContain('Line 15');
      expect(excerpt).toContain('Line 16');
    });

    it('should handle custom ghost execution marker from config', async () => {
      // Update config with custom marker (write to .workflow-mcp.yaml at project root)
      fs.writeFileSync(
        path.join(projectPath, '.workflow-mcp.yaml'),
        'health:\n  ghost_execution_log_marker: "custom-ghost-marker"\n'
      );

      const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
custom-ghost-marker
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

      fs.writeFileSync(path.join(logsDir, 'pipeline_run-123.log'), logContent, 'utf8');

      const result = await list_ghost_executions.execute({});
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(1);
      expect(data.executions[0].log_excerpt).toContain('custom-ghost-marker');
    });

    it('should handle error gracefully when project not found', async () => {
      const result = await list_ghost_executions.execute({
        project: '/nonexistent/path'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.isError).toBe(true);

      // Error message is returned as plain text, not JSON
      const errorText = result.content[0].text;
      expect(errorText).toContain('Error executing tool');
      expect(errorText).toContain('Project not found');
    });

    it('should return proper structure with all required fields', async () => {
      const logContent = `[2026-04-27 19:19:00] [INFO] [PipelineRunner] Step 1
[PipelineRunner] Current stage: build
[PipelineRunner] START stage="build" agent="builder"
Context:
ticket_id: IMPL-1
[PipelineRunner] Step 1 output
ghost-execution
[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;

      fs.writeFileSync(path.join(logsDir, 'pipeline_run-123.log'), logContent, 'utf8');

      const result = await list_ghost_executions.execute({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveProperty('project_filter', 'all');
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('truncated');
      expect(data).toHaveProperty('executions');
      expect(Array.isArray(data.executions)).toBe(true);

      const execution = data.executions[0];
      expect(execution).toHaveProperty('project');
      expect(execution).toHaveProperty('run_id');
      expect(execution).toHaveProperty('step_number');
      expect(execution).toHaveProperty('ticket_id');
      expect(execution).toHaveProperty('log_excerpt');
      expect(execution).toHaveProperty('detected_at');
    });
  });
});

describe('list_blocked_tickets', () => {
  let testDir;
  let projectPath;
  let ticketsDir;
  let blockedDir;
  let originalMcpCwd;

  beforeEach(() => {
    // Store original MCP_CWD
    originalMcpCwd = process.env.MCP_CWD;

    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'blocked-tickets-test-'));
    projectPath = testDir;
    ticketsDir = path.join(projectPath, '.workflow', 'tickets');
    blockedDir = path.join(ticketsDir, 'blocked');

    // Set MCP_CWD to test directory
    process.env.MCP_CWD = projectPath;

    // Create .workflow directory structure
    fs.mkdirSync(blockedDir, { recursive: true });
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

  describe('Single project with 3 blocked tickets', () => {
    it('should return 3 records when one project has 3 blocked tickets', async () => {
      // Create 3 blocked tickets
      const ticket1 = `---
id: BLOCKED-001
title: Feature A blocked
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
blocked_reason: "Waiting for feature B"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Dependency on feature B not ready"
---
## Description
This is blocked ticket 1`;

      const ticket2 = `---
id: BLOCKED-002
title: Feature B blocked
created_at: "2026-04-27T11:00:00Z"
updated_at: "2026-04-27T13:00:00Z"
events:
  - timestamp: "2026-04-27T13:00:00Z"
    reason: "API not available"
---
## Description
This is blocked ticket 2`;

      const ticket3 = `---
id: BLOCKED-003
title: Feature C blocked
created_at: "2026-04-27T09:00:00Z"
updated_at: "2026-04-27T14:00:00Z"
events:
  - timestamp: "2026-04-27T14:00:00Z"
    message: "Infrastructure issue"
---
## Description
This is blocked ticket 3`;

      fs.writeFileSync(path.join(blockedDir, 'BLOCKED-001.md'), ticket1, 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'BLOCKED-002.md'), ticket2, 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'BLOCKED-003.md'), ticket3, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(3);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('title');
      expect(result[0]).toHaveProperty('blocked_reason');
      expect(result[0]).toHaveProperty('age_sec');
      expect(result[0]).toHaveProperty('project');
    });
  });

  describe('Sorting by age_sec DESC (oldest first)', () => {
    it('should sort tickets by age_sec in descending order', async () => {
      const now = new Date();
      const ticket1CreatedAt = new Date(now.getTime() - 3600000); // 1 hour ago
      const ticket2CreatedAt = new Date(now.getTime() - 7200000); // 2 hours ago
      const ticket3CreatedAt = new Date(now.getTime() - 1800000); // 30 minutes ago

      const ticket1 = `---
id: BLK-001
title: Oldest
created_at: "${ticket2CreatedAt.toISOString()}"
updated_at: "${ticket2CreatedAt.toISOString()}"
events:
  - timestamp: "${ticket2CreatedAt.toISOString()}"
    reason: "Oldest blocked"
---
Content`;

      const ticket2 = `---
id: BLK-002
title: Middle
created_at: "${ticket1CreatedAt.toISOString()}"
updated_at: "${ticket1CreatedAt.toISOString()}"
events:
  - timestamp: "${ticket1CreatedAt.toISOString()}"
    reason: "Middle blocked"
---
Content`;

      const ticket3 = `---
id: BLK-003
title: Newest
created_at: "${ticket3CreatedAt.toISOString()}"
updated_at: "${ticket3CreatedAt.toISOString()}"
events:
  - timestamp: "${ticket3CreatedAt.toISOString()}"
    reason: "Newest blocked"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'BLK-001.md'), ticket1, 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'BLK-002.md'), ticket2, 'utf8');
      fs.writeFileSync(path.join(blockedDir, 'BLK-003.md'), ticket3, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(3);
      // Check that age_sec is in descending order (oldest first)
      expect(result[0].id).toBe('BLK-001'); // 2 hours ago - oldest
      expect(result[1].id).toBe('BLK-002'); // 1 hour ago
      expect(result[2].id).toBe('BLK-003'); // 30 minutes ago - newest

      // Verify age_sec values are descending
      expect(result[0].age_sec).toBeGreaterThan(result[1].age_sec);
      expect(result[1].age_sec).toBeGreaterThan(result[2].age_sec);
    });
  });

  describe('blocked_reason extraction from events', () => {
    it('should extract blocked_reason from last event in events array', async () => {
      const ticket = `---
id: EVT-001
title: Test event extraction
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T10:30:00Z"
    reason: "First reason"
  - timestamp: "2026-04-27T11:00:00Z"
    reason: "Second reason"
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Third reason - this should be extracted"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'EVT-001.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].blocked_reason).toBe('Third reason - this should be extracted');
    });

    it('should use message field from last event if reason is missing', async () => {
      const ticket = `---
id: EVT-002
title: Test message field
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    message: "Using message field"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'EVT-002.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].blocked_reason).toBe('Using message field');
    });

    it('should use note field from last event if both reason and message are missing', async () => {
      const ticket = `---
id: EVT-003
title: Test note field
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    note: "Using note field"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'EVT-003.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].blocked_reason).toBe('Using note field');
    });

    it('should fallback to blocked_reason field if events array is empty', async () => {
      const ticket = `---
id: EVT-004
title: Test blocked_reason field
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
blocked_reason: "Fallback reason from frontmatter"
events: []
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'EVT-004.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].blocked_reason).toBe('Fallback reason from frontmatter');
    });
  });

  describe('Invalid frontmatter handling', () => {
    it('should skip ticket with malformed YAML and log warning', async () => {
      const malformedTicket = `---
id: BAD-001
title: Malformed ticket
created_at: "2026-04-27T10:00:00Z"
invalid yaml: [this: is: broken:
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'BAD-001.md'), malformedTicket, 'utf8');

      // Create one valid ticket too
      const validTicket = `---
id: GOOD-001
title: Valid ticket
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Valid reason"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'GOOD-001.md'), validTicket, 'utf8');

      // Capture stderr to verify warning
      const originalWarn = console.warn;
      let warnCalled = false;
      console.warn = (msg) => {
        if (msg.includes('Skipping malformed')) {
          warnCalled = true;
        }
      };

      try {
        const result = await list_blocked_tickets({ project: projectPath });

        // Should have only the valid ticket
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('GOOD-001');
        expect(warnCalled).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('Multiple projects aggregation', () => {
    it('should aggregate blocked tickets from multiple projects', async () => {
      // Create first project
      const project1Path = testDir;
      const project1BlockedDir = path.join(project1Path, '.workflow', 'tickets', 'blocked');
      fs.mkdirSync(project1BlockedDir, { recursive: true });

      const ticket1_1 = `---
id: PROJ1-BLK-001
title: Project 1 blocked 1
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Project 1 reason"
---
Content`;

      fs.writeFileSync(path.join(project1BlockedDir, 'PROJ1-BLK-001.md'), ticket1_1, 'utf8');

      // Create second project (sibling)
      const project2Path = path.join(path.dirname(testDir), 'test-project-2');
      const project2BlockedDir = path.join(project2Path, '.workflow', 'tickets', 'blocked');
      fs.mkdirSync(project2BlockedDir, { recursive: true });

      const ticket2_1 = `---
id: PROJ2-BLK-001
title: Project 2 blocked 1
created_at: "2026-04-27T11:00:00Z"
updated_at: "2026-04-27T13:00:00Z"
events:
  - timestamp: "2026-04-27T13:00:00Z"
    reason: "Project 2 reason"
---
Content`;

      const ticket2_2 = `---
id: PROJ2-BLK-002
title: Project 2 blocked 2
created_at: "2026-04-27T09:00:00Z"
updated_at: "2026-04-27T14:00:00Z"
events:
  - timestamp: "2026-04-27T14:00:00Z"
    reason: "Project 2 reason 2"
---
Content`;

      fs.writeFileSync(path.join(project2BlockedDir, 'PROJ2-BLK-001.md'), ticket2_1, 'utf8');
      fs.writeFileSync(path.join(project2BlockedDir, 'PROJ2-BLK-002.md'), ticket2_2, 'utf8');

      try {
        // Set MCP_CWD to parent directory to discover both projects
        process.env.MCP_CWD = path.dirname(testDir);

        const result = await list_blocked_tickets({});

        // Should find tickets from both projects
        expect(result.length).toBeGreaterThanOrEqual(3);

        // Verify we have tickets from both projects
        const projectNames = [...new Set(result.map(t => t.project))];
        expect(projectNames.length).toBeGreaterThanOrEqual(2);

        // Verify each ticket has project field set
        result.forEach(ticket => {
          expect(ticket).toHaveProperty('project');
          expect(ticket.project).toBeDefined();
        });
      } finally {
        // Clean up second project
        try {
          fs.rmSync(project2Path, { recursive: true, force: true });
        } catch (err) {
          // ignore
        }
      }
    });

    it('should filter by single project when project parameter is provided', async () => {
      // Create first project
      const project1Path = testDir;
      const project1BlockedDir = path.join(project1Path, '.workflow', 'tickets', 'blocked');
      fs.mkdirSync(project1BlockedDir, { recursive: true });

      const ticket1 = `---
id: SINGLE-001
title: Project 1 ticket
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Reason 1"
---
Content`;

      fs.writeFileSync(path.join(project1BlockedDir, 'SINGLE-001.md'), ticket1, 'utf8');

      // Create second project
      const project2Path = path.join(path.dirname(testDir), 'other-test-project');
      const project2BlockedDir = path.join(project2Path, '.workflow', 'tickets', 'blocked');
      fs.mkdirSync(project2BlockedDir, { recursive: true });

      const ticket2 = `---
id: OTHER-001
title: Project 2 ticket
created_at: "2026-04-27T11:00:00Z"
updated_at: "2026-04-27T13:00:00Z"
events:
  - timestamp: "2026-04-27T13:00:00Z"
    reason: "Reason 2"
---
Content`;

      fs.writeFileSync(path.join(project2BlockedDir, 'OTHER-001.md'), ticket2, 'utf8');

      try {
        // Query specific project
        const result = await list_blocked_tickets({ project: project1Path });

        // Should have only 1 ticket from project 1
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('SINGLE-001');
        expect(result[0].project).toBe(path.basename(project1Path));
      } finally {
        // Clean up second project
        try {
          fs.rmSync(project2Path, { recursive: true, force: true });
        } catch (err) {
          // ignore
        }
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle project with no blocked directory', async () => {
      // Remove the blocked directory
      fs.rmSync(blockedDir, { recursive: true });

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(0);
    });

    it('should handle project with empty blocked directory', async () => {
      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(0);
    });

    it('should ignore non-markdown files in blocked directory', async () => {
      fs.writeFileSync(path.join(blockedDir, 'not-a-ticket.txt'), 'This is not markdown');
      fs.writeFileSync(path.join(blockedDir, 'README'), 'Just a readme');

      const ticket = `---
id: VALID-001
title: Valid ticket
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Reason"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'VALID-001.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      // Should find only the markdown file
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('VALID-001');
    });

    it('should handle tickets missing title field', async () => {
      const ticket = `---
id: NO-TITLE
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Reason"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'NO-TITLE.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('NO-TITLE');
      expect(result[0].title).toBe('');
    });

    it('should use filename as id if frontmatter id is missing', async () => {
      const ticket = `---
title: No ID in frontmatter
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Reason"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'FILE-ID.md'), ticket, 'utf8');

      const result = await list_blocked_tickets({ project: projectPath });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('FILE-ID');
    });
  });

  describe('Tool registration', () => {
    it('should have proper tool structure', async () => {
      const tool = require('../../src/tools/diagnostics.mjs').default;

      expect(tool.name).toBe('list_blocked_tickets');
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it('should execute through tool interface', async () => {
      const tool = require('../../src/tools/diagnostics.mjs').default;

      const ticket = `---
id: TOOL-TEST
title: Tool test ticket
created_at: "2026-04-27T10:00:00Z"
updated_at: "2026-04-27T12:00:00Z"
events:
  - timestamp: "2026-04-27T12:00:00Z"
    reason: "Test"
---
Content`;

      fs.writeFileSync(path.join(blockedDir, 'TOOL-TEST.md'), ticket, 'utf8');

      const result = await tool.execute({ project: projectPath });

      expect(result.project_filter).toBe(projectPath);
      expect(result.count).toBe(1);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].id).toBe('TOOL-TEST');
    });
  });
});