/**
 * Все tools резолвят `project` от одного корня.
 *
 * Рабочий каталог процесса задаёт клиент, поэтому корнем рабочей области
 * служит `MCP_CWD`. Половина tools читала `process.cwd()` напрямую: при
 * запуске из stdio-клиента один и тот же `project: "projA"` одни tools
 * находили, а другие отвечали «Project not found» — `list_reports`,
 * `get_report`, `pause_pipeline`, все пять `git_*`, `get_project_status`,
 * `get_velocity`, `get_cycle_time`, `get_ticket_stats`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { list_reports, get_report } from '../../src/tools/reports.mjs';
import { pause_pipeline } from '../../src/tools/pipeline.mjs';
import { get_project_status_tool } from '../../src/tools/projects.mjs';
import { get_velocity_tool, get_cycle_time_tool, get_ticket_stats } from '../../src/tools/analytics.mjs';
import gitTools from '../../src/tools/git.mjs';

const STATUSES = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];
const NOT_FOUND = /not a workflow project|not found in discovery|does not exist/i;

/** Текст ошибки, чем бы она ни была: throw, {error}, {message} или {ok:false}. */
async function failureText(fn) {
  try {
    const result = await fn();
    if (result && (result.error || result.ok === false)) {
      return `${result.error ?? result.code ?? ''} ${result.message ?? ''}`.trim();
    }
    return null;
  } catch (err) {
    return err.message;
  }
}

describe('резолв project от MCP_CWD', () => {
  let root;
  let savedMcpCwd;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cwd-')));
    const project = path.join(root, 'projA');

    for (const st of STATUSES) {
      fs.mkdirSync(path.join(project, '.workflow', 'tickets', st), { recursive: true });
    }
    fs.mkdirSync(path.join(project, '.workflow', 'reports'), { recursive: true });
    fs.mkdirSync(path.join(project, '.workflow', 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(project, '.workflow', 'reports', 'RPT-1.md'),
      '---\nid: "RPT-1"\ntitle: "отчёт"\ntype: "verification"\ncreated_at: "2026-01-01T00:00:00Z"\n---\n\nтело\n'
    );
    fs.writeFileSync(
      path.join(project, '.workflow', 'tickets', 'done', 'IMPL-1.md'),
      '---\nid: "IMPL-1"\ntitle: "тест"\nstatus: done\ntype: implementation\n---\n\nтело\n'
    );

    savedMcpCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = root;
    // cwd процесса намеренно другой — это корень репозитория, а не root.
    expect(path.resolve(process.cwd())).not.toBe(root);
  });

  afterAll(() => {
    if (savedMcpCwd === undefined) {
      delete process.env.MCP_CWD;
    } else {
      process.env.MCP_CWD = savedMcpCwd;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // временная папка могла быть уже убрана
    }
  });

  it('list_reports видит проект по имени', async () => {
    const reports = await list_reports.execute({ project: 'projA' });
    expect(reports.map((r) => r.id)).toContain('RPT-1');
  });

  it('get_report видит проект по имени', async () => {
    const report = await get_report.execute({ project: 'projA', report_id: 'RPT-1' });
    expect(report.frontmatter.id).toBe('RPT-1');
  });

  it('get_project_status видит проект по имени', async () => {
    const status = await get_project_status_tool.execute({ project: 'projA' });
    expect(status.error).toBeUndefined();
    expect(status.counts.done).toBe(1);
  });

  it('аналитика видит проект по имени', async () => {
    for (const tool of [get_velocity_tool, get_cycle_time_tool, get_ticket_stats]) {
      const result = await tool.execute({ project: 'projA' });
      expect(result.error, `${tool.name}: ${result.message ?? ''}`).toBeUndefined();
    }
  });

  it('pause_pipeline доходит до проверки пайплайна, а не падает на проекте', async () => {
    // Пайплайна нет — ошибка ожидаема, но она не про ненайденный проект.
    const text = await failureText(() => pause_pipeline.execute({ project: 'projA' }));
    expect(text).not.toMatch(NOT_FOUND);
  });

  it('все git_* доходят до проверки репозитория, а не падают на проекте', async () => {
    const args = {
      git_status: {},
      git_diff: {},
      git_commit: { message: 'x' },
      git_create_branch: { name: 'feature/x' },
      git_open_pr: { title: 'x' }
    };

    for (const tool of gitTools) {
      const text = await failureText(() => tool.execute({ project: 'projA', ...args[tool.name] }));
      expect(text, `${tool.name}: ${text}`).not.toMatch(NOT_FOUND);
    }
  });

  it('watcher лога получает корень от сервера, а не от cwd процесса', async () => {
    // `start_pipeline_log_watch` принимал cwd и не передавал его в
    // `startWatching`: тот звал discovery от `process.cwd()`, проекта не
    // находил и молча не ставил watcher. Чтение ресурса при этом работало,
    // поэтому дефект был виден только по отсутствию `resources/updated`.
    const { start_pipeline_log_watch, stop_pipeline_log_watch } =
      await import('../../src/resources/index.mjs');

    const logsDir = path.join(root, 'projA', '.workflow', 'logs');
    fs.writeFileSync(path.join(logsDir, 'pipeline_2026-01-01_00-00-00.log'), 'первая строка\n');

    let fired = 0;
    await start_pipeline_log_watch(root, 'projA', () => { fired += 1; });

    try {
      // Дать watcher'у встать, затем дописать в лог.
      await new Promise((r) => setTimeout(r, 300));
      fs.appendFileSync(path.join(logsDir, 'pipeline_2026-01-01_00-00-00.log'), 'вторая строка\n');

      const deadline = Date.now() + 5000;
      while (fired === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fired).toBeGreaterThan(0);
    } finally {
      await stop_pipeline_log_watch('projA');
    }
  });

  it('несуществующий проект всё же отвергается', async () => {
    const text = await failureText(() => list_reports.execute({ project: 'nope' }));
    expect(text).toMatch(NOT_FOUND);
  });
});
