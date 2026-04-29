import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { list_human_queue } from '../../src/tools/human.mjs';

// Setup test fixture
let tempDir = null;

beforeEach(() => {
  // Create a temporary directory for test fixtures
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-test-'));
});

afterEach(() => {
  // Cleanup test fixture
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Helper: Create a workflow project with tickets directory structure
 */
function createProject(projectRoot) {
  const ticketsDir = path.join(projectRoot, '.workflow', 'tickets');

  // Create all status directories
  const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];
  for (const status of statuses) {
    fs.mkdirSync(path.join(ticketsDir, status), { recursive: true });
  }
}

/**
 * Helper: Create a ticket file with frontmatter and body
 */
function createTicket(projectRoot, status, ticketId, options = {}) {
  const {
    type = 'human',
    title = `Test ${ticketId}`,
    priority = 1,
  } = options;

  const frontmatter = `---
id: ${ticketId}
type: ${type}
title: ${title}
priority: ${priority}
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
---`;

  const body = `
## Description
Test ticket ${ticketId}
`;

  const ticketPath = path.join(projectRoot, '.workflow', 'tickets', status, `${ticketId}.md`);
  fs.writeFileSync(ticketPath, frontmatter + body);
}

describe('list_human_queue', () => {
  it('should return HUMAN tickets from ready status', async () => {
    // Setup: Create project with HUMAN tickets in ready/
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);
    createTicket(projectA, 'ready', 'HUMAN-001', { type: 'human' });
    createTicket(projectA, 'ready', 'HUMAN-002', { type: 'human' });

    // Act: List HUMAN tickets with status filter
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'HUMAN-001',
            project: 'projectA',
            status: 'ready'
          }),
          expect.objectContaining({
            id: 'HUMAN-002',
            project: 'projectA',
            status: 'ready'
          })
        ])
      );
      expect(result.length).toBe(2);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should NOT return tickets from backlog status when filtering by ready', async () => {
    // Setup: Create project with HUMAN tickets in backlog/ and ready/
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);
    createTicket(projectA, 'backlog', 'HUMAN-001', { type: 'human' });
    createTicket(projectA, 'ready', 'HUMAN-002', { type: 'human' });

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: Only ticket from ready/ should be included
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('HUMAN-002');
      expect(result[0].status).toBe('ready');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should exclude non-HUMAN tickets', async () => {
    // Setup: Create project with mixed ticket types
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);
    createTicket(projectA, 'ready', 'HUMAN-001', { type: 'human' });
    createTicket(projectA, 'ready', 'IMPL-001', { type: 'implementation' });
    createTicket(projectA, 'ready', 'QA-001', { type: 'qa' });

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: Only HUMAN ticket should be included
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('HUMAN-001');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should filter by project when specified', async () => {
    // Setup: Create multiple projects with HUMAN tickets
    const projectA = path.join(tempDir, 'projectA');
    const projectB = path.join(tempDir, 'projectB');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    createProject(projectA);
    createProject(projectB);
    createTicket(projectA, 'ready', 'HUMAN-001', { type: 'human' });
    createTicket(projectB, 'ready', 'HUMAN-002', { type: 'human' });

    // Act: Filter by projectA
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ project: 'projectA', status: 'ready' });

      // Assert: Only ticket from projectA should be included
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('HUMAN-001');
      expect(result[0].project).toBe('projectA');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should include project field in multiproject aggregation', async () => {
    // Setup: Create multiple projects with HUMAN tickets
    const projectA = path.join(tempDir, 'projectA');
    const projectB = path.join(tempDir, 'projectB');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    createProject(projectA);
    createProject(projectB);
    createTicket(projectA, 'ready', 'HUMAN-001', { type: 'human' });
    createTicket(projectB, 'ready', 'HUMAN-002', { type: 'human' });

    // Act: List all HUMAN tickets (no project filter)
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: All tickets should have project field
      expect(result.length).toBe(2);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'HUMAN-001', project: 'projectA' }),
          expect.objectContaining({ id: 'HUMAN-002', project: 'projectB' })
        ])
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should return empty array when no tickets found', async () => {
    // Setup: Create project with no HUMAN tickets
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert
      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should sort by priority (ascending) then by updated_at', async () => {
    // Setup: Create project with HUMAN tickets of different priorities
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);

    // Create frontmatter with different priorities and timestamps
    const ticketContent1 = `---
id: HUMAN-001
type: human
title: High priority
priority: 1
created_at: "2026-04-24T10:00:00Z"
updated_at: "2026-04-27T10:00:00Z"
---
Content`;

    const ticketContent2 = `---
id: HUMAN-002
type: human
title: Low priority
priority: 3
created_at: "2026-04-24T08:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
---
Content`;

    const ticketContent3 = `---
id: HUMAN-003
type: human
title: Medium priority
priority: 2
created_at: "2026-04-24T09:00:00Z"
updated_at: "2026-04-27T09:00:00Z"
---
Content`;

    fs.writeFileSync(path.join(projectA, '.workflow', 'tickets', 'ready', 'HUMAN-001.md'), ticketContent1);
    fs.writeFileSync(path.join(projectA, '.workflow', 'tickets', 'ready', 'HUMAN-002.md'), ticketContent2);
    fs.writeFileSync(path.join(projectA, '.workflow', 'tickets', 'ready', 'HUMAN-003.md'), ticketContent3);

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: Should be sorted by priority ascending
      expect(result.length).toBe(3);
      expect(result[0].priority).toBe(1);
      expect(result[1].priority).toBe(2);
      expect(result[2].priority).toBe(3);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should handle tickets without type field if filename has HUMAN- prefix', async () => {
    // Setup: Create project with ticket that has HUMAN- prefix but no type field
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);

    const ticketContent = `---
id: HUMAN-001
title: Human ticket without type field
priority: 1
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
---
Content`;

    fs.writeFileSync(path.join(projectA, '.workflow', 'tickets', 'ready', 'HUMAN-001.md'), ticketContent);

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: Should be included because filename has HUMAN- prefix
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('HUMAN-001');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should not return tickets that are neither type: human nor HUMAN- prefix', async () => {
    // Setup: Create project with ticket that is neither
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);

    const ticketContent = `---
id: TASK-001
type: task
title: Not a human ticket
priority: 1
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
---
Content`;

    fs.writeFileSync(path.join(projectA, '.workflow', 'tickets', 'ready', 'TASK-001.md'), ticketContent);

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: Should not be included
      expect(result.length).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should include required fields in response', async () => {
    // Setup: Create project with HUMAN ticket
    const projectA = path.join(tempDir, 'projectA');
    fs.mkdirSync(projectA);
    createProject(projectA);
    createTicket(projectA, 'ready', 'HUMAN-001', {
      type: 'human',
      title: 'Test Ticket',
      priority: 1
    });

    // Act
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const result = await list_human_queue({ status: 'ready' });

      // Assert: All required fields should be present
      expect(result.length).toBe(1);
      const ticket = result[0];
      expect(ticket).toHaveProperty('project');
      expect(ticket).toHaveProperty('id');
      expect(ticket).toHaveProperty('title');
      expect(ticket).toHaveProperty('priority');
      expect(ticket).toHaveProperty('status');
      expect(ticket).toHaveProperty('age_sec');
      expect(ticket).toHaveProperty('updated_at');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
