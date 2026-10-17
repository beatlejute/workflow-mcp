import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjects } from '../../src/discovery.mjs';
import { resolveProjectRoot, tryResolveProjectRoot } from '../../src/lib/project-root.mjs';
import { list_reports } from '../../src/tools/reports.mjs';

const roots = [];
const savedMcpCwd = process.env.MCP_CWD;

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-project-root-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  if (savedMcpCwd === undefined) {
    delete process.env.MCP_CWD;
  } else {
    process.env.MCP_CWD = savedMcpCwd;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('project root workflow markers', () => {
  it.each(['empty', 'state-only'])('rejects a %s workspace root', (shape) => {
    const root = createRoot();
    const workflowDir = path.join(root, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });
    if (shape === 'state-only') {
      fs.mkdirSync(path.join(workflowDir, 'state'), { recursive: true });
      fs.mkdirSync(path.join(workflowDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(workflowDir, 'approvals'), { recursive: true });
    }

    for (const project of ['.', root]) {
      expect(() => resolveProjectRoot(project, { cwd: root })).toThrowError(
        expect.objectContaining({ code: 'INVALID_PROJECT' })
      );
      expect(tryResolveProjectRoot(project, { cwd: root }).ok).toBe(false);
    }
  });

  it.each(['tickets', 'config', 'plans'])('accepts a root with a %s directory marker', (marker) => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, '.workflow', marker), { recursive: true });

    expect(resolveProjectRoot('.', { cwd: root })).toBe(root);
    expect(tryResolveProjectRoot(root, { cwd: root })).toEqual({ ok: true, root });
  });

  it.each(['tickets', 'config', 'plans'])('does not accept a %s file as a marker', (marker) => {
    const root = createRoot();
    const workflowDir = path.join(root, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, marker), 'not a directory');

    expect(tryResolveProjectRoot('.', { cwd: root }).ok).toBe(false);
  });

  it('keeps empty child workflow directories discoverable and resolvable by name or path', async () => {
    const root = createRoot();
    const child = path.join(root, 'child-project');
    fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
    fs.mkdirSync(path.join(child, '.workflow'), { recursive: true });
    process.env.MCP_CWD = root;

    expect(discoverProjects(root)).toEqual([{ name: 'child-project', path: child }]);
    expect(resolveProjectRoot('child-project', { cwd: root })).toBe(child);
    expect(resolveProjectRoot(child, { cwd: root })).toBe(child);
    await expect(list_reports.execute({ project: root })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
    await expect(list_reports.execute({ project: 'child-project' })).resolves.toEqual([]);
  });
});
