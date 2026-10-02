/**
 * get_model_stats и unban_model — таблица моделей агентов и снятие запрета по журналу
 * запусков проекта `.workflow/metrics/agent-runs.jsonl` (workflow-ai 1.14.0,
 * PLAN-003 workflowAi).
 *
 * Что охраняется:
 *  - таблица и запреты — те же, что вычисляет workflow-ai (statsTable, activeBans):
 *    своих правил у сервера нет, иначе сервер и раннер разошлись бы в том, какая
 *    модель под запретом;
 *  - фильтры по модели и типу тикета; временный запрет — на модель целиком и
 *    фильтром по типу не отсекается; строки с `model: null` — в конце;
 *  - снятие постоянного запрета пары и временного запрета модели дописывает одно
 *    событие `unban`, запрет исчезает из таблицы, ответ показывает, что ещё действует;
 *  - запрета нет — NO_BAN, пустая причина — BAD_INPUT (схема её пропускает), журнал
 *    не меняется;
 *  - снятие никогда не отвечает ok при запрете, который остался действовать (оборванная
 *    последняя строка журнала): либо запрет снят, либо UNBAN_NOT_APPLIED;
 *  - нечитаемый журнал — JOURNAL_UNREADABLE, проект без `.workflow/` — INVALID_PROJECT.
 *
 * Имена моделей и агентов — нейтральные. Журнал — временный проект в каталоге ОС,
 * удаляется после каждого теста.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { get_model_stats, unban_model, get_model_stats_tool, unban_model_tool } from '../../src/tools/agent-runs.mjs';
import * as agentRunsLib from 'workflow-ai/lib/agent-runs.mjs';

// Запрет «модель недоступна» считает workflow-ai (unavailableBans), которого нет в пакете
// 1.23.1. Описание unban_model обещает его снятие, поэтому поведенческий тест ниже ждёт
// зависимости с unavailableBans: до неё он пропущен, после — охраняет обещание.
const HAS_UNAVAILABLE_BAN = typeof agentRunsLib.unavailableBans === 'function';

let root;
let seq = 0;

function journalPath() {
  return path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
}

function writeJournal(events) {
  fs.mkdirSync(path.dirname(journalPath()), { recursive: true });
  fs.writeFileSync(journalPath(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function journalLines() {
  return fs.readFileSync(journalPath(), 'utf8').trim().split('\n');
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function run(model, ticketType, overrides = {}) {
  seq += 1;
  return {
    type: 'run', ts: minutesAgo(30), run_key: `run-${seq}`, stage: 'execute-task', skill: 'execute-task',
    ticket: `${ticketType.toUpperCase()}-${seq}`, ticket_type: ticketType, agent: 'agent-a',
    model, status: 'ok', changed_files: 2, ...overrides,
  };
}

// Неудача: контроль артефактов failed с причинами.
function failed(model, ticketType) {
  const r = run(model, ticketType);
  return [r, { type: 'verify', ts: minutesAgo(29), ticket: r.ticket, ticket_type: ticketType, status: 'failed', fail_reasons: ['missing_files'] }];
}

// Успех: контроль all_green.
function green(model, ticketType) {
  const r = run(model, ticketType);
  return [r, { type: 'verify', ts: minutesAgo(29), ticket: r.ticket, ticket_type: ticketType, status: 'all_green', fail_reasons: [] }];
}

// Успех контроля, ревью не прошло.
function reviewFailed(model, ticketType) {
  const r = run(model, ticketType);
  return [
    r,
    { type: 'verify', ts: minutesAgo(29), ticket: r.ticket, ticket_type: ticketType, status: 'passed', fail_reasons: [] },
    { type: 'review', ts: minutesAgo(28), ticket: r.ticket, ticket_type: ticketType, stage: 'review-result', status: 'failed', agent: 'reviewer-a', model: 'model-r' },
  ];
}

// Сбой процесса без изменений 5 минут назад — временный запрет модели на час.
function crash(model, ticketType) {
  return [run(model, ticketType, { ts: minutesAgo(5), status: 'error', changed_files: 0, crash_ttl_ms: 3600000 })];
}

// model-a: три неудачи impl — постоянный запрет по правилу 1; docs — чисто.
// model-b: успех docs, затем свежий сбой impl — временный запрет модели целиком.
// null: запуск kilo с непрочитанной моделью.
function fixture() {
  return [
    ...failed('model-a', 'impl'), ...failed('model-a', 'impl'), ...failed('model-a', 'impl'),
    ...green('model-a', 'docs'), ...reviewFailed('model-a', 'docs'),
    ...green('model-b', 'docs'),
    ...crash('model-b', 'impl'),
    run(null, 'impl', { changed_files: 0 }),
  ];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-agent-runs-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('get_model_stats', () => {
  it('таблица по модели и типу тикета и действующие запреты', async () => {
    writeJournal(fixture());
    const stats = await get_model_stats({ project: root });

    expect(stats.journal).toBe('.workflow/metrics/agent-runs.jsonl');
    expect(stats.events).toBe(15);
    expect(stats.executor_runs).toBe(8);
    expect(stats.rows.map((r) => [r.model, r.ticket_type, r.runs])).toEqual([
      ['model-a', 'docs', 2],
      ['model-a', 'impl', 3],
      ['model-b', 'docs', 1],
      ['model-b', 'impl', 1],
      [null, 'impl', 1],
    ]);

    const aDocs = stats.rows[0];
    expect(aDocs.grades.accepted).toBe(1);
    expect(aDocs.grades.review_failed).toBe(1);
    expect(aDocs.artifacts_success_rate).toBe(1);
    // all_green ревью не проходит: единственное ревью с вердиктом — failed.
    expect(aDocs.review_accept_rate).toBe(0);

    const aImpl = stats.rows[1];
    expect(aImpl.grades.artifacts_failed).toBe(3);
    expect(aImpl.bans.map((b) => [b.kind, b.rule])).toEqual([['permanent', 1]]);

    expect(stats.rows[4].grades.empty).toBe(1);
    expect(stats.rows[4].bans).toEqual([]);

    expect(stats.bans.permanent.map((b) => [b.model, b.ticket_type, b.rule, b.evidence.length])).toEqual([['model-a', 'impl', 1, 3]]);
    expect(stats.bans.crash.map((b) => b.model)).toEqual(['model-b']);
    // Временный запрет — на модель целиком: виден и в строке docs.
    expect(stats.rows[2].bans.map((b) => b.kind)).toEqual(['crash']);
  });

  it('фильтры по модели и типу тикета; временный запрет фильтром по типу не отсекается', async () => {
    writeJournal(fixture());
    const onlyA = await get_model_stats({ project: root, model: 'model-a' });
    expect(onlyA.rows.map((r) => r.ticket_type)).toEqual(['docs', 'impl']);
    expect(onlyA.bans.crash).toEqual([]);

    const onlyDocs = await get_model_stats({ project: root, ticket_type: 'docs' });
    expect(onlyDocs.rows.map((r) => r.model)).toEqual(['model-a', 'model-b']);
    expect(onlyDocs.bans.permanent).toEqual([]);
    expect(onlyDocs.bans.crash.map((b) => b.model)).toEqual(['model-b']);
  });

  it('журнала нет — пустая таблица', async () => {
    const stats = await get_model_stats({ project: root });
    expect(stats).toEqual({
      journal: '.workflow/metrics/agent-runs.jsonl', events: 0, executor_runs: 0, rows: [], bans: { permanent: [], crash: [] },
    });
  });

  it('нечитаемый журнал — JOURNAL_UNREADABLE', async () => {
    fs.mkdirSync(journalPath(), { recursive: true });
    await expect(get_model_stats({ project: root })).rejects.toMatchObject({ code: 'JOURNAL_UNREADABLE' });
  });

  it('каталог без .workflow — INVALID_PROJECT', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-agent-runs-bare-'));
    try {
      await expect(get_model_stats({ project: bare })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('unban_model', () => {
  it('постоянный запрет пары: одно событие unban, запрет исчезает', async () => {
    writeJournal(fixture());
    const before = journalLines().length;
    const result = await unban_model({ project: root, model: 'model-a', ticket_type: 'impl', reason: 'проверено вручную' });

    expect(result.ok).toBe(true);
    expect(result.event).toMatchObject({ type: 'unban', model: 'model-a', ticket_type: 'impl', reason: 'проверено вручную' });
    expect(result.remaining).toEqual({ permanent: [], crash: [] });
    expect(journalLines()).toHaveLength(before + 1);

    const stats = await get_model_stats({ project: root, model: 'model-a' });
    expect(stats.bans.permanent).toEqual([]);
  });

  it('временный запрет модели: снимается без типа тикета', async () => {
    writeJournal(fixture());
    const result = await unban_model({ project: root, model: 'model-b', reason: 'сбой был в сети' });
    expect(result.event).toMatchObject({ type: 'unban', model: 'model-b', reason: 'сбой был в сети' });
    expect(result.event.ticket_type).toBeUndefined();
    expect(result.remaining.crash).toEqual([]);
    const stats = await get_model_stats({ project: root });
    expect(stats.bans.crash).toEqual([]);
  });

  // Сбои `error` подряд: три — запрет «модель недоступна» на час (rule: 'unavailable'). Запрет за
  // сбой при этом короткий (crash_ttl_ms минута) и давно истёк, так что действует только первый.
  it.skipIf(!HAS_UNAVAILABLE_BAN)('без типа тикета снимается и запрет «модель недоступна», серия считается заново', async () => {
    const failure = (ts) => run('model-c', 'impl', { ts, status: 'error', changed_files: 0, crash_ttl_ms: 60000 });
    writeJournal([20, 15, 10].map((m) => failure(minutesAgo(m))));
    const unavailable = async () => (await get_model_stats({ project: root })).bans.crash.filter((b) => b.rule === 'unavailable');
    expect((await unavailable()).map((b) => b.model)).toEqual(['model-c']);

    const result = await unban_model({ project: root, model: 'model-c', reason: 'провайдер починили' });

    expect(result.event).toMatchObject({ type: 'unban', model: 'model-c', reason: 'провайдер починили' });
    expect(result.remaining.crash).toEqual([]);
    expect(await unavailable()).toEqual([]);

    // Серия считается заново: два новых сбоя запрета не дают, третий — запрет с failures: 3.
    fs.appendFileSync(journalPath(), [1, 2].map(() => JSON.stringify(failure(new Date().toISOString()))).join('\n') + '\n');
    expect(await unavailable()).toEqual([]);
    fs.appendFileSync(journalPath(), JSON.stringify(failure(new Date().toISOString())) + '\n');
    expect((await unavailable()).map((b) => [b.model, b.failures])).toEqual([['model-c', 3]]);
  });

  it('ответ показывает, что для модели ещё действует', async () => {
    writeJournal([...fixture(), ...crash('model-a', 'docs')]);
    const result = await unban_model({ project: root, model: 'model-a', ticket_type: 'impl', reason: 'снято' });
    expect(result.remaining.permanent).toEqual([]);
    expect(result.remaining.crash.map((b) => b.model)).toEqual(['model-a']);
  });

  it('запрета нет — NO_BAN, журнал не меняется', async () => {
    writeJournal(fixture());
    const before = fs.readFileSync(journalPath(), 'utf8');
    await expect(unban_model({ project: root, model: 'model-a', ticket_type: 'docs', reason: 'x' }))
      .rejects.toMatchObject({ code: 'NO_BAN' });
    await expect(unban_model({ project: root, model: 'model-a', reason: 'x' }))
      .rejects.toMatchObject({ code: 'NO_BAN' });
    expect(fs.readFileSync(journalPath(), 'utf8')).toBe(before);
  });

  it('пустая причина или модель — BAD_INPUT, журнал не меняется', async () => {
    writeJournal(fixture());
    const before = fs.readFileSync(journalPath(), 'utf8');
    for (const args of [
      { model: 'model-a', ticket_type: 'impl', reason: '' },
      { model: 'model-a', ticket_type: 'impl', reason: '   ' },
      { model: '', ticket_type: 'impl', reason: 'x' },
    ]) {
      expect(unban_model_tool.inputSchema.safeParse({ project: root, ...args }).success).toBe(true);
      await expect(unban_model({ project: root, ...args })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(fs.readFileSync(journalPath(), 'utf8')).toBe(before);
  });

  it('оборванная последняя строка журнала: снятие либо действует, либо UNBAN_NOT_APPLIED — не ok с живым запретом', async () => {
    writeJournal(fixture());
    fs.appendFileSync(journalPath(), '{"type":"run","ts":"2026');
    let outcome;
    try {
      outcome = await unban_model({ project: root, model: 'model-a', ticket_type: 'impl', reason: 'снято' });
    } catch (err) {
      outcome = err;
    }
    const stats = await get_model_stats({ project: root, model: 'model-a' });
    if (outcome instanceof Error) {
      expect(outcome.code).toBe('UNBAN_NOT_APPLIED');
      expect(stats.bans.permanent).toHaveLength(1);
    } else {
      expect(outcome.ok).toBe(true);
      expect(stats.bans.permanent).toEqual([]);
    }
  });

  it('нечитаемый журнал — JOURNAL_UNREADABLE', async () => {
    fs.mkdirSync(journalPath(), { recursive: true });
    await expect(unban_model({ project: root, model: 'model-a', ticket_type: 'impl', reason: 'x' }))
      .rejects.toMatchObject({ code: 'JOURNAL_UNREADABLE' });
  });
});

describe('схемы инструментов', () => {
  it('unban_model требует поля model и reason, ticket_type необязателен', () => {
    expect(unban_model_tool.inputSchema.safeParse({ project: 'p', model: 'm', reason: 'r' }).success).toBe(true);
    expect(unban_model_tool.inputSchema.safeParse({ project: 'p', model: 'm' }).success).toBe(false);
    expect(unban_model_tool.inputSchema.safeParse({ project: 'p', reason: 'r' }).success).toBe(false);
    expect(get_model_stats_tool.inputSchema.safeParse({ project: 'p' }).success).toBe(true);
  });

  // Без ticket_type снятие относится ко всем временным запретам модели: за сбой и за серию
  // «модель недоступна» (workflow-ai, recordUnban и unavailableBans: серия считается
  // заново с этого unban). Агент узнаёт это только из описания.
  it('unban_model в описании называет оба временных запрета и пересчёт серии', () => {
    expect(unban_model_tool.description).toMatch(
      /without it — the temporary bans of the model: for a crash and for a series of "model unavailable" failures \(the series is counted anew from this unban\)/
    );
    expect(unban_model_tool.inputSchema.shape.ticket_type.description).toMatch(/omit for the temporary bans of the model \(crash, "model unavailable"\)/);
  });
});
