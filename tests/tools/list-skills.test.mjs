import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { list_skills } from '../../src/tools/skills.mjs';

// Каталог общих скилов берётся из глобальной установки (`WORKFLOW_HOME`,
// по умолчанию `~/.workflow`), поэтому фикстуры подменяют её на временную.
function useGlobalHome(basePath) {
  const home = path.join(basePath, 'global-home');
  fs.mkdirSync(home, { recursive: true });
  process.env.WORKFLOW_HOME = home;
  return home;
}

// Helper to create test structure with global and project skills
function createProjectWithSkills(basePath, projectName, skillNames = []) {
  const projectPath = path.join(basePath, projectName);

  const globalSkillsDir = path.join(useGlobalHome(basePath), 'skills');
  fs.mkdirSync(globalSkillsDir, { recursive: true });

  // Create .workflow directory for project structure
  fs.mkdirSync(path.join(projectPath, '.workflow'), { recursive: true });

  // Create skill directories in global location
  for (const skillName of skillNames) {
    const skillDir = path.join(globalSkillsDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });

    // Create SKILL.md file for each skill
    const skillMd = `---
name: ${skillName}
description: Test skill ${skillName}
---
# ${skillName}
Test skill content`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);
  }

  return projectPath;
}

// Helper to create a test project without skills directory
function createProjectWithoutSkillsDir(basePath, projectName) {
  const projectPath = path.join(basePath, projectName);

  // Глобальная установка есть, но каталога скилов в ней нет.
  useGlobalHome(basePath);
  fs.mkdirSync(path.join(projectPath, '.workflow'), { recursive: true });

  return projectPath;
}

describe('list_skills', () => {
  let testDir;
  const originalCwd = process.cwd();
  const originalHome = process.env.WORKFLOW_HOME;

  beforeEach(() => {
    // Литерал '/tmp' на Windows даёт путь без буквы диска, а list_skills
    // прогоняет project через path.resolve — сравнение путей разошлось бы.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-list-skills-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.WORKFLOW_HOME;
    } else {
      process.env.WORKFLOW_HOME = originalHome;
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('returns 3 skills with name and path fields when project has 3 skills', async () => {
    const projectPath = createProjectWithSkills(testDir, 'testProject', ['skill1', 'skill2', 'skill3']);

    const skills = await list_skills({ project: projectPath });

    // Verify we got results
    expect(skills).toHaveLength(3);

    // Check each skill has required fields
    for (const skill of skills) {
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('path');
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.path).toBe('string');
    }

    // Verify skill names
    const skillNames = skills.map(s => s.name).sort();
    expect(skillNames).toEqual(['skill1', 'skill2', 'skill3']);
  });

  it('returns empty array when src/skills directory does not exist', async () => {
    const projectPath = createProjectWithoutSkillsDir(testDir, 'testProject');

    const skills = await list_skills({ project: projectPath });

    // Should return empty array, not error
    expect(skills).toEqual([]);
  });

  it('throws INVALID_PROJECT error when project path does not exist', async () => {
    // DoD: Non-existent project → INVALID_PROJECT
    const nonExistentPath = path.join(testDir, 'nonexistent', 'project');

    try {
      await list_skills({ project: nonExistentPath });
      expect.fail('Should have thrown INVALID_PROJECT error');
    } catch (err) {
      expect(err.code).toBe('INVALID_PROJECT');
    }
  });

  it('includes source field for each skill', async () => {
    const projectPath = createProjectWithSkills(testDir, 'testProject', ['skill1', 'skill2']);

    const skills = await list_skills({ project: projectPath });

    expect(skills).toHaveLength(2);

    for (const skill of skills) {
      expect(skill).toHaveProperty('source');
      expect(['shared', 'ejected']).toContain(skill.source);
    }
  });

  it('копия скила в проекте помечается как ejected', async () => {
    const projectPath = createProjectWithSkills(testDir, 'testProject', ['skill1', 'skill2']);

    // Скил, скопированный в проект (не junction), вытесняет общий.
    const ejectedDir = path.join(projectPath, '.workflow', 'src', 'skills', 'skill1');
    fs.mkdirSync(ejectedDir, { recursive: true });
    fs.writeFileSync(path.join(ejectedDir, 'SKILL.md'), '# ejected skill1');

    const skills = await list_skills({ project: projectPath });

    const skill1 = skills.find(s => s.name === 'skill1');
    const skill2 = skills.find(s => s.name === 'skill2');
    expect(skill1.source).toBe('ejected');
    expect(skill1.path).toBe(ejectedDir);
    expect(skill2.source).toBe('shared');
  });

  it('каталог без SKILL.md скилом не считается', async () => {
    const projectPath = createProjectWithSkills(testDir, 'testProject', ['skill1']);

    // В `.workflow/src/skills` проектов лежат и не-скилы — например, папка
    // `shared` с общими документами.
    const sharedDocs = path.join(projectPath, '.workflow', 'src', 'skills', 'shared');
    fs.mkdirSync(sharedDocs, { recursive: true });
    fs.writeFileSync(path.join(sharedDocs, 'README.md'), '# просто документы');

    const skills = await list_skills({ project: projectPath });

    expect(skills.map(s => s.name)).toEqual(['skill1']);
  });

  it('returns correct paths for skills', async () => {
    const projectPath = createProjectWithSkills(testDir, 'testProject', ['skill1', 'skill2']);

    const skills = await list_skills({ project: projectPath });

    expect(skills).toHaveLength(2);

    // Paths should point to skill directories
    for (const skill of skills) {
      expect(skill.path).toContain('skill');
      expect(skill.path).toContain(skill.name);
    }
  });
});
