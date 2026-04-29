import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { create_coach_ticket } from '../../src/tools/coach.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

// Helper to create test directories with .workflow structure
function createProjectDir(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');
  const skillsPath = path.join(workflowPath, 'src', 'skills');

  // Create .workflow/tickets/backlog structure
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });

  // Create skills directory with a test skill
  fs.mkdirSync(path.join(skillsPath, 'test-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsPath, 'test-skill', 'SKILL.md'), '# Test Skill', 'utf-8');

  return projectPath;
}

describe('create_coach_ticket', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-coach-'));
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

  // TC-001: Тест создания файла с правильным frontmatter
  it('creates COACH-N ticket file with correct frontmatter', async () => {
    const result = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'This is a valid coach gap description with enough characters',
      evidence_path: '/path/to/evidence.md'
    });

    expect(result.exit_code).toBe(0);

    // Parse response to get ticket ID
    const response = JSON.parse(result.stdout);
    const ticketId = response.ticket_id;
    expect(ticketId).toMatch(/^COACH-\d+$/);

    // Check file exists
    const ticketPath = path.join(projectPath, '.workflow', 'tickets', 'backlog', `${ticketId}.md`);
    expect(fs.existsSync(ticketPath)).toBe(true);

    // Read and verify frontmatter
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter.id).toBe(ticketId);
    expect(frontmatter.type).toBe('COACH');
    expect(frontmatter.title).toContain('Coach gap: test-skill');
  });

  // TC-002: Тест автоинкремента ID (COACH-1, COACH-2, ...)
  it('auto-increments ticket ID from COACH-1 onwards', async () => {
    const result1 = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'First coach gap description with sufficient length'
    });

    const response1 = JSON.parse(result1.stdout);
    const id1 = response1.ticket_id;

    const result2 = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'Second coach gap description with sufficient length'
    });

    const response2 = JSON.parse(result2.stdout);
    const id2 = response2.ticket_id;

    // Extract numbers and verify increment
    const num1 = parseInt(id1.split('-')[1]);
    const num2 = parseInt(id2.split('-')[1]);

    expect(num1).toBeGreaterThan(0);
    expect(num2).toBe(num1 + 1);
  });

  // TC-003: Тест невалидного target_skill → SKILL_NOT_FOUND
  it('returns SKILL_NOT_FOUND for non-existent target_skill', async () => {
    const result = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'non-existent-skill',
      gap_description: 'This is a valid coach gap description with enough characters'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('SKILL_NOT_FOUND');
    expect(result.stderr).toContain('not found');
  });

  // TC-004: Тест gap_description < 20 символов → schema error
  it('returns error for gap_description < 20 characters', async () => {
    const result = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'short desc'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_PARAMETERS');
    expect(result.stderr).toContain('at least 20 characters');
  });

  // TC-005: Тест тегов содержат `coach-gap` и `target_skill:<name>`
  it('sets correct tags with coach-gap and target_skill:<name>', async () => {
    const result = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'This is a valid coach gap description with enough characters'
    });

    expect(result.exit_code).toBe(0);

    const response = JSON.parse(result.stdout);
    const ticketPath = path.join(projectPath, '.workflow', 'tickets', 'backlog', `${response.ticket_id}.md`);
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    expect(Array.isArray(frontmatter.tags)).toBe(true);
    expect(frontmatter.tags).toContain('coach-gap');
    expect(frontmatter.tags).toContain('target_skill:test-skill');
  });

  // TC-006: Тест evidence_path сохраняется в frontmatter
  it('saves evidence_path in frontmatter context.files', async () => {
    const evidencePath = '/path/to/evidence/file.md';

    const result = await create_coach_ticket.execute({
      project: projectPath,
      target_skill: 'test-skill',
      gap_description: 'This is a valid coach gap description with enough characters',
      evidence_path: evidencePath
    });

    expect(result.exit_code).toBe(0);

    const response = JSON.parse(result.stdout);
    const ticketPath = path.join(projectPath, '.workflow', 'tickets', 'backlog', `${response.ticket_id}.md`);
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    // Check that evidence_path is in context.files
    expect(frontmatter.context).toBeDefined();
    expect(Array.isArray(frontmatter.context.files)).toBe(true);
    expect(frontmatter.context.files).toContain(evidencePath);
  });
});
