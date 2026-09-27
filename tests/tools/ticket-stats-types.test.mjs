/**
 * get_ticket_stats: by_type знает типы проекта из `task_types` его
 * `.workflow/config/config.yaml`. Прежний жёсткий список не знал `coach` и
 * проектных типов — их тикеты уходили в OTHER.
 *
 * Корень изоляции — временный каталог ОС на каждый тест, удаляется в afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { get_ticket_stats } from '../../src/tools/analytics.mjs';

function writeTicket(project, status, id, type) {
  const dir = path.join(project, '.workflow', 'tickets', status);
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: "t"\ntype: ${type}\ncreated_at: "${createdAt}"\n---\n\nтело\n`,
    'utf8'
  );
}

describe('get_ticket_stats by_type', () => {
  let project;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-stats-types-'));
    fs.mkdirSync(path.join(project, '.workflow', 'tickets', 'backlog'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('counts types listed in the project config task_types, the rest go to OTHER', async () => {
    fs.mkdirSync(path.join(project, '.workflow', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.workflow', 'config', 'config.yaml'),
      'task_types:\n  impl:\n    prefix: IMPL\n  coach:\n    prefix: COACH\n  gml:\n    prefix: GML\n',
      'utf8'
    );
    writeTicket(project, 'backlog', 'COACH-001', 'coach');
    writeTicket(project, 'done', 'GML-001', 'gml');
    writeTicket(project, 'done', 'IMPL-001', 'impl');
    writeTicket(project, 'backlog', 'QA-001', 'qa');

    const stats = await get_ticket_stats.execute({ project });

    expect(stats.by_type).toEqual({ COACH: 1, GML: 1, IMPL: 1, OTHER: 1 });
  });

  it('without a project config uses the default list, which includes coach', async () => {
    writeTicket(project, 'backlog', 'COACH-001', 'coach');
    writeTicket(project, 'backlog', 'IMPL-001', 'impl');
    writeTicket(project, 'backlog', 'ZZZ-001', 'zzz');

    const stats = await get_ticket_stats.execute({ project });

    expect(stats.by_type).toEqual({ COACH: 1, IMPL: 1, OTHER: 1 });
  });

  it('a broken config falls back to the default list instead of failing', async () => {
    fs.mkdirSync(path.join(project, '.workflow', 'config'), { recursive: true });
    fs.writeFileSync(path.join(project, '.workflow', 'config', 'config.yaml'), 'task_types: [unclosed\n', 'utf8');
    writeTicket(project, 'backlog', 'COACH-001', 'coach');

    const stats = await get_ticket_stats.execute({ project });

    expect(stats.by_type).toEqual({ COACH: 1 });
  });
});
