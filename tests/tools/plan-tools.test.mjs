import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { list_plans, get_plan } from '../../src/tools/plans.mjs';

// Helper to create test directories with .workflow structure
function createProjectDir(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  // Create .workflow structure
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'review'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'blocked'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });

  // Create plans structure (in project root, not in .workflow)
  fs.mkdirSync(path.join(projectPath, 'plans', 'current'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'plans', 'archive'), { recursive: true });

  return projectPath;
}

// Helper to create a plan file
function createPlanFile(projectPath, location, filename, frontmatter, body = '') {
  const planPath = path.join(projectPath, 'plans', location, filename);

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

  fs.writeFileSync(planPath, content, 'utf-8');
  return planPath;
}

describe('Plan Tools', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-plan-tools-'));
    projectPath = createProjectDir(testDir);
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  describe('list_plans', () => {
    it('returns all plans from current/ and archive/ directories with status field', async () => {
      // Create plans in current directory
      createPlanFile(projectPath, 'current', 'PLAN-001.md', {
        id: 'PLAN-001',
        title: 'Current Plan 1',
        status: 'active'
      }, 'Plan body 1');

      createPlanFile(projectPath, 'current', 'PLAN-002.md', {
        id: 'PLAN-002',
        title: 'Current Plan 2',
        status: 'draft'
      }, 'Plan body 2');

      // Create plan in archive directory
      createPlanFile(projectPath, 'archive', 'PLAN-003.md', {
        id: 'PLAN-003',
        title: 'Archived Plan',
        status: 'completed'
      }, 'Plan body 3');

      const plans = await list_plans({ project: projectPath });

      expect(plans).toHaveLength(3);
      expect(plans.some(p => p.id === 'PLAN-001')).toBe(true);
      expect(plans.some(p => p.id === 'PLAN-002')).toBe(true);
      expect(plans.some(p => p.id === 'PLAN-003')).toBe(true);

      // All plans should have status field
      for (const plan of plans) {
        expect(plan).toHaveProperty('status');
        expect(plan).toHaveProperty('id');
        expect(plan).toHaveProperty('title');
        expect(plan).toHaveProperty('path');
      }
    });

    it('returns empty array when no plans exist', async () => {
      const plans = await list_plans({ project: projectPath });

      expect(plans).toEqual([]);
    });

    it('filters plans by status when status parameter provided', async () => {
      createPlanFile(projectPath, 'current', 'PLAN-001.md', {
        id: 'PLAN-001',
        title: 'Active Plan',
        status: 'active'
      });

      createPlanFile(projectPath, 'current', 'PLAN-002.md', {
        id: 'PLAN-002',
        title: 'Draft Plan',
        status: 'draft'
      });

      const activePlans = await list_plans({ project: projectPath, status: 'active' });

      expect(activePlans).toHaveLength(1);
      expect(activePlans[0].id).toBe('PLAN-001');
      expect(activePlans[0].status).toBe('active');
    });

    it('throws INVALID_PROJECT error for non-existent project', async () => {
      // DoD: Non-existent project → INVALID_PROJECT
      const nonExistentPath = path.join(testDir, 'nonexistent-project-xyz');

      try {
        await list_plans({ project: nonExistentPath });
        expect.fail('Should have thrown INVALID_PROJECT error');
      } catch (err) {
        expect(err.code).toBe('INVALID_PROJECT');
      }
    });

    it('throws error for project without .workflow directory', async () => {
      const invalidProjectPath = path.join(testDir, 'no-workflow');
      fs.mkdirSync(invalidProjectPath, { recursive: true });

      await expect(list_plans({ project: invalidProjectPath }))
        .rejects
        .toThrow(/not a workflow project/);
    });
  });

  describe('get_plan', () => {
    it('returns complete plan data (frontmatter + body + tickets)', async () => {
      const planPath = createPlanFile(projectPath, 'current', 'PLAN-001.md', {
        id: 'PLAN-001',
        title: 'Test Plan',
        status: 'active'
      }, 'This is the plan body\nwith multiple lines');

      const plan = await get_plan({ project: projectPath, plan_id: 'PLAN-001' });

      expect(plan).toHaveProperty('frontmatter');
      expect(plan).toHaveProperty('body');
      expect(plan).toHaveProperty('tickets');
      expect(plan).toHaveProperty('human_tickets');

      expect(plan.frontmatter.id).toBe('PLAN-001');
      expect(plan.frontmatter.title).toBe('Test Plan');
      expect(plan.body).toContain('This is the plan body');
      expect(Array.isArray(plan.tickets)).toBe(true);
      expect(Array.isArray(plan.human_tickets)).toBe(true);
    });

    it('returns plan from archive directory', async () => {
      createPlanFile(projectPath, 'archive', 'PLAN-ARCHIVED.md', {
        id: 'PLAN-ARCHIVED',
        title: 'Archived Plan',
        status: 'completed'
      }, 'Archived body');

      const plan = await get_plan({ project: projectPath, plan_id: 'PLAN-ARCHIVED' });

      expect(plan.frontmatter.id).toBe('PLAN-ARCHIVED');
      expect(plan.frontmatter.title).toBe('Archived Plan');
      expect(plan.body).toContain('Archived body');
    });

    it('throws PLAN_NOT_FOUND error for non-existent plan', async () => {
      await expect(get_plan({
        project: projectPath,
        plan_id: 'NON-EXISTENT'
      }))
        .rejects
        .toThrow(/Plan not found/);
    });

    it('throws error with PLAN_NOT_FOUND code for non-existent plan', async () => {
      try {
        await get_plan({
          project: projectPath,
          plan_id: 'NON-EXISTENT'
        });
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.code).toBe('PLAN_NOT_FOUND');
      }
    });

    it('throws INVALID_PLAN_ID error for path traversal in plan_id', async () => {
      // DoD: Path traversal in plan_id (e.g., '../../etc/passwd') → INVALID_PLAN_ID
      try {
        await get_plan({
          project: projectPath,
          plan_id: '../../etc/passwd'
        });
        expect.fail('Should have thrown INVALID_PLAN_ID error');
      } catch (err) {
        expect(err.code).toBe('INVALID_PLAN_ID');
      }
    });

    it('throws INVALID_PROJECT error for non-existent project', async () => {
      // DoD: Non-existent project → INVALID_PROJECT
      const nonExistentPath = path.join(testDir, 'nonexistent-project-xyz');

      try {
        await get_plan({
          project: nonExistentPath,
          plan_id: 'PLAN-001'
        });
        expect.fail('Should have thrown INVALID_PROJECT error');
      } catch (err) {
        expect(err.code).toBe('INVALID_PROJECT');
      }
    });

    it('case-insensitive plan ID matching', async () => {
      createPlanFile(projectPath, 'current', 'PLAN-001.md', {
        id: 'PLAN-001',
        title: 'Case Test',
        status: 'active'
      }, 'Body');

      // Should find the plan regardless of case
      const plan = await get_plan({ project: projectPath, plan_id: 'plan-001' });

      expect(plan.frontmatter.id).toBe('PLAN-001');
    });
  });

  describe('Error Handling', () => {
    it('handles plan with missing frontmatter fields gracefully', async () => {
      // Create plan with minimal frontmatter
      const planPath = path.join(projectPath, 'plans', 'current', 'PLAN-MIN.md');
      fs.writeFileSync(planPath, '---\n---\nBody only', 'utf-8');

      const plans = await list_plans({ project: projectPath });

      expect(plans).toHaveLength(1);
      expect(plans[0]).toHaveProperty('id');
      expect(plans[0]).toHaveProperty('status');
    });

    it('list_plans handles empty plans directories', async () => {
      // Create empty plans directories (already done in beforeEach)
      const plans = await list_plans({ project: projectPath });

      expect(plans).toEqual([]);
    });
  });
});
