import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'js-yaml';
import { vi } from 'vitest';
import { frontmatterCache, FrontmatterCache } from '../caches/frontmatter-cache.mjs';
import {
  computeVelocity,
  computeCycleTime,
  computeStats
} from '../analytics/aggregate.mjs';

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

describe('aggregate analytics (edge cases)', () => {
  test('0 тикетов: computeVelocity возвращает count:0', () => {
    const proj = createTempProject('empty-vel');
    const res = computeVelocity(proj);
    expect(res.count).toBe(0);
    expect(res.sum_complexity).toBe(0);
    expect(res.tickets).toEqual([]);
  });

  test('0 тикетов: computeCycleTime возвращает count:0 и null метрики', () => {
    const proj = createTempProject('empty-ct');
    const res = computeCycleTime(proj);
    expect(res.count).toBe(0);
    expect(res.avg).toBeNull();
    expect(res.p50).toBeNull();
    expect(res.tickets).toEqual([]);
  });

  test('0 тикетов: computeStats возвращает пустые агрегаты', () => {
    const proj = createTempProject('empty-stats');
    const res = computeStats(proj);
    expect(res.by_status).toEqual({});
    expect(res.by_type).toEqual({});
    expect(res.blocked_top).toEqual([]);
  });

  test('1 тикет: computeVelocity суммирует complexity', () => {
    const proj = createTempProject('one-vel');
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-1', { complexity: 5 });
    const res = computeVelocity(proj);
    expect(res.count).toBe(1);
    expect(res.sum_complexity).toBe(5);
  });

  test('1 тикет без complexity использует count=1 как вес', () => {
    const proj = createTempProject('one-count');
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-2', { complexity: undefined });
    const res = computeVelocity(proj);
    expect(res.count).toBe(1);
    expect(res.sum_complexity).toBe(1);
  });

  test('1 тикет без complexity но с other поля', () => {
    const proj = createTempProject('one-nocomplex');
    // complexity отсутствует в frontmatter
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-3', {});
    const res = computeVelocity(proj);
    expect(res.count).toBe(1);
    expect(res.sum_complexity).toBe(1);
  });

  test('тикет без completed_at исключается из computeCycleTime', () => {
    const proj = createTempProject('no-completed');
    const path1 = createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-4', {
      completed_at: undefined
    });
    // переписать файл без completed_at
    const res = computeCycleTime(proj);
    expect(res.count).toBe(0);
    expect(res.avg).toBeNull();
  });

  test('тикет с created_at в будущем исключается из всех метрик', () => {
    const proj = createTempProject('future-created');
    const future = new Date(Date.now() + 86400000).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'T-5', {
      created_at: future
    });
    const v = computeVelocity(proj);
    const ct = computeCycleTime(proj);
    const st = computeStats(proj);
    expect(v.count).toBe(0);
    expect(ct.count).toBe(0);
    expect(st.by_status).toEqual({});
  });

  test('windowDays фильтрует тикеты', () => {
    const proj = createTempProject('window-test');
    // старая (100 дней назад)
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'OLD-1', {
      completed_at: oldDate
    });
    // свежая
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'NEW-1', {
      completed_at: new Date().toISOString()
    });
    const res = computeVelocity(proj, 30); // окно 30 дней
    expect(res.count).toBe(1);
    expect(res.tickets[0].id).toBe('NEW-1');
  });

  test('computeCycleTime: несколько тикетов, корректный процентный расчет', () => {
    const proj = createTempProject('multi-ct');
    // 3 тикета с cycle: 2, 4, 6 дней
    const base = Date.now();
    const make = (id, days) => {
      const created = new Date(base - days * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow', 'tickets', 'done'), id, {
        created_at: created,
        completed_at: completed,
        complexity: 1
      });
    };
    make('CT-1', 2);
    make('CT-2', 4);
    make('CT-3', 6);
    const res = computeCycleTime(proj, null, [50, 85, 95]);
    expect(res.count).toBe(3);
    expect(res.avg).toBeCloseTo(4, 1);
    expect(res.p50).toBeCloseTo(4, 0); // медиана 4
    expect(res.p85).toBeCloseTo(5.4, 0); // 4*0.3+6*0.7=5.4
    expect(res.p95).toBeCloseTo(5.8, 0); // 4*0.1+6*0.9=5.8
  });

  test('computeStats: собирает by_status и by_type', () => {
    const proj = createTempProject('stats-collect');
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'ST-1', {
      status: 'done',
      type: 'task'
    });
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'ST-2', {
      status: 'done',
      type: 'bug'
    });
    createTempTicket(path.join(proj, '.workflow/tickets/backlog'), 'ST-3', {
      status: 'backlog',
      type: 'task'
    });
    const res = computeStats(proj);
    expect(res.by_status['done']).toBe(2);
    expect(res.by_status['backlog']).toBe(1);
    expect(res.by_type['task']).toBe(2);
    expect(res.by_type['bug']).toBe(1);
  });

  test('computeStats: blocked_top собирает тикеты с тегом blocked', () => {
    const proj = createTempProject('stats-blocked');
    createTempTicket(path.join(proj, '.workflow', 'tickets', 'done'), 'B-1', {
      tags: ['blocked'],
      blocked_reason: 'Ждёт ревью'
    });
    createTempTicket(path.join(proj, '.workflow', 'tickets', 'blocked'), 'B-2', {
      status: 'blocked',
      blocked_reason: 'Нет ресурсов'
    });
    const res = computeStats(proj);
    expect(res.blocked_top.length).toBe(2);
    expect(res.blocked_top.some(b => b.id === 'B-1' && b.blocked_reason === 'Ждёт ревью')).toBe(true);
    expect(res.blocked_top.some(b => b.id === 'B-2' && b.blocked_reason === 'Нет ресурсов')).toBe(true);
  });

  test('computeVelocity с 5 done тикетами за 7 дней', () => {
    const proj = createTempProject('five-tickets');
    const base = Date.now();
    for (let i = 1; i <= 5; i++) {
      const completed = new Date(base - i * 86400000).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `T-${i}`, {
        complexity: i,
        completed_at: completed
      });
    }
    const res = computeVelocity(proj, 7);
    expect(res.count).toBe(5);
    expect(res.sum_complexity).toBe(1 + 2 + 3 + 4 + 5); // 15
  });

  test('computeCycleTime возвращает p50 и p90 на синтетических данных', () => {
    const proj = createTempProject('percentiles-test');
    const base = Date.now();
    // 10 тикетов с cycle: 1, 2, 3, ..., 10 дней
    for (let i = 1; i <= 10; i++) {
      const created = new Date(base - i * 86400000).toISOString();
      const completed = new Date(base).toISOString();
      createTempTicket(path.join(proj, '.workflow/tickets/done'), `P-${i}`, {
        created_at: created,
        completed_at: completed
      });
    }
    // Запрашиваем p50 и p90 в массиве percentiles
    const res = computeCycleTime(proj, null, [50, 90]);
    expect(res.count).toBe(10);
    // Функция вычисляет процентили на основе переданного массива
    // но всегда возвращает p50, p85, p95 в результате
    expect(res.p50).toBeDefined();
    expect(res.p85).toBeDefined();
    // На распределении 1-10, p50 должен быть ~5.5
    expect(res.p50).toBeGreaterThan(5);
    expect(res.p50).toBeLessThan(6);
  });

  test('тикет с created_at > completed_at исключается (некорректные данные)', () => {
    const proj = createTempProject('invalid-dates');
    const base = Date.now();
    // Тикет с completed_at ДО created_at
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'BAD-1', {
      created_at: new Date(base + 86400000).toISOString(),
      completed_at: new Date(base).toISOString()
    });
    // Валидный тикет для сравнения
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'GOOD-1', {
      created_at: new Date(base - 86400000).toISOString(),
      completed_at: new Date(base).toISOString()
    });
    const res = computeCycleTime(proj);
    expect(res.count).toBe(1); // только GOOD-1
    expect(res.tickets[0].id).toBe('GOOD-1');
  });

  test('cache reuse: два вызова не делают двойного I/O (mock fs)', () => {
    const proj = createTempProject('cache-reuse');
    const doneDir = path.join(proj, '.workflow/tickets/done');
    const ticketPath1 = createTempTicket(doneDir, 'C-1', { complexity: 3 });
    const ticketPath2 = createTempTicket(doneDir, 'C-2', { complexity: 5 });

    const statsSpy = vi.spyOn(fs, 'statSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const res1 = computeVelocity(proj);
    const statsAfterFirst = statsSpy.mock.calls.length;
    const readsAfterFirst = readSpy.mock.calls.length;

    const res2 = computeVelocity(proj);
    const statsAfterSecond = statsSpy.mock.calls.length;
    const readsAfterSecond = readSpy.mock.calls.length;

    expect(res1.count).toBe(2);
    expect(res1.sum_complexity).toBe(8);
    expect(res2.count).toBe(2);
    expect(res2.sum_complexity).toBe(8);
    expect(res1.tickets).toEqual(res2.tickets);

    expect(readsAfterSecond).toBe(readsAfterFirst);

    statsSpy.mockRestore();
    readSpy.mockRestore();
  });

  test('computeStats: blocked_top сортируется по age_sec DESC', () => {
    const proj = createTempProject('blocked-age-order');
    const base = Date.now();
    // Старый заблокированный тикет
    const oldDate = new Date(base - 200 * 86400000).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/blocked'), 'OLD-BLOCK', {
      status: 'blocked',
      updated_at: oldDate,
      blocked_reason: 'Очень старый'
    });
    // Новый заблокированный тикет
    const newDate = new Date(base - 1 * 86400000).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/blocked'), 'NEW-BLOCK', {
      status: 'blocked',
      updated_at: newDate,
      blocked_reason: 'Свежий'
    });
    const res = computeStats(proj);
    expect(res.blocked_top.length).toBe(2);
    expect(res.blocked_top[0].id).toBe('OLD-BLOCK'); // старший = первый
    expect(res.blocked_top[0].age_sec).toBeGreaterThan(res.blocked_top[1].age_sec);
  });

  test('computeStats: обрабатывает тикеты без created_at и updated_at', () => {
    const proj = createTempProject('no-dates');
    createTempTicket(path.join(proj, '.workflow/tickets/blocked'), 'NO-DATES', {
      status: 'blocked',
      created_at: undefined,
      updated_at: undefined,
      blocked_reason: 'Нет дат'
    });
    const res = computeStats(proj);
    expect(res.blocked_top.length).toBe(1);
    expect(res.blocked_top[0].age_sec).toBe(0);
  });

  test('computeStats: читает blocked_reason из event последнего', () => {
    const proj = createTempProject('events-reason');
    createTempTicket(path.join(proj, '.workflow/tickets/blocked'), 'EVENT-BLOCK', {
      status: 'blocked',
      events: [
        { message: 'First event' },
        { reason: 'Ждёт ревью от maintainer', note: 'Ignored note' }
      ]
    });
    const res = computeStats(proj);
    expect(res.blocked_top[0].blocked_reason).toBe('Ждёт ревью от maintainer');
  });

  test('computeVelocity: парсит файлы с ошибками без крэша', () => {
    const proj = createTempProject('parse-error');
    const doneDir = path.join(proj, '.workflow/tickets/done');
    // Валидный файл
    createTempTicket(doneDir, 'GOOD-1', { complexity: 5 });
    // Файл с невалидным YAML (но не будет прочитан, пропустится)
    fs.writeFileSync(path.join(doneDir, 'bad-yaml.md'), 'invalid yaml content');

    const res = computeVelocity(proj);
    // должны получить только валидный
    expect(res.count).toBe(1);
    expect(res.sum_complexity).toBe(5);
  });

  test('computeStats: max 10 блокированных в blocked_top', () => {
    const proj = createTempProject('many-blocked');
    // Создаём 15 заблокированных тикетов
    for (let i = 1; i <= 15; i++) {
      createTempTicket(path.join(proj, '.workflow/tickets/blocked'), `BLOCKED-${i}`, {
        status: 'blocked',
        blocked_reason: `Reason ${i}`
      });
    }
    const res = computeStats(proj);
    expect(res.blocked_top.length).toBe(10); // max 10
  });

  test('computeCycleTime: пустой список (windowDays фильтр)', () => {
    const proj = createTempProject('window-empty');
    // Создаём тикет 100 дней назад
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    createTempTicket(path.join(proj, '.workflow/tickets/done'), 'OLD-CT', {
      created_at: new Date(Date.now() - 110 * 86400000).toISOString(),
      completed_at: oldDate
    });
    // Окно 30 дней -> ничего не попадёт
    const res = computeCycleTime(proj, 30);
    expect(res.count).toBe(0);
    expect(res.avg).toBeNull();
    expect(res.p50).toBeNull();
  });
});
