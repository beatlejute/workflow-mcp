import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { discoverProjects, watchProjects } from '../src/discovery.mjs';

// Helper to create test fixture directories
function createTestDirs(basePath, dirs) {
  for (const dir of dirs) {
    const fullPath = path.join(basePath, dir);
    fs.mkdirSync(fullPath, { recursive: true });
  }
}

// Helper to create .workflow directory
function createWorkflowDir(basePath, projectName) {
  const workflowPath = path.join(basePath, projectName, '.workflow');
  fs.mkdirSync(workflowPath, { recursive: true });
}

  // Helper to create .workflow-mcp.yaml
  function createConfig(basePath, config) {
    const configPath = path.join(basePath, '.workflow-mcp.yaml');
    let yaml = '';
    if (config.projects) {
      yaml += 'projects:\n';
      if (config.projects.whitelist) {
        yaml += `  whitelist:\n`;
        for (const item of config.projects.whitelist) {
          yaml += `    - ${item}\n`;
        }
      }
      if (config.projects.blacklist) {
        yaml += `  blacklist:\n`;
        for (const item of config.projects.blacklist) {
          yaml += `    - ${item}\n`;
        }
      }
    }
    if (config.discovery) {
      yaml += 'discovery:\n';
      for (const [key, value] of Object.entries(config.discovery)) {
        yaml += `  ${key}: ${value}\n`;
      }
    }
    fs.writeFileSync(configPath, yaml, 'utf-8');
  }

describe('discoverProjects', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('discovers projects with .workflow subdirectory', () => {
    createWorkflowDir(testDir, 'projectA');
    createWorkflowDir(testDir, 'projectB');
    fs.mkdirSync(path.join(testDir, 'projectC'), { recursive: true }); // no .workflow

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name).sort()).toEqual(['projectA', 'projectB']);
    expect(projects[0].path).toBe(path.resolve(testDir, projects[0].name));
  });

  it('applies whitelist filter', () => {
    createWorkflowDir(testDir, 'projectA');
    createWorkflowDir(testDir, 'projectB');
    createWorkflowDir(testDir, 'projectC');
    createConfig(testDir, {
      projects: {
        whitelist: ['projectA'],
      },
    });

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('projectA');
  });

  it('applies blacklist filter', () => {
    createWorkflowDir(testDir, 'projectA');
    createWorkflowDir(testDir, 'projectB');
    createWorkflowDir(testDir, 'projectC');
    createConfig(testDir, {
      projects: {
        blacklist: ['projectB'],
      },
    });

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name).sort()).toEqual(['projectA', 'projectC']);
  });

  it('single-project mode: cwd itself contains .workflow', () => {
    const workflowDir = path.join(testDir, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe(path.basename(testDir));
    expect(projects[0].path).toBe(path.resolve(testDir));
  });
  it('single-project mode takes priority over other projects', () => {
    const workflowDir = path.join(testDir, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });
    createWorkflowDir(testDir, 'projectA');
    createWorkflowDir(testDir, 'projectB');

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe(path.basename(testDir));
  });

  it('returns empty array for non-existent cwd', () => {
    const projects = discoverProjects('/tmp/nonexistent-path-12345');
    expect(projects).toEqual([]);
  });

  it('respects empty whitelist', () => {
    createWorkflowDir(testDir, 'projectA');
    createWorkflowDir(testDir, 'projectB');
    createConfig(testDir, {
      projects: {
        whitelist: [],
        blacklist: [],
      },
    });

    const projects = discoverProjects(testDir);
    // Empty whitelist means no projects allowed (when whitelist is explicitly empty)
    // But according to spec: " если пусто и blacklist пуст — сканируются все"
    // So empty whitelist should behave as "no whitelist"
    expect(projects.length).toBeGreaterThan(0);
  });

  it('handles unreadable cwd gracefully', () => {
    const originalReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const projects = discoverProjects(testDir);
    expect(projects).toEqual([]);

    fs.readdirSync.mockRestore();
  });

  it('depth config does not affect depth=1 scanning', () => {
    createWorkflowDir(testDir, 'projectA');
    createConfig(testDir, {
      discovery: {
        depth: 5,
      },
    });

    const projects = discoverProjects(testDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('projectA');
  });
});

describe('watchProjects', () => {
  let testDir;
  let stopFn;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-watch-test-'));
  });

  afterEach(() => {
    if (stopFn) {
      stopFn();
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('calls onChange when a project with .workflow is added', (done) => {
    const onChange = vi.fn(({ added, removed }) => {
      expect(removed).toEqual([]);
      expect(added).toHaveLength(1);
      expect(added[0].name).toBe('projectA');
      expect(added[0].path).toBe(path.join(testDir, 'projectA'));
      done();
    });

    stopFn = watchProjects(testDir, onChange);

    // Create project after a short delay for debounce
    setTimeout(() => {
      const workflowDir = path.join(testDir, 'projectA', '.workflow');
      fs.mkdirSync(workflowDir, { recursive: true });
    }, 100);
  }, 5000);

  it('calls onChange with removed project', (done) => {
    const projectDir = path.join(testDir, 'projectA');
    const workflowDir = path.join(projectDir, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });

    const onChange = vi.fn(({ added, removed }) => {
      if (onChange.mock.calls.length === 1) {
        // First call: project added
        expect(added).toHaveLength(1);
      } else if (onChange.mock.calls.length === 2) {
        // Second call: project removed
        expect(removed).toHaveLength(1);
        expect(removed[0].name).toBe('projectA');
        done();
      }
    });

    stopFn = watchProjects(testDir, onChange);

    setTimeout(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }, 300);
  }, 5000);

  it('stop function stops watching', (done) => {
    const onChange = vi.fn();
    stopFn = watchProjects(testDir, onChange);
    stopFn();

    setTimeout(() => {
      const workflowDir = path.join(testDir, 'projectA', '.workflow');
      fs.mkdirSync(workflowDir, { recursive: true });
      // Wait to ensure no callback
      setTimeout(() => {
        expect(onChange).not.toHaveBeenCalled();
        done();
      }, 500);
    }, 100);
  }, 5000);

  it('debounces rapid changes', (done) => {
    const onChange = vi.fn();
    stopFn = watchProjects(testDir, onChange);

    setTimeout(() => {
      const projectDir = path.join(testDir, 'projectA');
      fs.mkdirSync(path.join(projectDir, '.workflow'), { recursive: true });
      // Another change shortly after
      setTimeout(() => {
        fs.mkdirSync(path.join(testDir, 'projectB', '.workflow'), { recursive: true });
      }, 50);
    }, 100);

    setTimeout(() => {
      // Should have gotten one callback with both changes
      expect(onChange).toHaveBeenCalledTimes(1);
      const args = onChange.mock.calls[0][0];
      expect(args.added.length).toBeGreaterThanOrEqual(1);
      done();
    }, 3000);
  }, 5000);

  it('returns empty array for non-existent cwd without throwing', () => {
    const onChange = vi.fn();
    expect(() => {
      stopFn = watchProjects('/tmp/nonexistent-watch-path-12345', onChange);
    }).not.toThrow();
    if (stopFn) stopFn();
  });

  it('stop can be called multiple times', () => {
    const onChange = vi.fn();
    stopFn = watchProjects(testDir, onChange);
    expect(() => {
      stopFn();
      stopFn();
    }).not.toThrow();
  });
});
