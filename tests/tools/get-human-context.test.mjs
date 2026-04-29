import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  get_human_context
} from '../../src/tools/human.mjs';
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
  fs.mkdirSync(path.join(workflowPath, 'logs', 'pipeline'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'plans'), { recursive: true });

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

// Helper to create a plan file
function createPlanFile(projectPath, filename, frontmatter) {
  const planPath = path.join(projectPath, '.workflow', 'plans', filename);

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
    } else if (typeof value === 'object') {
      content += `${key}:\n`;
      for (const [subKey, subValue] of Object.entries(value)) {
        content += `  ${subKey}: "${subValue}"\n`;
      }
    } else {
      content += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  content += '---\n';

  fs.writeFileSync(planPath, content, 'utf-8');
  return planPath;
}

// Helper to create a pipeline log file
function createPipelineLog(projectPath, content) {
  const logDir = path.join(projectPath, '.workflow', 'logs', 'pipeline');
  const logPath = path.join(logDir, 'pipeline_test.log');
  fs.writeFileSync(logPath, content, 'utf-8');
  return logPath;
}

describe('get_human_context', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-human-context-'));
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

  describe('Basic functionality', () => {
    it('returns complete context for a human ticket with parent_plan, dependencies, and pipeline logs', async () => {
      // Create parent plan
      const planPath = createPlanFile(projectPath, 'PLAN-001.md', {
        id: 'PLAN-001',
        title: 'Main Plan',
        goals: ['Goal 1', 'Goal 2']
      });

      // Create dependency ticket
      createTicketFile(projectPath, 'done', 'IMPL-19.md', {
        id: 'IMPL-19',
        title: 'Dependency Task',
        type: 'impl'
      }, '## Результат выполнения\n\n### Summary\n\nDependency completed successfully with all tests passing');

      // Create human ticket with parent_plan and dependencies
      createTicketFile(projectPath, 'in-progress', 'HUMAN-1.md', {
        id: 'HUMAN-1',
        title: 'Human Review Task',
        type: 'human',
        priority: 1,
        parent_plan: '.workflow/plans/PLAN-001.md',
        dependencies: ['IMPL-19', 'IMPL-22']
      }, 'This is the human ticket body content');

      // Create pipeline log
      createPipelineLog(projectPath, 
`2026-04-26T10:00:00: Processing started for ticket_id: HUMAN-1
2026-04-26T10:01:00: Validating ticket_id:HUMAN-1
2026-04-26T10:02:00: Checking dependencies for ticket_id: HUMAN-1`
      );

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-1' });

      // Check ticket data
      expect(context).toHaveProperty('ticket');
      expect(context.ticket.id).toBe('HUMAN-1');
      expect(context.ticket.title).toBe('Human Review Task');
      expect(context.ticket.type).toBe('human');
      expect(context.ticket.priority).toBe(1);
      expect(context.ticket.path).toContain('HUMAN-1.md');
      expect(context.ticket.body).toContain('This is the human ticket body content');

      // Check parent plan
      expect(context.parent_plan).not.toBeNull();
      expect(context.parent_plan.id).toBe('PLAN-001');
      expect(context.parent_plan.title).toBe('Main Plan');

      // Check dependencies
      expect(context.deps).toHaveLength(1);
      expect(context.deps[0].id).toBe('IMPL-19');
      expect(context.deps[0].status).toBe('done');
      expect(context.deps[0].result_excerpt).toContain('Dependency completed successfully');

      // Check pipeline logs
      expect(context.pipeline_steps).toHaveLength(3);
      expect(context.pipeline_steps[0].action).toContain('Processing started');
      expect(context.pipeline_steps[1].timestamp).toBe('2026-04-26T10:01:00');
    });

    it('returns context for human ticket without parent_plan', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-2.md', {
        id: 'HUMAN-2',
        title: 'Human Task Without Plan',
        type: 'human'
      }, 'Just a human ticket');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-2' });

      expect(context.ticket.id).toBe('HUMAN-2');
      expect(context.ticket.title).toBe('Human Task Without Plan');
      expect(context.ticket.body).toContain('Just a human ticket');

      // parent_plan should be null
      expect(context.parent_plan).toBeNull();

      // dependencies should be empty array
      expect(context.deps).toEqual([]);

      // related_reports should be empty array
      expect(context.related_reports).toEqual([]);

      // pipeline_steps should be empty array
      expect(context.pipeline_steps).toEqual([]);
    });

    it('returns context for human ticket without dependencies', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-3.md', {
        id: 'HUMAN-3',
        title: 'Human Task Without Dependencies',
        type: 'human'
      }, 'Ticket body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-3' });

      expect(context.ticket.id).toBe('HUMAN-3');
      expect(context.deps).toEqual([]);
    });

    it('ticket with filename format (HUMAN-NNN) also works', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-100.md', {
        title: 'Human Ticket by Filename',
        type: 'impl' // Not human type, but filename starts with HUMAN-
      }, 'Body content');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-100' });

      expect(context.ticket.id).toBe('HUMAN-100');
      expect(context.ticket.title).toBe('Human Ticket by Filename');
    });
  });

  describe('Error handling', () => {
    it('throws TICKET_NOT_FOUND error for non-existent ticket_id', async () => {
      await expect(get_human_context({ project: projectPath, ticket_id: 'NONEXISTENT-999' }))
        .rejects
        .toThrow(/Ticket not found/);
    });

    it('throws TICKET_NOT_FOUND error for non-existent numeric ticket_id', async () => {
      await expect(get_human_context({ project: projectPath, ticket_id: '999' }))
        .rejects
        .toThrow(/Ticket not found/);
    });

    it('returns context for non-human type ticket (should not error)', async () => {
      // The function does NOT check if ticket is human type - it works for any ticket
      // This is important for cross-reference scenarios
      createTicketFile(projectPath, 'ready', 'IMPL-99.md', {
        id: 'IMPL-99',
        title: 'Implementation Ticket',
        type: 'impl'
      }, 'Implementation body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'IMPL-99' });

      expect(context.ticket.id).toBe('IMPL-99');
      expect(context.ticket.type).toBe('impl');
      expect(context.ticket.title).toBe('Implementation Ticket');
    });
  });

  describe('Field resolution', () => {
    it('uses frontmatter id field when available instead of filename', async () => {
      createTicketFile(projectPath, 'ready', 'WRONG_NAME.md', {
        id: 'HUMAN-ACTUAL',
        title: 'Correct ID',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-ACTUAL' });

      expect(context.ticket.id).toBe('HUMAN-ACTUAL');
      expect(context.ticket.title).toBe('Correct ID');
    });

    it('falls back to filename when id not in frontmatter', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-555.md', {
        title: 'No ID field',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-555' });

      expect(context.ticket.id).toBe('HUMAN-555');
    });

    it('resolves dependency result excerpts from ## Результат выполнения section', async () => {
      createTicketFile(projectPath, 'done', 'DEP-1.md', {
        id: 'DEP-1',
        title: 'Dep Ticket',
        type: 'impl'
      }, `## Результат выполнения

### Summary

This is a very long result excerpt that should be truncated to 300 characters when extracted. 
It contains important information about the task completion and the results achieved. 
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Next Steps

More content here`);

      createTicketFile(projectPath, 'ready', 'HUMAN-PARENT.md', {
        id: 'HUMAN-PARENT',
        title: 'Parent Task',
        type: 'human',
        dependencies: ['DEP-1']
      }, 'Parent body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-PARENT' });

      expect(context.deps).toHaveLength(1);
      expect(context.deps[0].result_excerpt).toBeTruthy();
      expect(context.deps[0].result_excerpt.length).toBeLessThanOrEqual(300);
      expect(context.deps[0].result_excerpt).toContain('This is a very long result excerpt');
    });
  });

  describe('Plan field handling', () => {
    it('parent_plan field is null when not specified', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-NO-PLAN.md', {
        id: 'HUMAN-NO-PLAN',
        title: 'No Plan',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-NO-PLAN' });

      expect(context.parent_plan).toBeNull();
    });

    it('parent_plan is null when plan file does not exist', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-BAD-PLAN.md', {
        id: 'HUMAN-BAD-PLAN',
        title: 'Bad Plan Ref',
        type: 'human',
        parent_plan: '.workflow/plans/NONEXISTENT.md'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-BAD-PLAN' });

      expect(context.parent_plan).toBeNull();
    });

    it('parent_plan includes all frontmatter fields from plan', async () => {
      createPlanFile(projectPath, 'PLAN-FULL.md', {
        id: 'PLAN-FULL',
        title: 'Full Plan',
        goals: ['Goal 1', 'Goal 2'],
        priority: 1,
        related_reports: ['report-1', 'report-2']
      });

      createTicketFile(projectPath, 'ready', 'HUMAN-FULL.md', {
        id: 'HUMAN-FULL',
        title: 'Full Context',
        type: 'human',
        parent_plan: '.workflow/plans/PLAN-FULL.md'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-FULL' });

      expect(context.parent_plan.id).toBe('PLAN-FULL');
      expect(context.parent_plan.title).toBe('Full Plan');
      expect(context.parent_plan.goals).toEqual(['Goal 1', 'Goal 2']);
      expect(context.parent_plan.priority).toBe(1);
      expect(context.related_reports).toEqual(['report-1', 'report-2']);
    });
  });

  describe('Multiple status directories', () => {
    it('finds ticket in backlog status', async () => {
      createTicketFile(projectPath, 'backlog', 'HUMAN-BACKLOG.md', {
        id: 'HUMAN-BACKLOG',
        title: 'Backlog Human',
        type: 'human'
      }, 'Backlog body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-BACKLOG' });

      expect(context.ticket.id).toBe('HUMAN-BACKLOG');
    });

    it('finds ticket in done status', async () => {
      createTicketFile(projectPath, 'done', 'HUMAN-DONE.md', {
        id: 'HUMAN-DONE',
        title: 'Done Human',
        type: 'human'
      }, 'Done body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-DONE' });

      expect(context.ticket.id).toBe('HUMAN-DONE');
    });

    it('finds ticket in in-progress status', async () => {
      createTicketFile(projectPath, 'in-progress', 'HUMAN-IP.md', {
        id: 'HUMAN-IP',
        title: 'In Progress Human',
        type: 'human'
      }, 'IP body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-IP' });

      expect(context.ticket.id).toBe('HUMAN-IP');
    });
  });

  describe('Pipeline logs', () => {
    it('returns empty pipeline_steps when no pipeline logs exist', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-NOLOGS.md', {
        id: 'HUMAN-NOLOGS',
        title: 'No Logs',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-NOLOGS' });

      expect(context.pipeline_steps).toEqual([]);
    });

    it('parses pipeline log entries for the specific ticket', async () => {
      createPipelineLog(projectPath,
`2026-04-26T09:00:00: Processing ticket_id: OTHER-1
2026-04-26T09:01:00: Processing ticket_id:HUMAN-LOGS
2026-04-26T09:02:00: Validating ticket_id: HUMAN-LOGS
2026-04-26T09:03:00: Completed processing for OTHER-1`
      );

      createTicketFile(projectPath, 'ready', 'HUMAN-LOGS.md', {
        id: 'HUMAN-LOGS',
        title: 'Log Test',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-LOGS' });

      expect(context.pipeline_steps).toHaveLength(2);
      expect(context.pipeline_steps[0].timestamp).toBe('2026-04-26T09:01:00');
      expect(context.pipeline_steps[1].timestamp).toBe('2026-04-26T09:02:00');
    });

    it('handles malformed pipeline log entries gracefully', async () => {
      createPipelineLog(projectPath,
`2026-04-26T09:00:00: Processing ticket_id: HUMAN-BADLOG
Some random text without timestamp
Another line
`
      );

      createTicketFile(projectPath, 'ready', 'HUMAN-BADLOG.md', {
        id: 'HUMAN-BADLOG',
        title: 'Bad Log',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-BADLOG' });

      expect(context.pipeline_steps).toHaveLength(1);
      expect(context.pipeline_steps[0].timestamp).toBe('2026-04-26T09:00:00');
    });
  });

  describe('related_reports', () => {
    it('populates related_reports from parent plan when present', async () => {
      createPlanFile(projectPath, 'PLAN-WITH-REPORTS.md', {
        id: 'PLAN-WITH-REPORTS',
        title: 'Plan with Reports',
        related_reports: ['report-1.md', 'report-2.md', 'report-3.md']
      });

      createTicketFile(projectPath, 'ready', 'HUMAN-WITH-REPORTS.md', {
        id: 'HUMAN-WITH-REPORTS',
        title: 'With Reports',
        type: 'human',
        parent_plan: '.workflow/plans/PLAN-WITH-REPORTS.md'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-WITH-REPORTS' });

      expect(context.related_reports).toEqual(['report-1.md', 'report-2.md', 'report-3.md']);
    });

    it('related_reports is empty array when parent plan has no related_reports', async () => {
      createPlanFile(projectPath, 'PLAN-NO-REPORTS.md', {
        id: 'PLAN-NO-REPORTS',
        title: 'Plan without Reports'
      });

      createTicketFile(projectPath, 'ready', 'HUMAN-NO-REPORTS.md', {
        id: 'HUMAN-NO-REPORTS',
        title: 'No Reports',
        type: 'human',
        parent_plan: '.workflow/plans/PLAN-NO-REPORTS.md'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-NO-REPORTS' });

      expect(context.related_reports).toEqual([]);
    });

    it('related_reports is empty array when parent plan does not exist', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-MISSING-PLAN.md', {
        id: 'HUMAN-MISSING-PLAN',
        title: 'Missing Plan',
        type: 'human',
        parent_plan: '.workflow/plans/MISSING.md'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-MISSING-PLAN' });

      expect(context.related_reports).toEqual([]);
    });

    it('related_reports is empty array when no parent plan', async () => {
      createTicketFile(projectPath, 'ready', 'HUMAN-CLEAR.md', {
        id: 'HUMAN-CLEAR',
        title: 'Clear Reports',
        type: 'human'
      }, 'Body');

      const context = await get_human_context({ project: projectPath, ticket_id: 'HUMAN-CLEAR' });

      expect(context.related_reports).toEqual([]);
    });
  });

  describe('Complex scenarios', () => {
    it('handles all features together: parent_plan, dependencies, pipeline logs, and human type', async () => {
      // Create plan with reports
      createPlanFile(projectPath, 'PLAN-COMPLEX.md', {
        id: 'PLAN-COMPLEX',
        title: 'Complex Plan',
        goals: ['Complex goal'],
        related_reports: ['complex-report.md']
      });

      // Create multiple dependencies
      createTicketFile(projectPath, 'done', 'COMP-DEP-1.md', {
        id: 'COMP-DEP-1',
        title: 'Complex Dep 1',
        type: 'impl'
      }, '## Результат выполнения\n\n### Summary\n\nComplex dependency 1 completed');

      createTicketFile(projectPath, 'done', 'COMP-DEP-2.md', {
        id: 'COMP-DEP-2',
        title: 'Complex Dep 2',
        type: 'impl'
      }, '## Результат выполнения\n\n### Summary\n\nComplex dependency 2 completed with excellent results');

      createTicketFile(projectPath, 'blocked', 'COMP-DEP-3.md', {
        id: 'COMP-DEP-3',
        title: 'Complex Dep 3',
        type: 'impl'
      }, 'Blocked body');

      // Create pipeline log
      createPipelineLog(projectPath,
`2026-04-26T08:00:00: Starting work on ticket_id: COMP-HUMAN
2026-04-26T08:05:00: Checking prerequisites for ticket_id:COMP-HUMAN
2026-04-26T08:10:00: All checks passed for ticket_id: COMP-HUMAN`
      );

      // Create the main human ticket
      createTicketFile(projectPath, 'in-progress', 'COMP-HUMAN.md', {
        id: 'COMP-HUMAN',
        title: 'Complex Human Task',
        type: 'human',
        priority: 1,
        parent_plan: '.workflow/plans/PLAN-COMPLEX.md',
        dependencies: ['COMP-DEP-1', 'COMP-DEP-2', 'COMP-DEP-3']
      }, 'Complex human ticket body with lots of details');

      const context = await get_human_context({ project: projectPath, ticket_id: 'COMP-HUMAN' });

      // Verify ticket
      expect(context.ticket.id).toBe('COMP-HUMAN');
      expect(context.ticket.type).toBe('human');
      expect(context.ticket.title).toBe('Complex Human Task');

      // Verify parent plan
      expect(context.parent_plan.id).toBe('PLAN-COMPLEX');
      expect(context.parent_plan.title).toBe('Complex Plan');

      // Verify related reports from parent plan
      expect(context.related_reports).toEqual(['complex-report.md']);

      // Verify all dependencies resolved
      expect(context.deps).toHaveLength(3);
      expect(context.deps.find(d => d.id === 'COMP-DEP-1').status).toBe('done');
      expect(context.deps.find(d => d.id === 'COMP-DEP-1').result_excerpt).toContain('Complex dependency 1 completed');
      expect(context.deps.find(d => d.id === 'COMP-DEP-2').status).toBe('done');
      expect(context.deps.find(d => d.id === 'COMP-DEP-3').status).toBe('blocked');

      // Verify pipeline logs
      expect(context.pipeline_steps).toHaveLength(3);
      expect(context.pipeline_steps[0].timestamp).toBe('2026-04-26T08:00:00');
      expect(context.pipeline_steps[2].action).toContain('All checks passed');
    });
  });
});
