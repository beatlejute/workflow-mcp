/**
 * FIX-001: list_ghost_executions матчил маркер подстрокой и строил excerpt без
 * ограничения длины.
 *
 * Прецедент 2026-08-04: скан по workflowAi вернул 12 записей — все ложные
 * (тег тикета, commit message, имя файла), а из-за строк AI_APICallError по
 * 232 КБ ответ занял 5.5 МБ.
 *
 * Критерии готовности из тикета:
 * - подстрока в прозе/commit/имени файла не детектится, структурный маркер детектится
 * - размер записи excerpt ограничен
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { list_ghost_executions } from '../../src/tools/diagnostics.mjs';
import { normalizeGhostMarker, buildGhostMarkerMatcher } from '../../src/health/ghost-marker.mjs';

const PROJECT = 'ghost-project';

function createProject(workspaceDir) {
  const projectPath = path.join(workspaceDir, PROJECT);
  fs.mkdirSync(path.join(projectPath, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.workflow', 'tickets', 'backlog'), { recursive: true });
  return projectPath;
}

function writeLog(projectPath, lines, name = 'pipeline_2026-09-18_10-00-00.log') {
  fs.writeFileSync(
    path.join(projectPath, '.workflow', 'logs', name),
    Array.isArray(lines) ? lines.join('\n') : lines,
    'utf8'
  );
}

async function scan() {
  const result = await list_ghost_executions.execute({ project: PROJECT });
  const text = result.content[0].text;
  return { data: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

describe('normalizeGhostMarker', () => {
  it('голое слово оборачивается в скобки и поднимается в верхний регистр', () => {
    expect(normalizeGhostMarker('ghost-execution')).toBe('[GHOST-EXECUTION]');
    expect(normalizeGhostMarker('Ghost-Execution')).toBe('[GHOST-EXECUTION]');
  });

  it('структурный маркер берётся как есть', () => {
    expect(normalizeGhostMarker('[ghost-execution]')).toBe('[ghost-execution]');
    expect(normalizeGhostMarker('ghost_execution_detected=true')).toBe('ghost_execution_detected=true');
  });

  it('пустое значение даёт дефолт', () => {
    expect(normalizeGhostMarker('')).toBe('[GHOST-EXECUTION]');
    expect(normalizeGhostMarker(undefined)).toBe('[GHOST-EXECUTION]');
  });
});

describe('buildGhostMarkerMatcher', () => {
  const matcher = buildGhostMarkerMatcher('ghost-execution');

  it.each([
    ['тег тикета', 'tags: [dod-fill, ticket-update, ghost-execution]'],
    ['commit message', '71b8df6 fix(runner): add E2E ghost-execution gate'],
    ['имя файла', '  -a----  19.04.2026  14:11  4532 ghost-execution-qa-18.log'],
    ['проза в отчёте', '- Новых ghost execution нет'],
    ['склейка без разделителя', 'prefix[GHOST-EXECUTION]suffix']
  ])('не матчит: %s', (_name, line) => {
    expect(matcher.test(line)).toBe(false);
  });

  it.each([
    ['отдельной строкой', '[GHOST-EXECUTION]'],
    ['в строке лога', '[2026-04-21 14:39:38] [WARN] [execute-task] [GHOST-EXECUTION] step=7'],
    ['с двоеточием', '[GHOST-EXECUTION]: IMPL-42 не изменил ни одного файла']
  ])('матчит структурный маркер: %s', (_name, line) => {
    expect(matcher.test(line)).toBe(true);
  });
});

describe('list_ghost_executions', () => {
  let workspaceDir;
  let projectPath;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-scan-'));
    projectPath = createProject(workspaceDir);
    process.env.MCP_CWD = workspaceDir;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    delete process.env.MCP_CWD;
    try {
      process.chdir(originalCwd);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('лог целиком из прозаических упоминаний даёт 0 записей', async () => {
    writeLog(projectPath, [
      '[2026-04-21 14:39:38] [INFO] [execute-task] tags: [dod-fill, ghost-execution]',
      '[2026-04-21 14:39:39] [WARN] [execute-task] 71b8df6 add E2E ghost-execution gate',
      '[2026-04-21 14:39:40] [INFO] [create-report] Новых ghost execution не обнаружено',
      '[2026-04-21 14:39:41] [WARN] [execute-task]   -a---- 4532 ghost-execution-qa-18.log'
    ]);

    const { data } = await scan();

    expect(data.count).toBe(0);
    expect(data.executions).toEqual([]);
  });

  it('структурный маркер детектится', async () => {
    writeLog(projectPath, [
      '[2026-04-21 14:39:38] [INFO] [PipelineRunner] Step 7',
      '[2026-04-21 14:39:39] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42',
      '[2026-04-21 14:39:40] [INFO] [review-result] done'
    ]);

    const { data } = await scan();

    expect(data.count).toBe(1);
    expect(data.executions[0].step_number).toBe(7);
    expect(data.executions[0].log_excerpt).toContain('[GHOST-EXECUTION]');
  });

  it('длинные строки в excerpt обрезаются', async () => {
    const huge = `[2026-04-21 14:39:37] [WARN] [execute-task] AI_APICallError ${'x'.repeat(250000)}`;
    writeLog(projectPath, [
      huge,
      '[2026-04-21 14:39:39] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42'
    ]);

    const { data, bytes } = await scan();

    expect(data.count).toBe(1);
    expect(data.executions[0].log_excerpt).toContain('обрезано');
    // Без капа сюда попадали бы все 250 КБ одной строкой
    expect(bytes).toBeLessThan(100 * 1024);
  });

  it('excerpt записи целиком ограничен', async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`[2026-04-21 14:39:3${i}] [WARN] [execute-task] ${'y'.repeat(480)}`);
    }
    lines.push('[2026-04-21 14:39:39] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42');
    for (let i = 0; i < 5; i++) {
      lines.push(`[2026-04-21 14:39:4${i}] [WARN] [execute-task] ${'z'.repeat(480)}`);
    }
    writeLog(projectPath, lines);

    const { data } = await scan();

    expect(data.count).toBe(1);
    expect(data.executions[0].log_excerpt.length).toBeLessThanOrEqual(4100);
  });

  it('соседние совпадения не дублируются', async () => {
    // Три маркера подряд попадают в один и тот же ±5-строчный excerpt
    writeLog(projectPath, [
      '[2026-04-21 14:39:38] [INFO] [PipelineRunner] Step 7',
      '[2026-04-21 14:39:39] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42',
      '[2026-04-21 14:39:40] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42',
      '[2026-04-21 14:39:41] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42'
    ]);

    const { data } = await scan();

    expect(data.count).toBe(1);
  });

  it('разнесённые совпадения считаются отдельно', async () => {
    const lines = ['[2026-04-21 14:39:38] [INFO] [PipelineRunner] Step 7'];
    lines.push('[2026-04-21 14:39:39] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-42');
    for (let i = 0; i < 20; i++) {
      lines.push(`[2026-04-21 14:40:0${i % 10}] [INFO] [execute-task] работа`);
    }
    lines.push('[2026-04-21 14:41:00] [ERROR] [review-result] [GHOST-EXECUTION] IMPL-43');
    writeLog(projectPath, lines);

    const { data } = await scan();

    expect(data.count).toBe(2);
  });
});
