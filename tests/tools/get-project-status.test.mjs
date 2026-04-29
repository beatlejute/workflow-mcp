/**
 * Tests for get_project_status MCP tool
 *
 * DoD QA-20:
 *  1. Агрегация по стадиям (backlog/ready/in_progress/done) корректна
 *  2. Pipeline-log данные попадают в ответ (поле recent_steps, см. IMPL-18)
 *  3. Несуществующий project → INVALID_PROJECT error
 *  4. Повторный вызов использует frontmatter cache (fs.readFile не вызывается повторно)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { get_project_status } from '../../src/tools/projects.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Создаёт временный проект с нужной структурой.
 * @param {Object} options
 * @param {boolean} [options.withWorkflow=true] — создать .workflow/
 * @param {Record<string,number>} [options.tickets] — { backlog: N, ready: N, … }
 * @param {string} [options.pipelineLog] — содержимое pipeline-лога
 * @param {string} [options.logName] — имя файла лога
 * @returns {string} абсолютный путь к временной директории
 */
function createProjectFixture(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa20-'));
  const workflowDir = path.join(tempDir, '.workflow');

  if (options.withWorkflow !== false) {
    const stages = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
    for (const stage of stages) {
      fs.mkdirSync(path.join(workflowDir, 'tickets', stage), { recursive: true });
    }
  }

  if (options.tickets) {
    let counter = 0;
    for (const [stage, count] of Object.entries(options.tickets)) {
      const dirName = stage === 'in_progress' ? 'in-progress' : stage;
      const dir = path.join(workflowDir, 'tickets', dirName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) {
        counter++;
        const id = `T-${counter}`;
        const content = `---\nid: ${id}\ntitle: Ticket ${id}\ntype: impl\n---\n# Content`;
        fs.writeFileSync(path.join(dir, `${id}.md`), content);
      }
    }
  }

  if (options.pipelineLog) {
    const logsDir = path.join(workflowDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logName = options.logName ?? 'pipeline_2026-04-27_10-00-00.log';
    fs.writeFileSync(path.join(logsDir, logName), options.pipelineLog);
  }

  return tempDir;
}

/** Образец pipeline-лога с одним шагом */
function samplePipelineLog() {
  return [
    '[2026-04-27 10:00:00] [INFO] [PipelineRunner] Step 1',
    '[2026-04-27 10:00:00] [INFO] [PipelineRunner] START stage="pick-task" agent="pick-first-task"',
    '[2026-04-27 10:00:01] [INFO] [PipelineRunner] Context:',
    '[2026-04-27 10:00:01] [INFO] [pick-first-task]   ticket_id: IMPL-1',
    '[2026-04-27 10:00:02] [INFO] [PipelineRunner] COMPLETE stage="pick-task" status="success" exitCode=0',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TC-01: Агрегация по стадиям
// ---------------------------------------------------------------------------

describe('TC-01: Aggregation of ticket counts by stages', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('returns correct counts when tickets exist in backlog/ready/in-progress/done', async () => {
    tempDir = createProjectFixture({
      tickets: { backlog: 3, ready: 2, in_progress: 1, done: 4 },
    });

    const result = await get_project_status(tempDir);

    expect(result).toHaveProperty('counts');
    expect(result.counts.backlog).toBe(3);
    expect(result.counts.ready).toBe(2);
    expect(result.counts.in_progress).toBe(1);
    expect(result.counts.done).toBe(4);
  });

  it('returns zero counts for an empty project', async () => {
    tempDir = createProjectFixture({});

    const result = await get_project_status(tempDir);

    expect(result.counts.backlog).toBe(0);
    expect(result.counts.ready).toBe(0);
    expect(result.counts.in_progress).toBe(0);
    expect(result.counts.done).toBe(0);
  });

  it('counts has all required fields (backlog, ready, in_progress, review, blocked, done)', async () => {
    tempDir = createProjectFixture({});

    const result = await get_project_status(tempDir);

    expect(result.counts).toHaveProperty('backlog');
    expect(result.counts).toHaveProperty('ready');
    expect(result.counts).toHaveProperty('in_progress');
    expect(result.counts).toHaveProperty('review');
    expect(result.counts).toHaveProperty('blocked');
    expect(result.counts).toHaveProperty('done');
  });
});

// ---------------------------------------------------------------------------
// TC-02: Pipeline-log данные попадают в ответ
// ---------------------------------------------------------------------------

describe('TC-02: Pipeline-log data is included in response', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('recent_steps is populated from pipeline log (non-empty array of Step objects)', async () => {
    tempDir = createProjectFixture({ pipelineLog: samplePipelineLog() });

    const result = await get_project_status(tempDir);

    // Поле называется recent_steps согласно IMPL-18
    // Примечание: описание QA-20 ошибочно ссылается на pipeline_health;
    // IMPL-18 определил имя поля как recent_steps.
    expect(result).toHaveProperty('recent_steps');
    expect(Array.isArray(result.recent_steps)).toBe(true);
    expect(result.recent_steps.length).toBeGreaterThan(0);

    const step = result.recent_steps[0];
    expect(step).toHaveProperty('stage');
    expect(step).toHaveProperty('status');
  });

  it('recent_steps contains Step objects with expected structure', async () => {
    tempDir = createProjectFixture({ pipelineLog: samplePipelineLog() });

    const result = await get_project_status(tempDir);

    const step = result.recent_steps[0];
    // Структура Step согласно IMPL-18: {step_number, stage, status, duration_ms, context?}
    expect(typeof step.stage).toBe('string');
    expect(typeof step.status).toBe('string');
  });

  it('recent_steps is empty array when no pipeline log exists', async () => {
    tempDir = createProjectFixture({});

    const result = await get_project_status(tempDir);

    expect(result).toHaveProperty('recent_steps');
    expect(Array.isArray(result.recent_steps)).toBe(true);
    expect(result.recent_steps.length).toBe(0);
  });

  it('recent_steps contains at most 5 steps (Step[5])', async () => {
    // Лог с 7 шагами → ожидаем не более 5
    const manySteps = Array.from({ length: 7 }, (_, i) => [
      `[2026-04-27 10:00:0${i}] [INFO] [PipelineRunner] Step ${i + 1}`,
      `[2026-04-27 10:00:0${i}] [INFO] [PipelineRunner] START stage="stage-${i}" agent="agent"`,
      `[2026-04-27 10:00:0${i}] [INFO] [PipelineRunner] COMPLETE stage="stage-${i}" status="success" exitCode=0`,
    ].join('\n')).join('\n');

    tempDir = createProjectFixture({ pipelineLog: manySteps });

    const result = await get_project_status(tempDir);

    expect(result.recent_steps.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// TC-03: Несуществующий project → INVALID_PROJECT
// ---------------------------------------------------------------------------

describe('TC-03: Non-existent project path returns INVALID_PROJECT error', () => {
  it('returns INVALID_PROJECT error for a path that does not exist', async () => {
    const nonExistentPath = path.join(os.tmpdir(), 'qa20-does-not-exist-' + Date.now());

    const result = await get_project_status(nonExistentPath);

    // Ожидаемое поведение согласно DoD QA-20
    expect(result).toHaveProperty('error');
    expect(result.error).toBe('INVALID_PROJECT');
  });
});

// ---------------------------------------------------------------------------
// TC-04: Проект без .workflow/ → NOT_A_WORKFLOW_PROJECT или пустой ответ
// ---------------------------------------------------------------------------

describe('TC-04: Project without .workflow/ directory', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('returns NOT_A_WORKFLOW_PROJECT or correct empty response for dir without .workflow', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa20-noworkflow-'));
    // Директория существует, но .workflow/ в ней нет

    const result = await get_project_status(tempDir);

    if (result.error) {
      // Вариант А: явная ошибка
      expect(result.error).toBe('NOT_A_WORKFLOW_PROJECT');
    } else {
      // Вариант Б: корректный пустой ответ
      expect(result).toHaveProperty('counts');
      expect(result.counts.backlog).toBe(0);
      expect(result.counts.ready).toBe(0);
      expect(result.counts.in_progress).toBe(0);
      expect(result.counts.done).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// TC-05: Frontmatter cache — повторный вызов не перечитывает файлы
// ---------------------------------------------------------------------------

describe('TC-05: Frontmatter cache prevents repeated fs.readFileSync on ticket files', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
    vi.restoreAllMocks();
  });

  it('does NOT call fs.readFileSync for ticket files on the second call', async () => {
    tempDir = createProjectFixture({
      tickets: { backlog: 2, ready: 1 },
    });

    // Первый вызов — прогрев
    await get_project_status(tempDir);

    // Шпион на fs.readFileSync — начинаем считать только после прогрева
    const spy = vi.spyOn(fs, 'readFileSync');

    // Второй вызов — при наличии кеша readFileSync для тикетных файлов не должен вызываться
    await get_project_status(tempDir);

    // Фильтруем только обращения к .md-файлам тикетов
    const ticketReads = spy.mock.calls.filter(
      ([filePath]) => typeof filePath === 'string' && filePath.endsWith('.md'),
    );

    expect(ticketReads.length).toBe(0);
  });
});
