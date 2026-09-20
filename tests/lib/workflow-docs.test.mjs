/**
 * Служебные файлы не должны выходить из списков как документы.
 *
 * `workflow init` кладёт `.gitkeep.md` в каждый каталог `.workflow/`. Живьём
 * он выходил из `list_blocked_tickets` тикетом с id `.gitkeep`, а из
 * `list_plans` — двумя «планами» со статусом `unknown`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isWorkflowDoc } from '../../src/lib/workflow-docs.mjs';
import blockedTicketsTool from '../../src/tools/diagnostics.mjs';
import { list_tickets } from '../../src/tools/tickets.mjs';
import { list_reports } from '../../src/tools/reports.mjs';

let workspace;
let prevMcpCwd;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-docs-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Проект со служебным `.gitkeep.md` и одним настоящим тикетом. */
function makeProject(name = 'proj') {
  const root = path.join(workspace, name);
  for (const status of ['backlog', 'ready', 'blocked', 'done']) {
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', status), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.workflow', 'tickets', status, '.gitkeep.md'),
      '# Blocked\n\nОписание каталога без frontmatter.\n',
      'utf8'
    );
  }
  fs.mkdirSync(path.join(root, '.workflow', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workflow', 'reports', '.gitkeep.md'), '# Reports\n', 'utf8');
  fs.writeFileSync(
    path.join(root, '.workflow', 'reports', 'REPORT-001.md'),
    '---\nid: REPORT-001\ntitle: Отчёт\ncreated_at: "2026-09-01T00:00:00.000Z"\n---\n\nтекст\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(root, '.workflow', 'tickets', 'blocked', 'FIX-001.md'),
    '---\nid: FIX-001\ntitle: Настоящий тикет\ntype: fix\npriority: 2\n---\n\nтекст\n',
    'utf8'
  );
  return root;
}

describe('isWorkflowDoc', () => {
  it('markdown без точки в начале — документ', () => {
    expect(isWorkflowDoc('FIX-001.md')).toBe(true);
  });

  it('точечный markdown — служебный файл', () => {
    expect(isWorkflowDoc('.gitkeep.md')).toBe(false);
  });

  it('не markdown — не документ', () => {
    expect(isWorkflowDoc('notes.txt')).toBe(false);
    expect(isWorkflowDoc('')).toBe(false);
    expect(isWorkflowDoc(undefined)).toBe(false);
  });
});

describe('служебные файлы в списках', () => {
  it('list_blocked_tickets не показывает .gitkeep', async () => {
    makeProject();

    const result = await blockedTicketsTool.execute({});

    expect(result.tickets.map((t) => t.id)).toEqual(['FIX-001']);
    expect(result.count).toBe(1);
  });

  it('list_tickets не показывает .gitkeep', async () => {
    makeProject();

    const tickets = await list_tickets({ project: 'proj' });

    expect(tickets.map((t) => t.id)).toEqual(['FIX-001']);
  });

  it('list_reports не показывает .gitkeep', async () => {
    makeProject();

    const reports = await list_reports.execute({ project: 'proj' });

    expect(reports.map((r) => r.id)).toEqual(['REPORT-001']);
  });
});
