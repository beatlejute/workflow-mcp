import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  list_tickets,
  get_ticket,
  move_ticket,
  create_ticket,
  pick_next_ticket
} from '../../src/tools/tickets.mjs';
import { invalidate as invalidateCache } from '../../src/caches/frontmatter-cache.mjs';

// Helper to create test directories with .workflow structure
function createProjectDir(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  // Create .workflow/tickets structure with all stages
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'review'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'blocked'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'archive'), { recursive: true });

  return projectPath;
}

// Helper to create a ticket file
function createTicketFile(projectPath, stage, filename, frontmatter, body = '') {
  const ticketPath = path.join(projectPath, '.workflow', 'tickets', stage, filename);

  let content = '---\n';
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      content += `${key}: "${value}"\n`;
    } else if (typeof value === 'number') {
      content += `${key}: ${value}\n`;
    } else if (Array.isArray(value)) {
      content += `${key}:\n`;
      for (const item of value) {
        content += `  - ${item}\n`;
      }
    } else {
      content += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  content += '---\n' + body;

  fs.writeFileSync(ticketPath, content, 'utf-8');
  return ticketPath;
}

describe('Ticket Tools', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-ticket-tools-'));
    projectPath = createProjectDir(testDir);
    process.chdir(testDir);
  });

  afterEach(() => {
    // Clear cache before directory cleanup
    const ticketsDir = path.join(projectPath, '.workflow', 'tickets');
    if (fs.existsSync(ticketsDir)) {
      const walkDir = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            walkDir(filePath);
          } else if (file.endsWith('.md')) {
            invalidateCache(filePath);
          }
        }
      };
      walkDir(ticketsDir);
    }

    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  describe('list_tickets', () => {
    it('returns all tickets with stage field from all statuses', async () => {
      // Create tickets in different statuses
      createTicketFile(projectPath, 'backlog', 'IMPL-1.md', {
        id: 'IMPL-1',
        title: 'Implementation Task',
        type: 'impl',
        priority: 1
      });

      createTicketFile(projectPath, 'ready', 'IMPL-2.md', {
        id: 'IMPL-2',
        title: 'Ready Task',
        type: 'impl',
        priority: 2
      });

      createTicketFile(projectPath, 'done', 'IMPL-3.md', {
        id: 'IMPL-3',
        title: 'Done Task',
        type: 'impl',
        priority: 3
      });

      const tickets = await list_tickets({ project: projectPath });

      expect(tickets).toHaveLength(3);
      expect(tickets.some(t => t.id === 'IMPL-1' && t.status === 'backlog')).toBe(true);
      expect(tickets.some(t => t.id === 'IMPL-2' && t.status === 'ready')).toBe(true);
      expect(tickets.some(t => t.id === 'IMPL-3' && t.status === 'done')).toBe(true);
    });

    it('filters tickets by status (stage) correctly', async () => {
      // Create tickets in different statuses
      createTicketFile(projectPath, 'backlog', 'TEST-1.md', {
        id: 'TEST-1',
        title: 'Backlog Task',
        type: 'qa'
      });

      createTicketFile(projectPath, 'ready', 'TEST-2.md', {
        id: 'TEST-2',
        title: 'Ready Task',
        type: 'qa'
      });

      createTicketFile(projectPath, 'backlog', 'TEST-3.md', {
        id: 'TEST-3',
        title: 'Another Backlog',
        type: 'qa'
      });

      const readyTickets = await list_tickets({ project: projectPath, status: 'ready' });

      expect(readyTickets).toHaveLength(1);
      expect(readyTickets[0].id).toBe('TEST-2');
      expect(readyTickets[0].status).toBe('ready');
    });

    it('filters tickets by priority', async () => {
      createTicketFile(projectPath, 'backlog', 'IMPL-1.md', {
        id: 'IMPL-1',
        title: 'High Priority',
        priority: 1
      });

      createTicketFile(projectPath, 'backlog', 'IMPL-2.md', {
        id: 'IMPL-2',
        title: 'Low Priority',
        priority: 3
      });

      const highPriority = await list_tickets({ project: projectPath, priority: 1 });

      expect(highPriority).toHaveLength(1);
      expect(highPriority[0].id).toBe('IMPL-1');
      expect(highPriority[0].priority).toBe(1);
    });

    it('filters tickets by type', async () => {
      createTicketFile(projectPath, 'backlog', 'IMPL-1.md', {
        id: 'IMPL-1',
        title: 'Implementation',
        type: 'impl'
      });

      createTicketFile(projectPath, 'backlog', 'QA-1.md', {
        id: 'QA-1',
        title: 'Testing',
        type: 'qa'
      });

      const implTickets = await list_tickets({ project: projectPath, type: 'impl' });

      expect(implTickets).toHaveLength(1);
      expect(implTickets[0].id).toBe('IMPL-1');
      expect(implTickets[0].type).toBe('impl');
    });

    it('throws error for invalid project path (path traversal)', async () => {
      const invalidPath = path.join(testDir, '..', '..', 'etc', 'passwd');

      await expect(list_tickets({ project: invalidPath })).rejects.toThrow();
    });
  });

  describe('get_ticket', () => {
    it('returns complete ticket data (frontmatter + body + status_from_dir)', async () => {
      const ticketPath = createTicketFile(projectPath, 'backlog', 'IMPL-1.md', {
        id: 'IMPL-1',
        title: 'Test Implementation',
        type: 'impl',
        priority: 1
      }, 'This is the ticket body\nwith multiple lines');

      const ticket = await get_ticket({ project: projectPath, ticket_id: 'IMPL-1' });

      expect(ticket).toHaveProperty('frontmatter');
      expect(ticket).toHaveProperty('body');
      expect(ticket).toHaveProperty('status_from_dir');
      expect(ticket).toHaveProperty('path');

      expect(ticket.frontmatter.id).toBe('IMPL-1');
      expect(ticket.frontmatter.title).toBe('Test Implementation');
      expect(ticket.status_from_dir).toBe('backlog');
      expect(ticket.body).toContain('This is the ticket body');
      expect(path.resolve(ticket.path)).toBe(path.resolve(ticketPath));
    });

    it('throws TICKET_NOT_FOUND error for non-existent ticket', async () => {
      await expect(get_ticket({ project: projectPath, ticket_id: 'NONEXISTENT-999' }))
        .rejects
        .toThrow(/Ticket not found/);
    });

    it('finds ticket in different stages', async () => {
      createTicketFile(projectPath, 'ready', 'TASK-1.md', {
        id: 'TASK-1',
        title: 'Ready Task'
      });

      const ticket = await get_ticket({ project: projectPath, ticket_id: 'TASK-1' });

      expect(ticket.status_from_dir).toBe('ready');
      expect(ticket.frontmatter.id).toBe('TASK-1');
    });

    it('throws error for path traversal in ticket_id', async () => {
      await expect(get_ticket({ project: projectPath, ticket_id: '../../etc/passwd' }))
        .rejects
        .toThrow();
    });
  });

  describe('move_ticket', () => {
    it('moves ticket file to target stage and returns new path', async () => {
      const originalTicketPath = createTicketFile(projectPath, 'backlog', 'MOVE-1.md', {
        id: 'MOVE-1',
        title: 'To Move'
      });

      expect(fs.existsSync(originalTicketPath)).toBe(true);

      const result = await move_ticket({
        project: projectPath,
        ticket_id: 'MOVE-1',
        target: 'ready'
      });

      // Original file should not exist
      expect(fs.existsSync(originalTicketPath)).toBe(false);

      // New file should exist at target location
      const newPath = path.join(projectPath, '.workflow', 'tickets', 'ready', 'MOVE-1.md');
      expect(fs.existsSync(newPath)).toBe(true);
      expect(path.resolve(result.path)).toBe(path.resolve(newPath));
    });

    it('preserves ticket content when moving', async () => {
      createTicketFile(projectPath, 'backlog', 'PRES-1.md', {
        id: 'PRES-1',
        title: 'Preserve Content',
        priority: 1
      }, 'Important body content');

      // First move: backlog → ready
      await move_ticket({
        project: projectPath,
        ticket_id: 'PRES-1',
        target: 'ready'
      });

      // Second move: ready → in-progress
      await move_ticket({
        project: projectPath,
        ticket_id: 'PRES-1',
        target: 'in-progress'
      });

      const movedTicket = await get_ticket({
        project: projectPath,
        ticket_id: 'PRES-1'
      });

      expect(movedTicket.frontmatter.title).toBe('Preserve Content');
      expect(movedTicket.frontmatter.priority).toBe(1);
      expect(movedTicket.body).toContain('Important body content');
      expect(movedTicket.status_from_dir).toBe('in-progress');
    });

    it('throws error when moving non-existent ticket', async () => {
      await expect(move_ticket({
        project: projectPath,
        ticket_id: 'NOTFOUND-1',
        target: 'ready'
      })).rejects.toThrow();
    });

    it('handles invalid target stage gracefully', async () => {
      createTicketFile(projectPath, 'backlog', 'BAD-1.md', {
        id: 'BAD-1',
        title: 'Bad Target'
      });

      // Should throw error for invalid stage
      await expect(move_ticket({
        project: projectPath,
        ticket_id: 'BAD-1',
        target: 'invalid_stage'
      })).rejects.toThrow();
    });
  });

  describe('create_ticket', () => {
    it('creates ticket with required fields in backlog stage', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'IMPL',
        title: 'New Implementation Task',
        priority: 2
      });

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('path');
      expect(result.id).toMatch(/^IMPL-\d+$/);

      // Verify file exists
      expect(fs.existsSync(result.path)).toBe(true);

      // Verify content
      const ticket = await get_ticket({
        project: projectPath,
        ticket_id: result.id
      });

      expect(ticket.frontmatter.title).toBe('New Implementation Task');
      expect(ticket.frontmatter.type).toBe('IMPL');
      expect(ticket.frontmatter.priority).toBe(2);
    });

    it('creates ticket in backlog directory', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'QA',
        title: 'Test Task'
      });

      // Check file is in backlog
      expect(result.path).toContain('backlog');
      expect(fs.existsSync(result.path)).toBe(true);
    });

    it('assigns sequential IDs correctly', async () => {
      const result1 = await create_ticket({
        project: projectPath,
        type: 'IMPL',
        title: 'Task 1'
      });

      const result2 = await create_ticket({
        project: projectPath,
        type: 'IMPL',
        title: 'Task 2'
      });

      // Extract numeric part of IDs
      const id1Num = parseInt(result1.id.split('-')[1]);
      const id2Num = parseInt(result2.id.split('-')[1]);

      // Second ID should be greater than first
      expect(id2Num).toBeGreaterThan(id1Num);
    });

    it('sets executor_type to human for human type (case-insensitive)', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'human',
        title: 'Human Task'
      });

      const ticket = await get_ticket({
        project: projectPath,
        ticket_id: result.id
      });

      expect(ticket.frontmatter.executor_type).toBe('human');
    });

    it('sets executor_type to human for HUMAN type (uppercase)', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'HUMAN',
        title: 'Human Task Uppercase'
      });

      const ticket = await get_ticket({
        project: projectPath,
        ticket_id: result.id
      });

      expect(ticket.frontmatter.executor_type).toBe('human');
    });

    it('creates ticket with default priority when not provided', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'IMPL',
        title: 'Task with default priority'
      });

      const ticket = await get_ticket({
        project: projectPath,
        ticket_id: result.id
      });

      expect(ticket.frontmatter.priority).toBe(3);
    });

    it('creates ticket with template body', async () => {
      const result = await create_ticket({
        project: projectPath,
        type: 'IMPL',
        title: 'Task with template'
      });

      const ticket = await get_ticket({
        project: projectPath,
        ticket_id: result.id
      });

      // Should contain template sections
      expect(ticket.body).toContain('## Описание');
      expect(ticket.body).toContain('## Критерии готовности');
    });
  });

  describe('pick_next_ticket', () => {
    it('returns next eligible ticket from ready stage', async () => {
      // Create multiple tickets with priorities
      createTicketFile(projectPath, 'ready', 'PICK-1.md', {
        id: 'PICK-1',
        title: 'First Ready',
        priority: 2,
        type: 'IMPL',
        dependencies: [],
        conditions: []
      });

      createTicketFile(projectPath, 'ready', 'PICK-2.md', {
        id: 'PICK-2',
        title: 'Second Ready',
        priority: 1,
        type: 'IMPL',
        dependencies: [],
        conditions: []
      });

      createTicketFile(projectPath, 'backlog', 'PICK-3.md', {
        id: 'PICK-3',
        title: 'In Backlog',
        priority: 0
      });

      const result = await pick_next_ticket({ project: projectPath });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('ticket');
      expect(result.ticket).toHaveProperty('id');
      expect(result.ticket.id).toBe('PICK-2'); // Should pick highest priority (lowest number)
    });

    it('returns empty response when no ready tickets exist', async () => {
      // Create only backlog tickets
      createTicketFile(projectPath, 'backlog', 'EMPTY-1.md', {
        id: 'EMPTY-1',
        title: 'Backlog Only'
      });

      const result = await pick_next_ticket({ project: projectPath });

      // Should return {empty: true, reason: ...}
      expect(result).toHaveProperty('empty');
      expect(result.empty).toBe(true);
      expect(result).toHaveProperty('reason');
    });
  });

  describe('Error Handling', () => {
    it('list_tickets throws for non-existent project', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent-project-xyz');

      await expect(list_tickets({
        project: nonExistentPath
      })).rejects.toThrow();
    });

    it('creates multiple tickets sequentially with unique IDs', async () => {
      // Create multiple tickets sequentially
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await create_ticket({
          project: projectPath,
          type: 'IMPL',
          title: `Sequential Task ${i}`,
          priority: i + 1
        });
        results.push(result);
      }

      expect(results).toHaveLength(3);

      // All should have unique IDs
      const ids = new Set(results.map(r => r.id));
      expect(ids.size).toBe(3);

      // All files should exist
      for (const result of results) {
        expect(result.id).toBeDefined();
        expect(fs.existsSync(result.path)).toBe(true);
      }

      // Verify all tickets can be retrieved
      const allTickets = await list_tickets({ project: projectPath });
      expect(allTickets).toHaveLength(3);
    });
  });
});
