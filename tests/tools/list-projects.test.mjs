import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { list_projects, refresh_projects } from '../../src/tools/projects.mjs';

// Helper to create test directories with .workflow structure
function createProjectDir(basePath, projectName, withTickets = false) {
  const projectPath = path.join(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  // Create .workflow structure
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'review'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'blocked'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });

  if (withTickets) {
    // Create sample tickets
    const ticket = `---
id: TEST-1
title: Test Ticket
type: impl
---
Test content`;
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'backlog', 'TEST-1.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'ready', 'TEST-2.md'), ticket);
  }
}

// Helper to create config file
function createConfig(basePath, config) {
  const configPath = path.join(basePath, '.workflow-mcp.yaml');
  let yaml = '';

  if (config.projects) {
    yaml += 'projects:\n';
    if (config.projects.whitelist && config.projects.whitelist.length > 0) {
      yaml += `  whitelist:\n`;
      for (const item of config.projects.whitelist) {
        yaml += `    - ${item}\n`;
      }
    }
    if (config.projects.blacklist && config.projects.blacklist.length > 0) {
      yaml += `  blacklist:\n`;
      for (const item of config.projects.blacklist) {
        yaml += `    - ${item}\n`;
      }
    }
  }

  fs.writeFileSync(configPath, yaml, 'utf-8');
}

describe('list_projects', () => {
  let testDir;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-list-projects-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('returns 3 projects with correct fields (name, path, counts)', async () => {
    // Create 3 projects
    createProjectDir(testDir, 'projectA', true);
    createProjectDir(testDir, 'projectB', false);
    createProjectDir(testDir, 'projectC', false);

    // Change to test directory
    process.chdir(testDir);

    const projects = await list_projects();

    expect(projects).toHaveLength(3);

    // Check each project has required fields
    for (const project of projects) {
      expect(project).toHaveProperty('name');
      expect(project).toHaveProperty('path');
      expect(project).toHaveProperty('counts');
      expect(project).toHaveProperty('human_count');
      expect(project).toHaveProperty('pipeline_running');

      // Verify path is absolute
      expect(project.path).toBe(path.resolve(project.path));

      // Verify counts structure
      expect(project.counts).toHaveProperty('backlog');
      expect(project.counts).toHaveProperty('ready');
      expect(project.counts).toHaveProperty('in_progress');
      expect(project.counts).toHaveProperty('review');
      expect(project.counts).toHaveProperty('blocked');
      expect(project.counts).toHaveProperty('done');
    }
  });

  it('counts tickets correctly by status', async () => {
    const projectPath = path.join(testDir, 'projectA');
    const workflowPath = path.join(projectPath, '.workflow');

    fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'review'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'blocked'), { recursive: true });

    // Create tickets in different statuses
    const ticket = `---
id: TEST-1
title: Test Ticket
type: impl
---
Test content`;

    fs.writeFileSync(path.join(workflowPath, 'tickets', 'backlog', 'TEST-1.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'backlog', 'TEST-2.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'ready', 'TEST-3.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'in-progress', 'TEST-4.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'done', 'TEST-5.md'), ticket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'done', 'TEST-6.md'), ticket);

    process.chdir(testDir);
    const projects = await list_projects();

    expect(projects).toHaveLength(1);
    const counts = projects[0].counts;
    expect(counts.backlog).toBe(2);
    expect(counts.ready).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.done).toBe(2);
    expect(counts.review).toBe(0);
    expect(counts.blocked).toBe(0);
  });

  it('applies whitelist filter correctly', async () => {
    // Create 3 projects
    createProjectDir(testDir, 'projectA', false);
    createProjectDir(testDir, 'projectB', false);
    createProjectDir(testDir, 'projectC', false);

    // Create config with whitelist
    createConfig(testDir, {
      projects: {
        whitelist: ['projectA', 'projectB']
      }
    });

    process.chdir(testDir);
    const projects = await list_projects();

    // Should only return projectA and projectB
    expect(projects).toHaveLength(2);
    const names = projects.map(p => p.name).sort();
    expect(names).toEqual(['projectA', 'projectB']);
  });

  it('applies blacklist filter correctly', async () => {
    // Create 3 projects
    createProjectDir(testDir, 'projectA', false);
    createProjectDir(testDir, 'projectB', false);
    createProjectDir(testDir, 'projectC', false);

    // Create config with blacklist
    createConfig(testDir, {
      projects: {
        blacklist: ['projectB']
      }
    });

    process.chdir(testDir);
    const projects = await list_projects();

    // Should return projectA and projectC (not projectB)
    expect(projects).toHaveLength(2);
    const names = projects.map(p => p.name).sort();
    expect(names).toEqual(['projectA', 'projectC']);
  });

  it('returns empty array for folder with no .workflow directories', async () => {
    // Create folders without .workflow
    fs.mkdirSync(path.join(testDir, 'folderA'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'folderB'), { recursive: true });

    process.chdir(testDir);
    const projects = await list_projects();

    // Should return empty array, not error
    expect(projects).toEqual([]);
  });

  it('handles single-project mode when cwd contains .workflow', async () => {
    // Create .workflow in the test directory itself (single-project mode)
    const workflowPath = path.join(testDir, '.workflow');
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'review'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'blocked'), { recursive: true });

    process.chdir(testDir);
    const projects = await list_projects();

    // In single-project mode, should return the project with cwd's basename
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe(path.basename(testDir));
    expect(projects[0].path).toBe(path.resolve(testDir));
  });

  it('counts human tickets correctly', async () => {
    const projectPath = path.join(testDir, 'projectA');
    const workflowPath = path.join(projectPath, '.workflow');

    fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
    fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });

    // Create regular ticket
    const implTicket = `---
id: IMPL-1
title: Implementation Ticket
type: impl
---
Implementation`;

    // Create human ticket
    const humanTicket = `---
id: HUM-1
title: Human Ticket
type: human
---
Human task`;

    fs.writeFileSync(path.join(workflowPath, 'tickets', 'backlog', 'IMPL-1.md'), implTicket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'ready', 'HUM-1.md'), humanTicket);
    fs.writeFileSync(path.join(workflowPath, 'tickets', 'ready', 'HUM-2.md'), humanTicket);

    process.chdir(testDir);
    const projects = await list_projects();

    expect(projects).toHaveLength(1);
    expect(projects[0].human_count).toBe(2);
  });
});

describe('refresh_projects', () => {
  let testDir;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-refresh-projects-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('discovers newly added projects', async () => {
    // Create initial projects
    createProjectDir(testDir, 'projectA', false);
    createProjectDir(testDir, 'projectB', false);

    process.chdir(testDir);

    // First list
    const list1 = await list_projects();
    expect(list1).toHaveLength(2);

    // Add a new project
    createProjectDir(testDir, 'projectC', false);

    // Refresh
    const refreshResult = await refresh_projects();

    // Should include the new project in added
    expect(refreshResult).toHaveProperty('added');
    expect(refreshResult).toHaveProperty('removed');
    expect(refreshResult).toHaveProperty('total');

    // After refresh, list_projects should see the new project
    const list2 = await list_projects();
    expect(list2).toHaveLength(3);
    const names = list2.map(p => p.name).sort();
    expect(names).toEqual(['projectA', 'projectB', 'projectC']);
  });

  it('returns correct refresh result structure', async () => {
    createProjectDir(testDir, 'projectA', false);
    process.chdir(testDir);

    const result = await refresh_projects();

    // Verify structure
    expect(result).toHaveProperty('added');
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('total');
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(result.total).toBe(result.added.length);
  });

  it('includes project paths in added array', async () => {
    createProjectDir(testDir, 'projectA', false);
    createProjectDir(testDir, 'projectB', false);

    process.chdir(testDir);

    const result = await refresh_projects();

    // Each item in added should have name and path
    for (const project of result.added) {
      expect(project).toHaveProperty('name');
      expect(project).toHaveProperty('path');
      expect(project.path).toBe(path.resolve(project.path));
    }
  });
});
