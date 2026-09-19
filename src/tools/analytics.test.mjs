import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'js-yaml';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { frontmatterCache } from '../caches/frontmatter-cache.mjs';
import { get_velocity, get_cycle_time, get_ticket_stats, aggregate_metrics } from './analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Вспомогательная: создать временный тикет
function createTempTicket(dir, id, overrides = {}) {
  const filePath = path.join(dir, `${id}.md`);
  const base = {
    id,
    title: `Test ${id}`,
    status: 'done',
    type: 'task',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    complexity: 1
  };
  const fm = { ...base, ...overrides };
  // Удаляем свойства со значением undefined
  Object.keys(fm).forEach(k => fm[k] === undefined && delete fm[k]);
  const yamlStr = YAML.dump(fm, { lineWidth: -1, quotingType: '"' });
  const content = `---\n${yamlStr}---\n\nTest ticket`;
  fs.writeFileSync(filePath, content, 'utf8');
  // Загружаем в кеш
  frontmatterCache.getFrontmatter(filePath);
  return filePath;
}

// Вспомогательная: создать временный проект
function createTempProject(prefix) {
  const tmpDir = path.join(__dirname, '../../.workflow/tmp-analytics');
  const projDir = path.join(tmpDir, prefix);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  if (fs.existsSync(projDir)) {
    // очистка
    const files = fs.readdirSync(projDir);
    for (const f of files) fs.rmSync(path.join(projDir, f), { recursive: true, force: true });
  } else {
    fs.mkdirSync(projDir, { recursive: true });
  }
  // Создать структуру .workflow/tickets с все статусами
  const ticketsDir = path.join(projDir, '.workflow', 'tickets');
  const statuses = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done'];
  for (const st of statuses) {
    fs.mkdirSync(path.join(ticketsDir, st), { recursive: true });
  }
  return projDir;
}

// Очистка кеша перед каждым тестом
beforeEach(() => {
  frontmatterCache.clear();
});

describe('get_cycle_time tool tests', () => {
  test('пустая выборка → count=0 и все percentiles=null', async () => {
    const proj = createTempProject('empty-cycle');
    const res = await get_cycle_time(proj, { window_days: 14, percentiles: [50, 90] });
    expect(res.count).toBe(0);
    expect(res.p50_sec).toBeNull();
    expect(res.p90_sec).toBeNull();
    expect(res.mean_sec).toBeNull();
    expect(res.samples).toEqual([]);
  });

  test('один тикет → p50=p90=mean', async () => {
    const proj = createTempProject('one-cycle');
    const base = Date.now();
    const created = new Date(base - 5 * 86400000).toISOString(); // 5 дней назад
    const completed = new Date(base).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-1', {
      created_at: created,
      completed_at: completed
    });
    const res = await get_cycle_time(proj, { window_days: 14, percentiles: [50, 90] });
    expect(res.count).toBe(1);
    // Все процентили для одного значения должны быть равны
    expect(res.p50_sec).toBeCloseTo(res.p90_sec, 0);
    expect(res.p50_sec).toBeCloseTo(res.mean_sec, 0);
    // Проверяем что значение примерно 5 дней в секундах (5*86400 = 432000)
    expect(res.p50_sec).toBeCloseTo(432000, -3);
  });

  test('distribution из 10 тикетов → p50/p90 близки к ожидаемому', async () => {
    const proj = createTempProject('dist-cycle');
    const base = Date.now();
    // Создаём 10 тикетов с cycle: 1, 2, 3, ..., 10 дней
    for (let i = 1; i <= 10; i++) {
      const created = new Date(base - i * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `T-${i}`, {
        created_at: created,
        completed_at: completed
      });
    }
    const res = await get_cycle_time(proj, { window_days: 365, percentiles: [50, 90] });
    expect(res.count).toBe(10);
    // На распределении 1-10 дней:
    // Среднее должно быть ~5.5 дней = 475200 сек
    expect(res.mean_sec).toBeCloseTo(475200, -3);
    // p50 на 10 значениях: (5 + 6) / 2 = 5.5 дней = 475200 сек
    expect(res.p50_sec).toBeCloseTo(475200, -3);
    // p90 должен быть ближе к 9-10 дням
    expect(res.p90_sec).toBeGreaterThan(8 * 86400);
  });

  test('samples ≤ 50', async () => {
    const proj = createTempProject('samples-limit');
    const base = Date.now();
    // Создаём 100 тикетов
    for (let i = 1; i <= 100; i++) {
      const created = new Date(base - i * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `T-${i.toString().padStart(3, '0')}`, {
        created_at: created,
        completed_at: completed
      });
    }
    const res = await get_cycle_time(proj, { window_days: 365, percentiles: [50, 90] });
    expect(res.count).toBe(100);
    expect(res.samples.length).toBeLessThanOrEqual(50);
    expect(res.samples.length).toBe(50); // точно 50, так как больше не нужно
  });

  test('cycle < 0 пропускается (created_at > completed_at)', async () => {
    const proj = createTempProject('negative-cycle');
    const base = Date.now();
    // Тикет с completed_at ДО created_at (некорректные данные)
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'BAD-1', {
      created_at: new Date(base + 86400000).toISOString(),
      completed_at: new Date(base).toISOString()
    });
    // Валидный тикет
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'GOOD-1', {
      created_at: new Date(base - 5 * 86400000).toISOString(),
      completed_at: new Date(base).toISOString()
    });
    const res = await get_cycle_time(proj, { window_days: 365, percentiles: [50, 90] });
    expect(res.count).toBe(1); // только GOOD-1
    expect(res.samples[0].ticket_id).toBe('GOOD-1');
  });

  test('кастомные percentiles работают', async () => {
    const proj = createTempProject('custom-percentiles');
    const base = Date.now();
    // Создаём 10 тикетов с cycle: 1, 2, ..., 10 дней
    for (let i = 1; i <= 10; i++) {
      const created = new Date(base - i * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `T-${i}`, {
        created_at: created,
        completed_at: completed
      });
    }
    // Запрашиваем кастомные percentiles: 25, 75, 95
    const res = await get_cycle_time(proj, { window_days: 365, percentiles: [25, 75, 95] });
    expect(res.count).toBe(10);
    expect(res.p25_sec).toBeDefined();
    expect(res.p75_sec).toBeDefined();
    expect(res.p95_sec).toBeDefined();
    // На распределении 1-10:
    // p25 ≈ 3.25 дня = 280800 сек
    expect(res.p25_sec).toBeCloseTo(280800, -2);
    // p75 ≈ 7.75 дня = 669600 сек
    expect(res.p75_sec).toBeCloseTo(669600, -2);
    // p95 ≈ 9.55 дня
    expect(res.p95_sec).toBeGreaterThan(9 * 86400);
  });

  test('несуществующий проект → PROJECT_NOT_FOUND', async () => {
    const res = await get_cycle_time('/nonexistent/project', { window_days: 14 });
    expect(res.error).toBe('PROJECT_NOT_FOUND');
  });

  test('window_days фильтрует тикеты', async () => {
    const proj = createTempProject('window-filter');
    const now = Date.now();
    // Старый тикет (100 дней назад)
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'OLD-1', {
      created_at: new Date(now - 110 * 86400000).toISOString(),
      completed_at: new Date(now - 100 * 86400000).toISOString()
    });
    // Свежий тикет (5 дней назад)
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'NEW-1', {
      created_at: new Date(now - 10 * 86400000).toISOString(),
      completed_at: new Date(now - 5 * 86400000).toISOString()
    });
    // Окно 30 дней -> только NEW-1
    const res = await get_cycle_time(proj, { window_days: 30 });
    expect(res.count).toBe(1);
    expect(res.samples[0].ticket_id).toBe('NEW-1');
  });

  test('samples содержат ticket_id и cycle_sec', async () => {
    const proj = createTempProject('samples-format');
    const base = Date.now();
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'SAMPLE-1', {
      created_at: new Date(base - 7 * 86400000).toISOString(),
      completed_at: new Date(base).toISOString()
    });
    const res = await get_cycle_time(proj, { window_days: 30 });
    expect(res.samples.length).toBe(1);
    expect(res.samples[0].ticket_id).toBe('SAMPLE-1');
    expect(res.samples[0].cycle_sec).toBeCloseTo(7 * 86400, -2);
  });

  test('invalid window_days (< 1) → ошибка', async () => {
    const proj = createTempProject('invalid-window');
    const res = await get_cycle_time(proj, { window_days: 0 });
    expect(res.error).toBe('WINDOW_TOO_LARGE');
  });

  test('invalid percentiles (вне 0-100) → ошибка', async () => {
    const proj = createTempProject('invalid-percentiles');
    const res = await get_cycle_time(proj, { percentiles: [50, 150] });
    expect(res.error).toBe('INVALID_PERCENTILES');
  });

  test('get_ticket_stats инструмент работает', async () => {
    const proj = createTempProject('stats-tool');
    // Создаём несколько тикетов разных типов и статусов
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'IMPL-1', {
      type: 'IMPL',
      status: 'done'
    });
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'QA-1', {
      type: 'QA',
      status: 'done'
    });
    createTempTicket(path.join(proj, '.workflow/tickets/ready'), 'IMPL-2', {
      type: 'IMPL',
      status: 'ready'
    });
    createTempTicket(path.join(proj, '.workflow/tickets/in-progress'), 'DOCS-1', {
      type: 'DOCS',
      status: 'in-progress'
    });

    // Вызываем tool через инструмент
    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 30 });

    expect(result.by_status).toBeDefined();
    expect(result.by_type).toBeDefined();
    expect(result.by_status.done).toBeGreaterThanOrEqual(1);
    expect(result.by_type.IMPL).toBeGreaterThanOrEqual(1);
  });

  test('percentiles по умолчанию [50, 90]', async () => {
    const proj = createTempProject('default-percentiles');
    const base = Date.now();
    for (let i = 1; i <= 10; i++) {
      const created = new Date(base - i * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `T-${i}`, {
        created_at: created,
        completed_at: completed
      });
    }
    // Без явной передачи percentiles
    const res = await get_cycle_time(proj);
    expect(res.p50_sec).toBeDefined();
    expect(res.p90_sec).toBeDefined();
    expect(res.count).toBe(10);
  });
});

describe('get_ticket_stats tool tests', () => {
  test('by_status корректен: ready/in_progress/blocked/done/review/backlog', async () => {
    const proj = createTempProject('stats-by-status');
    const ticketsDir = path.join(proj, '.workflow/tickets');

    // Создаём тикеты в каждом статусе
    createTempTicket(path.join(ticketsDir, 'ready'), 'IMPL-1', { status: 'ready', type: 'IMPL' });
    createTempTicket(path.join(ticketsDir, 'in-progress'), 'IMPL-2', { status: 'in-progress', type: 'IMPL' });
    createTempTicket(path.join(ticketsDir, 'in-progress'), 'QA-1', { status: 'in-progress', type: 'QA' });
    createTempTicket(path.join(ticketsDir, 'blocked'), 'QA-2', { status: 'blocked', type: 'QA' });
    createTempTicket(path.join(ticketsDir, 'done'), 'DOCS-1', { status: 'done', type: 'DOCS' });
    createTempTicket(path.join(ticketsDir, 'review'), 'ARCH-1', { status: 'review', type: 'ARCH' });
    createTempTicket(path.join(ticketsDir, 'backlog'), 'IMPL-3', { status: 'backlog', type: 'IMPL' });

    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 30 });

    // Проверяем что все статусы присутствуют
    expect(result.by_status).toHaveProperty('ready');
    expect(result.by_status).toHaveProperty('in_progress');
    expect(result.by_status).toHaveProperty('blocked');
    expect(result.by_status).toHaveProperty('done');
    expect(result.by_status).toHaveProperty('review');
    expect(result.by_status).toHaveProperty('backlog');

    // Проверяем значения
    expect(result.by_status.ready).toBe(1);
    expect(result.by_status.in_progress).toBe(2);
    expect(result.by_status.blocked).toBe(1);
    expect(result.by_status.done).toBe(1);
    expect(result.by_status.review).toBe(1);
    expect(result.by_status.backlog).toBe(1);
  });

  test('by_type включает IMPL/QA/DOCS/ARCH + OTHER для невалидных', async () => {
    const proj = createTempProject('stats-by-type');
    const ticketsDir = path.join(proj, '.workflow/tickets');

    // Создаём тикеты валидных типов
    createTempTicket(path.join(ticketsDir, 'ready'), 'IMPL-1', { status: 'ready', type: 'IMPL' });
    createTempTicket(path.join(ticketsDir, 'ready'), 'QA-1', { status: 'ready', type: 'QA' });
    createTempTicket(path.join(ticketsDir, 'ready'), 'DOCS-1', { status: 'ready', type: 'DOCS' });
    createTempTicket(path.join(ticketsDir, 'ready'), 'ARCH-1', { status: 'ready', type: 'ARCH' });

    // Создаём тикеты с невалидными типами
    createTempTicket(path.join(ticketsDir, 'ready'), 'INVALID-1', { status: 'ready', type: 'INVALID_TYPE' });
    createTempTicket(path.join(ticketsDir, 'ready'), 'UNKNOWN-1', { status: 'ready', type: 'SOME_UNKNOWN' });

    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 30 });

    // Проверяем что валидные типы присутствуют
    expect(result.by_type.IMPL).toBe(1);
    expect(result.by_type.QA).toBe(1);
    expect(result.by_type.DOCS).toBe(1);
    expect(result.by_type.ARCH).toBe(1);

    // Проверяем что невалидные типы маппятся в OTHER
    expect(result.by_type.OTHER).toBe(2);

    // Проверяем что невалидные типы не присутствуют отдельно
    expect(result.by_type.INVALID_TYPE).toBeUndefined();
    expect(result.by_type.SOME_UNKNOWN).toBeUndefined();
  });

  test('blocked_top ≤ 10, сорт по age DESC', async () => {
    const proj = createTempProject('stats-blocked-top');
    const ticketsDir = path.join(proj, '.workflow/tickets');
    const base = Date.now();

    // Создаём 15 блокированных тикетов с разными возрастами
    for (let i = 1; i <= 15; i++) {
      const ageMs = i * 86400000; // i дней назад
      createTempTicket(path.join(ticketsDir, 'blocked'), `BLOCKED-${i}`, {
        status: 'blocked',
        type: 'IMPL',
        updated_at: new Date(base - ageMs).toISOString(),
        blocked_reason: `Reason ${i}`
      });
    }

    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 365 });

    // Проверяем что blocked_top содержит максимум 10 элементов
    expect(result.blocked_top.length).toBeLessThanOrEqual(10);
    expect(result.blocked_top.length).toBe(10); // у нас 15, поэтому должно быть ровно 10

    // Проверяем что отсортировано по age DESC (самые старые первыми)
    for (let i = 0; i < result.blocked_top.length - 1; i++) {
      expect(result.blocked_top[i].age_sec).toBeGreaterThanOrEqual(result.blocked_top[i + 1].age_sec);
    }
  });

  test('пустой проект → все нули', async () => {
    const proj = createTempProject('stats-empty');
    // Не создаём никаких тикетов

    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 30 });

    // Проверяем что все статусы имеют 0
    expect(result.by_status.ready).toBe(0);
    expect(result.by_status.in_progress).toBe(0);
    expect(result.by_status.blocked).toBe(0);
    expect(result.by_status.done).toBe(0);
    expect(result.by_status.review).toBe(0);
    expect(result.by_status.backlog).toBe(0);

    // Проверяем что by_type не содержит нулевых значений (или пусто)
    // Нормализованный by_type не должен содержать нулей
    expect(Object.values(result.by_type).every(v => v > 0)).toBe(true);

    // Проверяем что blocked_top пусто
    expect(result.blocked_top).toEqual([]);
  });

  test('несуществующий проект → PROJECT_NOT_FOUND', async () => {
    const tool = get_ticket_stats;
    const result = await tool.execute({ project: '/nonexistent/project', window_days: 30 });

    expect(result.error).toBe('PROJECT_NOT_FOUND');
    // Резолв общий со всеми tools, поэтому и текст один: старое «путь не
    // существует» ещё и врало про каталог без `.workflow/`.
    expect(result.message).toMatch(/not a workflow project/);
  });

  test('blocked_top содержит id, blocked_reason и age_sec', async () => {
    const proj = createTempProject('stats-blocked-format');
    const ticketsDir = path.join(proj, '.workflow/tickets');

    createTempTicket(path.join(ticketsDir, 'blocked'), 'BLOCKED-1', {
      status: 'blocked',
      type: 'IMPL',
      blocked_reason: 'Waiting for dependency',
      updated_at: new Date().toISOString()
    });

    const tool = get_ticket_stats;
    const result = await tool.execute({ project: proj, window_days: 30 });

    expect(result.blocked_top.length).toBe(1);
    expect(result.blocked_top[0]).toHaveProperty('id');
    expect(result.blocked_top[0]).toHaveProperty('blocked_reason');
    expect(result.blocked_top[0]).toHaveProperty('age_sec');
    expect(result.blocked_top[0].id).toBe('BLOCKED-1');
  });

  test('window_days фильтрует тикеты по created_at', async () => {
    const proj = createTempProject('stats-window-filter');
    const ticketsDir = path.join(proj, '.workflow/tickets');
    const now = Date.now();

    // Старый тикет (100 дней назад)
    createTempTicket(path.join(ticketsDir, 'ready'), 'OLD-1', {
      status: 'ready',
      type: 'IMPL',
      created_at: new Date(now - 110 * 86400000).toISOString()
    });

    // Свежий тикет (5 дней назад)
    createTempTicket(path.join(ticketsDir, 'ready'), 'NEW-1', {
      status: 'ready',
      type: 'IMPL',
      created_at: new Date(now - 5 * 86400000).toISOString()
    });

    const tool = get_ticket_stats;

    // Окно 30 дней -> только NEW-1
    const result30 = await tool.execute({ project: proj, window_days: 30 });
    expect(result30.by_status.ready).toBe(1);

    // Окно 365 дней -> оба тикета
    const result365 = await tool.execute({ project: proj, window_days: 365 });
    expect(result365.by_status.ready).toBe(2);
  });
});

describe('get_velocity tests', () => {
  test('фикстурный проект → точки сгруппированы по day/week', async () => {
    const proj = createTempProject('velocity-group');
    const doneDir = path.join(proj, '.workflow', 'tickets', 'done');
    const base = Date.now();

    createTempTicket(doneDir, 'V-1', {
      completed_at: new Date(base - 2 * 86400000).toISOString(),
      complexity: 2
    });
    createTempTicket(doneDir, 'V-2', {
      completed_at: new Date(base - 2 * 86400000).toISOString(),
      complexity: 3
    });
    createTempTicket(doneDir, 'V-3', {
      completed_at: new Date(base - 1 * 86400000).toISOString(),
      complexity: 1
    });

    const dayResult = await get_velocity(proj, { window_days: 14, group_by: 'day' });
    expect(dayResult.points.length).toBe(2);

    const twoDaysAgo = new Date(base - 2 * 86400000).toISOString().split('T')[0];
    const oneDayAgo = new Date(base - 1 * 86400000).toISOString().split('T')[0];

    const day1 = dayResult.points.find(p => p.date === twoDaysAgo);
    expect(day1).toBeDefined();
    expect(day1.count).toBe(2);
    expect(day1.total_complexity).toBe(5);

    const day2 = dayResult.points.find(p => p.date === oneDayAgo);
    expect(day2).toBeDefined();
    expect(day2.count).toBe(1);
    expect(day2.total_complexity).toBe(1);

    const weekResult = await get_velocity(proj, { window_days: 14, group_by: 'week' });
    expect(weekResult.points.length).toBeGreaterThanOrEqual(1);
    expect(weekResult.points[0].date).toMatch(/^\d{4}-W\d{2}$/);
  });

  test('window_days > 365 → WINDOW_TOO_LARGE', async () => {
    const res = await get_velocity('/some/path', { window_days: 366 });
    expect(res.error).toBe('WINDOW_TOO_LARGE');
    expect(res.message).toMatch(/window_days must be between 1 and 365/);
  });

  test('проект без done — пустой points', async () => {
    const proj = createTempProject('velocity-no-done');
    const res = await get_velocity(proj, { window_days: 14 });
    expect(res.points).toEqual([]);
    expect(res.window_days).toBe(14);
    expect(res.group_by).toBe('day');
  });

  test('несуществующий проект → PROJECT_NOT_FOUND', async () => {
    const res = await get_velocity('/nonexistent/project/path', { window_days: 14 });
    expect(res.error).toBe('PROJECT_NOT_FOUND');
    expect(res.message).toMatch(/Project path does not exist/);
  });

  test('сортировка по date ASC', async () => {
    const proj = createTempProject('velocity-sort');
    const doneDir = path.join(proj, '.workflow', 'tickets', 'done');
    const base = Date.now();

    createTempTicket(doneDir, 'S-1', {
      completed_at: new Date(base - 5 * 86400000).toISOString(),
      complexity: 1
    });
    createTempTicket(doneDir, 'S-2', {
      completed_at: new Date(base - 1 * 86400000).toISOString(),
      complexity: 1
    });
    createTempTicket(doneDir, 'S-3', {
      completed_at: new Date(base - 3 * 86400000).toISOString(),
      complexity: 1
    });

    const res = await get_velocity(proj, { window_days: 14, group_by: 'day' });
    expect(res.points.length).toBe(3);

    const dates = res.points.map(p => new Date(p.date).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBeGreaterThan(dates[i - 1]);
    }
  });
});

describe('aggregate_metrics tool tests', () => {
  const originalMcpCwd = process.env.MCP_CWD;

  afterEach(() => {
    if (originalMcpCwd !== undefined) {
      process.env.MCP_CWD = originalMcpCwd;
    } else {
      delete process.env.MCP_CWD;
    }
    vi.restoreAllMocks();
  });

  function createMultiProjectParent(prefix) {
    const parentDir = path.join(__dirname, '../../.workflow/tmp-analytics', prefix);
    if (fs.existsSync(parentDir)) {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        fs.rmSync(path.join(parentDir, entry.name), { recursive: true, force: true });
      }
    } else {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    return parentDir;
  }

  function createNamedProject(parentDir, name, overrides = []) {
    const projDir = path.join(parentDir, name);
    const ticketsDir = path.join(projDir, '.workflow', 'tickets');
    const statuses = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done'];
    for (const st of statuses) {
      fs.mkdirSync(path.join(ticketsDir, st), { recursive: true });
    }
    for (const ticket of overrides) {
      const { dir, ...fmOverrides } = ticket;
      createTempTicket(dir || path.join(ticketsDir, 'done'), ticket.id, fmOverrides);
    }
    return projDir;
  }

  test('2 фикстурных проекта → агрегация корректна', async () => {
    const parentDir = createMultiProjectParent('agg-two-projects');

    const projA = createNamedProject(parentDir, 'proj-a', [
      {
        id: 'A-1',
        status: 'done',
        type: 'IMPL',
        complexity: 3,
        created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);
    const projB = createNamedProject(parentDir, 'proj-b', [
      {
        id: 'B-1',
        status: 'done',
        type: 'QA',
        complexity: 2,
        created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      },
      {
        id: 'B-2',
        status: 'done',
        type: 'IMPL',
        complexity: 4,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);

    const result = await aggregate_metrics.execute({
      projects: [projA, projB],
      window_days: 14
    });

    expect(result.projects).toHaveLength(2);
    expect(result.projects.map(p => p.project).sort()).toEqual(['proj-a', 'proj-b']);

    const projAResult = result.projects.find(p => p.project === 'proj-a');
    expect(projAResult.velocity_summary.count).toBe(1);
    expect(projAResult.velocity_summary.sum_complexity).toBe(3);

    const projBResult = result.projects.find(p => p.project === 'proj-b');
    expect(projBResult.velocity_summary.count).toBe(2);
    expect(projBResult.velocity_summary.sum_complexity).toBe(6);

    expect(result.totals.total_done).toBeGreaterThan(0);
    expect(result.totals.blocked_count).toBe(0);
  });

  test('один из проектов сломан → пропуск + warning, не fail', async () => {
    const parentDir = createMultiProjectParent('agg-broken-project');

    const projGood = createNamedProject(parentDir, 'proj-good', [
      {
        id: 'G-1',
        status: 'done',
        type: 'IMPL',
        complexity: 1,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);

    const projBad = createNamedProject(parentDir, 'proj-bad', [
      {
        id: 'B-1',
        status: 'done',
        type: 'IMPL',
        complexity: 1,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);

    const aggregateModule = await import('../analytics/aggregate.mjs');
    const originalComputeVelocity = aggregateModule.computeVelocity;
    vi.spyOn(aggregateModule, 'computeVelocity').mockImplementation((projectPath, windowDays) => {
      if (projectPath === projBad) {
        throw new Error('Simulated catastrophic failure');
      }
      return originalComputeVelocity(projectPath, windowDays);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await aggregate_metrics.execute({
      projects: [projGood, projBad],
      window_days: 14
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].project).toBe('proj-good');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('proj-bad')
    );
    expect(result.totals.total_done).toBeGreaterThanOrEqual(1);
  });

  test('projects=[] (явно) → пустые результаты', async () => {
    const result = await aggregate_metrics.execute({
      projects: [],
      window_days: 14
    });

    expect(result.projects).toEqual([]);
    expect(result.totals).toEqual({
      total_done: 0,
      mean_p50_cycle_sec: null,
      blocked_count: 0
    });
  });

  test('discovery default — все обнаруженные проекты обходятся', async () => {
    const parentDir = createMultiProjectParent('agg-discovery');

    createNamedProject(parentDir, 'discovery-a', [
      {
        id: 'DA-1',
        status: 'done',
        type: 'IMPL',
        complexity: 1,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);
    createNamedProject(parentDir, 'discovery-b', [
      {
        id: 'DB-1',
        status: 'done',
        type: 'QA',
        complexity: 2,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        completed_at: new Date().toISOString()
      }
    ]);

    process.env.MCP_CWD = parentDir;

    const result = await aggregate_metrics.execute({
      window_days: 14
    });

    const projectNames = result.projects.map(p => p.project).sort();
    expect(projectNames).toEqual(['discovery-a', 'discovery-b']);
    expect(result.projects).toHaveLength(2);
  });

  test('лимит конкурентности (мок проверяет, что одновременно не больше 5)', async () => {
    const parentDir = createMultiProjectParent('agg-concurrency');

    const projectNames = [];
    for (let i = 1; i <= 12; i++) {
      const name = `proj-${i.toString().padStart(2, '0')}`;
      createNamedProject(parentDir, name, [
        {
          id: `P${i}-1`,
          status: 'done',
          type: 'IMPL',
          complexity: 1,
          created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
          completed_at: new Date().toISOString()
        }
      ]);
      projectNames.push(name);
    }

    const aggregateModule = await import('../analytics/aggregate.mjs');

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const originalComputeVelocity = aggregateModule.computeVelocity;

    const mockedComputeVelocity = vi.fn((projectPath, windowDays) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      const result = originalComputeVelocity(projectPath, windowDays);
      currentConcurrent--;
      return result;
    });

    vi.spyOn(aggregateModule, 'computeVelocity').mockImplementation(mockedComputeVelocity);

    const projectPaths = projectNames.map(n => path.join(parentDir, n));

    await aggregate_metrics.execute({
      projects: projectPaths,
      window_days: 14
    });

    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(mockedComputeVelocity).toHaveBeenCalledTimes(12);
  });
});
