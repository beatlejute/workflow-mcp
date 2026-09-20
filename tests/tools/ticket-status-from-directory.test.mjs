/**
 * Статус тикета — это каталог, в котором лежит файл.
 *
 * Поле `status` во frontmatter живёт своей жизнью: его пишут скилы и раннер, и
 * оно остаётся тем, чем было в момент последней записи в тикет. Файл при этом
 * переносят между каталогами — именно перенос и есть смена статуса на доске.
 *
 * Два читателя брали статус из frontmatter и расходились с остальными:
 *
 * - `get_project_status` — счётчики доски и `pending_human`. В рабочей области
 *   PulseProxy это давало 6/8/5/4/9 при пустых каталогах и единственном тикете
 *   в `done/`, а два human-тикета из `archive/` числились ожидающими человека,
 *   хотя `list_human_queue` рядом честно показывал их `archive`.
 * - `analytics/aggregate.mjs` — velocity, cycle time и `get_ticket_stats`.
 *
 * Прежние тесты этого не ловили: во всех фикстурах frontmatter совпадал с
 * каталогом, а такой набор зелёный при любом из двух источников.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { get_project_status } from '../../src/tools/projects.mjs';
import { computeStats, computeVelocity, computeCycleTime } from '../../src/analytics/aggregate.mjs';
import { frontmatterCache } from '../../src/caches/frontmatter-cache.mjs';

const DIRS = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

let project;

/**
 * Кладёт тикет в каталог `dir`, а во frontmatter пишет `status` из `fm`.
 * Расхождение между ними — и есть предмет проверки.
 */
function writeTicket(dir, id, fm = {}) {
  const body = {
    id,
    title: `Ticket ${id}`,
    type: 'impl',
    complexity: 'simple',
    created_at: '2026-09-01T00:00:00Z',
    completed_at: '2026-09-02T00:00:00Z',
    ...fm
  };
  const lines = Object.entries(body).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  const filePath = path.join(project, '.workflow', 'tickets', dir, `${id}.md`);
  fs.writeFileSync(filePath, `---\n${lines.join('\n')}\n---\n\nтело\n`);
  return filePath;
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-status-'));
  for (const dir of DIRS) {
    fs.mkdirSync(path.join(project, '.workflow', 'tickets', dir), { recursive: true });
  }
  frontmatterCache.clear?.();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('get_project_status: счётчики доски', () => {
  it('архив не попадает в счётчики, чем бы он себя ни называл', async () => {
    writeTicket('archive', 'OLD-1', { status: 'in-progress' });
    writeTicket('archive', 'OLD-2', { status: 'ready' });

    const status = await get_project_status(project);

    expect(status.counts).toEqual({
      backlog: 0, ready: 0, in_progress: 0, review: 0, blocked: 0, done: 0
    });
  });

  it('тикет считается по каталогу, а не по своему frontmatter', async () => {
    writeTicket('done', 'T-1', { status: 'in-progress' });
    writeTicket('ready', 'T-2', { status: 'done' });

    const status = await get_project_status(project);

    expect(status.counts.done).toBe(1);
    expect(status.counts.ready).toBe(1);
    expect(status.counts.in_progress).toBe(0);
  });
});

describe('get_project_status: pending_human', () => {
  it('human-тикет из архива не ждёт человека', async () => {
    writeTicket('archive', 'HUMAN-5', { type: 'human', status: 'in-progress', priority: 1 });

    const status = await get_project_status(project);

    expect(status.pending_human).toEqual([]);
  });

  it('human-тикет в ready ждёт человека, даже если внутри написано done', async () => {
    writeTicket('ready', 'HUMAN-6', { type: 'human', status: 'done', priority: 2 });

    const status = await get_project_status(project);

    expect(status.pending_human).toEqual([
      { id: 'HUMAN-6', title: 'Ticket HUMAN-6', priority: 2 }
    ]);
  });

  it('совпадает с тем, что отдаёт очередь human-тикетов', async () => {
    // Оба читателя смотрят на одно дерево; расхождение между ними и было
    // первым видимым симптомом.
    writeTicket('archive', 'HUMAN-7', { type: 'human', status: 'ready', priority: 1 });
    writeTicket('blocked', 'HUMAN-8', { type: 'human', status: 'archive', priority: 1 });

    const { list_human_queue } = await import('../../src/tools/human.mjs');
    const status = await get_project_status(project);
    const queue = await list_human_queue({ project });

    const pendingIds = status.pending_human.map((t) => t.id).sort();
    const queuePending = queue.filter((t) => t.status === 'blocked').map((t) => t.id).sort();

    expect(pendingIds).toEqual(['HUMAN-8']);
    expect(queuePending).toEqual(['HUMAN-8']);
    expect(queue.find((t) => t.id === 'HUMAN-7').status).toBe('archive');
  });
});

describe('аналитика', () => {
  it('get_ticket_stats считает по каталогам', () => {
    writeTicket('done', 'S-1', { status: 'backlog' });
    writeTicket('backlog', 'S-2', { status: 'done' });
    writeTicket('blocked', 'S-3', { status: 'ready' });

    const stats = computeStats(project);

    expect(stats.by_status).toEqual({ done: 1, backlog: 1, blocked: 1 });
  });

  it('blocked_top берёт тикеты из каталога blocked', () => {
    writeTicket('blocked', 'S-4', { status: 'ready' });

    expect(computeStats(project).blocked_top.map((t) => t.id)).toEqual(['S-4']);
  });

  it('velocity считает то, что лежит в done', () => {
    writeTicket('done', 'V-1', { status: 'in-progress', complexity: 'medium' });
    // Внутри написано done, но тикет ещё в работе — в velocity ему не место.
    writeTicket('in-progress', 'V-2', { status: 'done', complexity: 'complex' });

    const velocity = computeVelocity(project);

    expect(velocity.count).toBe(1);
    expect(velocity.tickets.map((t) => t.id)).toEqual(['V-1']);
    expect(velocity.sum_complexity).toBe(2);
  });

  it('архив в аналитику не входит вовсе', () => {
    // Архив — это снятые с доски тикеты. Считать их в статистике, velocity и
    // cycle time значит мешать историю проекта с его текущим состоянием.
    writeTicket('archive', 'A-1', { status: 'done' });
    writeTicket('archive', 'A-2', { status: 'blocked' });

    expect(computeStats(project).by_status).toEqual({});
    expect(computeStats(project).blocked_top).toEqual([]);
    expect(computeVelocity(project).count).toBe(0);
    expect(computeCycleTime(project).count).toBe(0);
  });

  it('файл без frontmatter тикетом не считается', () => {
    // Обрывок записи или случайный `.md` в каталоге. Раньше его отсекало
    // требование `status: done` во frontmatter.
    fs.writeFileSync(path.join(project, '.workflow', 'tickets', 'done', 'broken.md'), 'не yaml');
    writeTicket('done', 'OK-1', { status: 'done' });

    expect(computeVelocity(project).count).toBe(1);
    expect(computeStats(project).by_status).toEqual({ done: 1 });
  });

  it('cycle time считает то же множество', () => {
    writeTicket('done', 'C-1', { status: 'review' });
    writeTicket('review', 'C-2', { status: 'done' });

    const cycle = computeCycleTime(project);

    expect(cycle.count).toBe(1);
    expect(cycle.tickets.map((t) => t.id)).toEqual(['C-1']);
  });
});
