import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolve_human_ticket, list_human_queue } from '../../src/tools/human.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { invalidate as invalidateCache } from '../../src/caches/frontmatter-cache.mjs';

let testDir = null;
let projectPath = null;
const originalCwd = process.cwd();

beforeEach(() => {
  // Create temporary directory for test fixtures
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-resolve-test-'));
  projectPath = path.join(testDir, 'test-project');

  // Create project directory with workflow structure
  fs.mkdirSync(projectPath);
  const workflowDir = path.join(projectPath, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');

  // Create all status directories
  const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];
  for (const status of statuses) {
    fs.mkdirSync(path.join(ticketsDir, status), { recursive: true });
  }

  // Change to test directory for relative path resolution
  process.chdir(testDir);
});

afterEach(() => {
  // Restore original working directory
  process.chdir(originalCwd);

  // Clean up test fixture
  if (testDir && fs.existsSync(testDir)) {
    // Invalidate cache entries
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

    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Helper: Create a ticket file with frontmatter and body
 */
function createTicket(status, ticketId, options = {}) {
  const {
    type = 'human',
    title = `Test ${ticketId}`,
    priority = 1,
    dependencies = [],
    parent_plan = ''
  } = options;

  let frontmatter = `---
id: ${ticketId}
type: ${type}
title: "${title}"
priority: ${priority}
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
completed_at: ""
`;

  if (dependencies.length > 0) {
    frontmatter += `dependencies:\n`;
    for (const dep of dependencies) {
      frontmatter += `  - ${dep}\n`;
    }
  }

  if (parent_plan) {
    frontmatter += `parent_plan: "${parent_plan}"\n`;
  }

  frontmatter += '---';

  const body = `## Описание

Тестовый тикет ${ticketId}
`;

  const ticketPath = path.join(projectPath, '.workflow', 'tickets', status, `${ticketId}.md`);
  fs.writeFileSync(ticketPath, frontmatter + '\n' + body);
  return ticketPath;
}

describe('resolve_human_ticket', () => {
  describe('Core functionality', () => {
    it('should resolve a HUMAN ticket in review status and move it to done/', async () => {
      // Setup: Create a HUMAN ticket in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-1', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-1',
        decision: 'approved',
        result_body: '## Решение\n\nТикет одобрен и выполнен.'
      });

      // Assert: Return value contains expected fields
      expect(result.id).toBe('HUMAN-1');
      expect(result.new_status).toBe('done');

      // Assert: Ticket is now in done/
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-1.md');
      expect(fs.existsSync(donePath)).toBe(true);

      // Assert: Original location is empty
      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-1.md');
      expect(fs.existsSync(reviewPath)).toBe(false);
    });

    it('should add completed_at and resolution to frontmatter when resolved', async () => {
      // Setup: Create a HUMAN ticket in in-progress/ (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-2', { type: 'human' });

      // Act: Resolve the ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-2',
        decision: 'rejected',
        result_body: '## Причина отклонения\n\nТикет не соответствует требованиям.'
      });

      // Assert: Check frontmatter contains review_log
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-2.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter.review_log).toBeDefined();
      expect(Array.isArray(frontmatter.review_log)).toBe(true);
      expect(frontmatter.review_log[0]).toMatchObject({
        action: 'resolved',
        decision: 'rejected'
      });
      expect(frontmatter.review_log[0].date).toBeDefined();
    });

    it('should add Result section to ticket body when resolved', async () => {
      // Setup: Create a HUMAN ticket in in-progress/ (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-3', { type: 'human' });

      // Act: Resolve the ticket
      const resultBody = '## Детали решения\n\nВсе критерии выполнены успешно.';
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-3',
        decision: 'approved',
        result_body: resultBody
      });

      // Assert: Check that ticket has review_log entry with the decision
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-3.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Verify the decision is recorded in review_log
      expect(frontmatter.review_log).toBeDefined();
      expect(frontmatter.review_log[0].decision).toBe('approved');
      expect(frontmatter.review_log[0].action).toBe('resolved');

      // Verify the ticket was moved to done/
      expect(fs.existsSync(donePath)).toBe(true);
    });
  });

  describe('Ticket removal from queue', () => {
    it('should remove resolved ticket from list_human_queue result', async () => {
      // Setup: Create two HUMAN tickets in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-4', { type: 'human' });
      createTicket('review', 'HUMAN-5', { type: 'human' });

      // Assert: Both tickets are in queue before resolution
      let queueBefore = await list_human_queue({ project: 'test-project', status: 'review' });
      expect(queueBefore.map(t => t.id)).toContain('HUMAN-4');
      expect(queueBefore.map(t => t.id)).toContain('HUMAN-5');

      // Act: Resolve one ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-4',
        decision: 'approved',
        result_body: '## Решение принято'
      });

      // Assert: Resolved ticket is no longer in review queue
      let queueAfter = await list_human_queue({ project: 'test-project', status: 'review' });
      expect(queueAfter.map(t => t.id)).not.toContain('HUMAN-4');
      expect(queueAfter.map(t => t.id)).toContain('HUMAN-5');

      // Assert: Resolved ticket appears in done queue
      let doneQueue = await list_human_queue({ project: 'test-project', status: 'done' });
      expect(doneQueue.map(t => t.id)).toContain('HUMAN-4');
    });
  });

  describe('Error handling', () => {
    it('should throw TICKET_NOT_FOUND when ticket does not exist', async () => {
      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-NONEXISTENT',
          decision: 'approved',
          result_body: 'Test'
        })
      ).rejects.toThrow(/TICKET_NOT_FOUND/);
    });

    it('should throw NOT_HUMAN_TICKET when trying to resolve non-HUMAN ticket', async () => {
      // Setup: Create a non-HUMAN ticket (type: qa)
      createTicket('ready', 'QA-100', { type: 'qa' });

      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'QA-100',
          decision: 'approved',
          result_body: 'Test'
        })
      ).rejects.toThrow(/NOT_HUMAN_TICKET/);
    });

    it('should throw INCOMPLETE_RESULT when result_body is empty', async () => {
      // Setup: Create a HUMAN ticket in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-6', { type: 'human' });

      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-6',
          decision: 'approved',
          result_body: ''
        })
      ).rejects.toThrow(/INCOMPLETE_RESULT/);

      // Create another ticket for the second test
      createTicket('review', 'HUMAN-6b', { type: 'human' });

      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-6b',
          decision: 'approved',
          result_body: '   \n  '
        })
      ).rejects.toThrow(/INCOMPLETE_RESULT/);
    });

    it('should throw ALREADY_RESOLVED when trying to resolve a ticket that is already done', async () => {
      // Setup: Create and resolve a ticket from in-progress (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-7', { type: 'human' });
      const firstResolve = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-7',
        decision: 'approved',
        result_body: 'Already resolved'
      });

      // Verify the ticket was moved to done/
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-7.md');
      expect(fs.existsSync(donePath)).toBe(true);

      // Act & Assert: Try to resolve again - should fail since it's already in done/
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-7',
          decision: 'approved',
          result_body: 'Try to resolve again'
        })
      ).rejects.toThrow();
    });
  });

  describe('Stage behavior documentation', () => {
    it('should resolve HUMAN ticket from in-progress status', async () => {
      // Setup: Create a HUMAN ticket in in-progress/
      createTicket('in-progress', 'HUMAN-8', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-8',
        decision: 'approved',
        result_body: 'Completed in-progress'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-8.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should resolve HUMAN ticket from review status', async () => {
      // Setup: Create a HUMAN ticket in review/
      createTicket('review', 'HUMAN-9', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-9',
        decision: 'rejected',
        result_body: 'Review rejected'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-9.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should resolve HUMAN ticket from backlog status', async () => {
      // Setup: Create a HUMAN ticket in backlog/
      createTicket('backlog', 'HUMAN-10', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-10',
        decision: 'approved',
        result_body: 'Resolved from backlog'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-10.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should allow custom next_status parameter', async () => {
      // Setup: Create a HUMAN ticket in ready/
      createTicket('ready', 'HUMAN-11', { type: 'human' });

      // Act: Resolve with custom next_status
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-11',
        decision: 'needs_review',
        result_body: 'Needs further review',
        next_status: 'review'
      });

      // Assert: Ticket moved to specified status
      expect(result.new_status).toBe('review');
      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-11.md');
      expect(fs.existsSync(reviewPath)).toBe(true);
    });
  });

  describe('HUMAN ticket identification', () => {
    it('should recognize HUMAN ticket by type field', async () => {
      // Setup: Create ticket with type: human (without HUMAN- prefix in filename)
      // Using review status for valid transition: review -> done
      createTicket('review', 'CUSTOM-1', { type: 'human' });

      // Act: Resolve should work for type: human tickets
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'CUSTOM-1',
        decision: 'approved',
        result_body: 'Resolved custom HUMAN type'
      });

      // Assert: Successfully resolved
      expect(result.id).toBe('CUSTOM-1');
      expect(result.new_status).toBe('done');
    });

    it('should recognize HUMAN ticket by HUMAN- filename prefix', async () => {
      // Setup: Create ticket with HUMAN- prefix (without explicit type: human) in in-progress status
      // Valid transition: in-progress -> done
      const ticketPath = path.join(projectPath, '.workflow', 'tickets', 'in-progress', 'HUMAN-BYPREFIX.md');
      const frontmatter = `---
id: HUMAN-BYPREFIX
type: task
title: Test HUMAN Prefix
priority: 1
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
completed_at: ""
---`;
      fs.writeFileSync(ticketPath, frontmatter + '\n## Test\n');

      // Act: Resolve should work for HUMAN- prefixed tickets
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-BYPREFIX',
        decision: 'approved',
        result_body: 'Resolved by prefix'
      });

      // Assert: Successfully resolved
      expect(result.id).toBe('HUMAN-BYPREFIX');
      expect(result.new_status).toBe('done');
    });
  });

  describe('Data persistence and atomicity', () => {
    it('should preserve all ticket metadata when resolving', async () => {
      // Setup: Create ticket with metadata in in-progress status (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-12', {
        type: 'human',
        title: 'Test with metadata',
        priority: 2,
        parent_plan: '.workflow/plans/PLAN-001.md',
        dependencies: ['IMPL-1', 'IMPL-2']
      });

      // Act: Resolve the ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-12',
        decision: 'approved',
        result_body: 'Test result'
      });

      // Assert: Metadata is preserved
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-12.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe('Test with metadata');
      expect(frontmatter.priority).toBe(2);
      expect(frontmatter.parent_plan).toBe('.workflow/plans/PLAN-001.md');
      expect(frontmatter.dependencies).toEqual(['IMPL-1', 'IMPL-2']);
    });
  });
});
