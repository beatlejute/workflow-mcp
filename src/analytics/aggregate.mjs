import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFrontmatter } from '../caches/frontmatter-cache.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Получить все тикеты проекта из .workflow/tickets.
 *
 * Вместе с путём возвращается статус — имя каталога, в котором лежит файл.
 * Это единственный источник статуса: поле `status` во frontmatter живёт своей
 * жизнью и остаётся тем, чем было в момент последней записи в тикет. Тикет,
 * перенесённый в `done/`, продолжает носить в себе `status: in-progress`, и
 * счёт по frontmatter врал в обе стороны.
 *
 * @param {string} projectPath - Абсолютный путь к корню проекта
 * @returns {Array<{path: string, status: string}>}
 */
function getTicketFiles(projectPath) {
  const ticketsDir = path.join(projectPath, '.workflow', 'tickets');
  if (!fs.existsSync(ticketsDir)) {
    return [];
  }

  const ticketFiles = [];
  const statuses = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done'];

  for (const status of statuses) {
    const statusDir = path.join(ticketsDir, status);
    if (fs.existsSync(statusDir)) {
      const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
      for (const file of files) {
        ticketFiles.push({ path: path.join(statusDir, file), status });
      }
    }
  }

  return ticketFiles;
}

/**
 * Идентификатор тикета.
 *
 * Обычно он во frontmatter, но бывает и без него: в рабочей области такой
 * тикет один на девять сотен (`PulseProxy/.workflow/tickets/done/IMPL-40.md`).
 * Имя файла — тот же идентификатор, и остальной код (`list_blocked_tickets`)
 * давно так и делает. Требовать поле значило бы молча выкинуть настоящий тикет
 * из velocity и cycle time.
 *
 * @param {object} frontmatter
 * @param {string} filePath
 * @returns {string} id либо пустая строка, если файл вообще не похож на тикет
 */
function ticketId(frontmatter, filePath) {
  if (frontmatter && typeof frontmatter.id === 'string' && frontmatter.id.length > 0) {
    return frontmatter.id;
  }
  return path.basename(filePath, '.md');
}

/**
 * Проверить, что тикет в статусе done и в пределах временного окна.
 * @param {object} fm - frontmatter тикета
 * @param {number} windowDays - окно в днях (null/undefined = все времени)
 * @param {string} status - статус из каталога, а не из frontmatter
 * @returns {boolean}
 */
function isTicketInWindow(fm, windowDays, status) {
  if (status !== 'done') {
    return false;
  }

  if (!windowDays) {
    return true;
  }

  if (!fm.completed_at) {
    return false;
  }

  const completed = new Date(fm.completed_at);
  const now = new Date();
  const diffDays = (now - completed) / (1000 * 60 * 60 * 24);

  return diffDays <= windowDays;
}

/**
 * Проверить, что created_at в будущем (edge case).
 * @param {object} fm - frontmatter тикета
 * @returns {boolean}
 */
function hasFutureCreatedAt(fm) {
  if (!fm.created_at) return false;
  const created = new Date(fm.created_at);
  const now = new Date();
  return created > now;
}

/**
 * Вес тикета по сложности.
 *
 * `complexity` в тикетах — слово: `simple`, `medium`, `complex` (917 тикетов в
 * рабочей области, других значений нет). Прежний `Number(complexity)` давал на
 * них `NaN`, и вся сумма проекта превращалась в `NaN` — в JSON это `null`.
 * Число тоже принимается: старые тикеты писали его цифрой.
 *
 * @param {string|number|null|undefined} complexity
 * @returns {number}
 */
function complexityWeight(complexity) {
  if (complexity == null) return 1;

  const numeric = Number(complexity);
  if (Number.isFinite(numeric)) return numeric;

  const weights = { simple: 1, medium: 2, complex: 3 };
  return weights[String(complexity).trim().toLowerCase()] ?? 1;
}

/**
 * Вычислить velocity за окно.
 * Суммирует complexity если поле есть, иначе count (по умолчанию 1).
 * @param {string} projectPath - путь к проекту
 * @param {number} windowDays - окно в днях (null/unset = всё время)
 * @param {string|null} groupBy - не используется (for future)
 * @returns {object} { count, sum_complexity, tickets }
 */
export function computeVelocity(projectPath, windowDays = null, groupBy = null) {
  const tickets = getTicketFiles(projectPath);
  let sum = 0;
  let count = 0;
  const included = [];

  for (const { path: ticketPath, status } of tickets) {
    try {
      const { frontmatter } = getFrontmatter(ticketPath);

      // Файл без frontmatter — не тикет: так выглядит обрывок записи или
      // случайный `.md` в каталоге. Раньше его отсекало требование
      // `status: done` во frontmatter; теперь статус берётся из каталога, и
      // отсечка нужна своя. Отсутствие одного лишь поля `id` тикетом быть не
      // мешает — идентификатор тогда берётся из имени файла.
      if (!frontmatter || Object.keys(frontmatter).length === 0) {
        continue;
      }

      if (hasFutureCreatedAt(frontmatter)) {
        continue; // пропускаем edge case
      }

      if (!isTicketInWindow(frontmatter, windowDays, status)) {
        continue;
      }

      count++;
      const complexity = complexityWeight(frontmatter.complexity);
      sum += complexity;
      included.push({ id: ticketId(frontmatter, ticketPath), complexity });
    } catch (e) {
      // Пропускаем файлы с ошибками парсинга
      continue;
    }
  }

  return {
    count,
    sum_complexity: sum,
    tickets: included
  };
}

/**
 * Вычислить среднее cycle time (created_at → completed_at) в днях.
 * @param {string} projectPath - путь к проекту
 * @param {number} windowDays - окно в днях (null/unset = всё время)
 * @param {number[]} percentiles - процентили [50, 85, 95] (по умолчанию)
 * @returns {object} { count, avg, p50, p85, p95, tickets }
 */
export function computeCycleTime(projectPath, windowDays = null, percentiles = [50, 85, 95]) {
  const tickets = getTicketFiles(projectPath);
  const cycles = [];

  for (const { path: ticketPath, status } of tickets) {
    try {
      const { frontmatter } = getFrontmatter(ticketPath);

      if (!frontmatter || Object.keys(frontmatter).length === 0) {
        continue;
      }

      if (hasFutureCreatedAt(frontmatter)) {
        continue;
      }

      if (!isTicketInWindow(frontmatter, windowDays, status)) {
        continue;
      }

      // Пропускаем тикеты без completed_at
      if (!frontmatter.completed_at) {
        continue;
      }

      if (!frontmatter.created_at) {
        continue;
      }

      const created = new Date(frontmatter.created_at);
      const completed = new Date(frontmatter.completed_at);

      if (completed < created) {
        continue; // некорректные данные
      }

      const days = (completed - created) / (1000 * 60 * 60 * 24);
      cycles.push({ id: ticketId(frontmatter, ticketPath), days });
    } catch (e) {
      continue;
    }
  }

  const count = cycles.length;

  if (count === 0) {
    return {
      count: 0,
      avg: null,
      p50: null,
      p85: null,
      p95: null,
      tickets: []
    };
  }

  const sorted = cycles.map(c => c.days).sort((a, b) => a - b);

  const avg = sorted.reduce((sum, v) => sum + v, 0) / count;

  function getPercentile(p) {
    const idx = (p / 100) * (sorted.length - 1);
    const low = Math.floor(idx);
    const high = Math.ceil(idx);
    if (low === high) return sorted[low];
    const weight = idx - low;
    return sorted[low] * (1 - weight) + sorted[high] * weight;
  }

  // Вычисляем все запрошенные процентили
  const result = {
    count,
    avg,
    tickets: cycles
  };

  for (const p of percentiles) {
    result[`p${p}`] = getPercentile(p);
  }

  // Для обратной совместимости, всегда включаем p50, p85, p95
  if (!result.p50) result.p50 = getPercentile(50);
  if (!result.p85) result.p85 = getPercentile(85);
  if (!result.p95) result.p95 = getPercentile(95);

  return result;
}

/**
 * Проверить, что тикет создан в пределах окна (based on created_at).
 * @param {object} fm - frontmatter
 * @param {number} windowDays
 * @returns {boolean}
 */
function isCreatedWithinWindow(fm, windowDays) {
  if (!windowDays) return true;
  if (!fm.created_at) return false;
  const created = new Date(fm.created_at);
  const now = new Date();
  if (isNaN(created.getTime()) || created > now) return false;
  const diffDays = (now - created) / (1000 * 60 * 60 * 24);
  return diffDays <= windowDays;
}

/**
 * Вычислить статистику по статусам, типам и блокировкам.
 * Фильтрация: по created_at (если windowDays задан), исключая будущие created_at.
 * @param {string} projectPath - путь к проекту
 * @param {number} windowDays - окно в днях (null/unset = всё время)
 * @returns {object} { by_status, by_type, blocked_top }
 */
export function computeStats(projectPath, windowDays = null) {
  const tickets = getTicketFiles(projectPath);
  const by_status = {};
  const by_type = {};
  const blocked = [];

  for (const { path: ticketPath, status } of tickets) {
    try {
      const { frontmatter } = getFrontmatter(ticketPath);

      if (!frontmatter || Object.keys(frontmatter).length === 0) continue;

      // Пропускаем тикеты с created_at в будущем
      if (hasFutureCreatedAt(frontmatter)) continue;

      // Применяем фильтр по created_at, если задан windowDays
      if (windowDays != null && !isCreatedWithinWindow(frontmatter, windowDays)) continue;

      by_status[status] = (by_status[status] || 0) + 1;

      const type = frontmatter.type || 'unknown';
      by_type[type] = (by_type[type] || 0) + 1;

      // blocked_top: тикеты в каталоге blocked или с тегом blocked
      const isBlocked = status === 'blocked' ||
                        (Array.isArray(frontmatter.tags) && frontmatter.tags.includes('blocked'));
      const id = ticketId(frontmatter, ticketPath);
      if (isBlocked && !blocked.some(b => b.id === id)) {
        let blockedReason = '';
        // из последнего events
        if (Array.isArray(frontmatter.events) && frontmatter.events.length > 0) {
          const lastEvent = frontmatter.events[frontmatter.events.length - 1];
          blockedReason = lastEvent.reason || lastEvent.message || lastEvent.note || '';
        }
        if (!blockedReason && frontmatter.blocked_reason) {
          blockedReason = frontmatter.blocked_reason;
        }
        const updatedAt = frontmatter.updated_at || frontmatter.created_at || '';
        let ageSec = 0;
        if (updatedAt) {
          const dt = new Date(updatedAt);
          if (!isNaN(dt.getTime())) {
            ageSec = Math.floor((Date.now() - dt.getTime()) / 1000);
          }
        }
        blocked.push({ id, blocked_reason: blockedReason, age_sec: ageSec });
      }
    } catch (e) {
      continue;
    }
  }

  // Сортировка по age_sec DESC (старые первыми)
  blocked.sort((a, b) => b.age_sec - a.age_sec);

  return {
    by_status,
    by_type,
    blocked_top: blocked.slice(0, 10) // топ-10
  };
}
