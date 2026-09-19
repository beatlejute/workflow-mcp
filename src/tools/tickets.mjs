import { parseFrontmatter, serializeFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { getFrontmatter, invalidate as invalidateCache } from '../caches/frontmatter-cache.mjs';
import {
  moveTicket,
  createTicket,
  pickNext
} from 'workflow-ai/lib/operations/tickets.mjs';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { mcpCwd, resolveProjectRoot } from '../lib/project-root.mjs';

const TICKETS_DIR = '.workflow/tickets';

/** Статусы тикета — они же имена директорий внутри `.workflow/tickets`. */
const TICKET_STATUSES = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

/**
 * Получить абсолютный путь к корню проекта
 * @param {string} project - Путь к проекту (относительно cwd или абсолютный)
 * @returns {string} Абсолютный путь к корню проекта
 */
/**
 * Идентификатор тикета и его тип попадают прямо в имя файла, поэтому обязаны
 * быть одним сегментом пути без разделителей и точек.
 *
 * Пока это были внутренние функции, проверять было некому — звали их свои же
 * модули. После регистрации как MCP-tools значение приходит от клиента, и
 * `../../../../secret` читал, создавал и перезаписывал файлы за пределами
 * проекта. Соседние tools (`get_report`, `get_plan`) валидируют так же.
 *
 * @param {string} value проверяемое значение
 * @param {string} field имя параметра для сообщения об ошибке
 * @returns {string} то же значение
 * @throws {Error} если значение не односегментное
 */
function assertPathSegment(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    const err = new Error(`Invalid ${field}: ${value}. Allowed characters: A-Z a-z 0-9 _ -`);
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
  return value;
}

/**
 * list_tickets — фильтры + frontmatter-cache для списков
 */
export async function list_tickets({ project, status, plan_id, priority, type }) {
  const projectRoot = resolveProjectRoot(project);
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);

  if (!fs.existsSync(ticketsDir)) {
    return [];
  }

  // Статусы-директории
  const statusesToScan = status ? [status] : TICKET_STATUSES;

  const result = [];

  for (const st of statusesToScan) {
    const statusDir = path.join(ticketsDir, st);
    if (!fs.existsSync(statusDir)) continue;

    const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(statusDir, file);
      try {
        // Используем кеш (не прямой parseFrontmatter)
        const { frontmatter } = getFrontmatter(filePath);

        // Фильтр по plan_id
        if (plan_id !== undefined && frontmatter.plan_id !== plan_id) {
          continue;
        }

        // Фильтр по priority
        if (priority !== undefined && frontmatter.priority !== priority) {
          continue;
        }

        // Фильтр по type
        if (type !== undefined && frontmatter.type !== type) {
          continue;
        }

        result.push({
          id: frontmatter.id,
          title: frontmatter.title,
          status: st,
          type: frontmatter.type,
          priority: frontmatter.priority,
          plan_id: frontmatter.plan_id,
          path: filePath
        });
      } catch (e) {
        // Пропускаем битые/непарсящиеся файлы
        continue;
      }
    }
  }

  return result;
}

/**
 * get_ticket — чтение файла + frontmatter + body + статус из директории
 */
export async function get_ticket({ project, ticket_id }) {
  assertPathSegment(ticket_id, 'ticket_id');
  const projectRoot = resolveProjectRoot(project);
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);

  // Определить статус по пути
  let status_from_dir = null;
  let ticketPath = null;

  for (const st of TICKET_STATUSES) {
    const candidate = path.join(ticketsDir, st, `${ticket_id}.md`);
    if (fs.existsSync(candidate)) {
      status_from_dir = st;
      ticketPath = candidate;
      break;
    }
  }

  if (!ticketPath) {
    throw new Error(`Ticket not found: ${ticket_id}`);
  }

  // Чтение файла
  const content = fs.readFileSync(ticketPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    frontmatter,
    body,
    status_from_dir: status_from_dir,
    path: ticketPath
  };
}

/**
 * pick_next_ticket — обёртка operations/tickets::pickNext
 */
export async function pick_next_ticket({ project }) {
  const projectRoot = resolveProjectRoot(project);
  return await pickNext(projectRoot);
}

/**
 * move_ticket — обёртка operations/tickets::moveTicket + инвалидация кеша
 */
export async function move_ticket({ project, ticket_id, target }) {
  assertPathSegment(ticket_id, 'ticket_id');
  const projectRoot = resolveProjectRoot(project);

  // Выполнить перемещение.
  // Недопустимый переход раннер сообщает голым объектом `{code, from, to, id}`,
  // а не Error. Обработчик сервера берёт `err.message` — клиент получал
  // «Error executing tool move_ticket: undefined». Приводим к Error.
  let result;
  try {
    result = await moveTicket(projectRoot, ticket_id, target);
  } catch (e) {
    if (e instanceof Error) {
      throw e;
    }
    // Ненайденный тикет раннер сообщает тем же кодом, но с `from: null` —
    // «Invalid transition: null → review» вводит в заблуждение.
    if (e && e.code === 'INVALID_TRANSITION' && e.from == null) {
      const err = new Error(`Ticket not found: ${e.id ?? ticket_id}`);
      err.code = 'TICKET_NOT_FOUND';
      throw err;
    }
    const err = new Error(
      e && e.code === 'INVALID_TRANSITION'
        ? `Invalid transition for ${e.id ?? ticket_id}: ${e.from} → ${e.to}`
        : `move_ticket failed: ${JSON.stringify(e)}`
    );
    err.code = (e && e.code) || 'MOVE_FAILED';
    throw err;
  }

  // Инвалидировать кеш для старого и нового путей
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);
  for (const status of TICKET_STATUSES) {
    const candidate = path.join(ticketsDir, status, `${ticket_id}.md`);
    if (fs.existsSync(candidate)) {
      invalidateCache(candidate);
    }
  }

  return result;
}

/**
 * create_ticket — обёртка operations/tickets::createTicket + executor_type для HUMAN
 */
export async function create_ticket({ project, type, title, priority, plan_id, body }) {
  assertPathSegment(type, 'type');
  const projectRoot = resolveProjectRoot(project);

  // Собираем данные для createTicket
  const data = {
    type,
    title,
    priority,
    plan_id,
    body
  };

  // Создание тикета через operations
  const { id, path: ticketPath } = await createTicket(projectRoot, data);

  // Если type === 'HUMAN' (case-insensitive), обновить frontmatter и добавить executor_type
  if (type && type.toLowerCase() === 'human') {
    const content = fs.readFileSync(ticketPath, 'utf8');
    const { frontmatter, body: bodyContent } = parseFrontmatter(content);
    frontmatter.executor_type = 'human';
    const newContent = serializeFrontmatter(frontmatter) + bodyContent;
    fs.writeFileSync(ticketPath, newContent, 'utf8');
  }

  // Инвалидировать кеш для пути нового тикета
  invalidateCache(ticketPath);

  return { id, path: ticketPath };
}

/**
 * Регистрация тикетных операций как MCP-tools.
 *
 * Функции выше существуют с первого коммита и используются внутри
 * (`list_tickets` — в plans.mjs, `move_ticket` — в human.mjs), но клиенту
 * доступны не были. Именованные экспорты функций остаются как есть — обёртки
 * лежат рядом под суффиксом `_tool`.
 */
export const list_tickets_tool = {
  name: 'list_tickets',
  description: 'List tickets of a project with optional filters by status, plan, priority and type',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    status: z.enum(TICKET_STATUSES).optional().describe('Filter by status (directory under .workflow/tickets)'),
    plan_id: z.string().optional().describe('Filter by plan ID (e.g. PLAN-001)'),
    priority: z.number().optional().describe('Filter by priority (1 = highest)'),
    type: z.string().optional().describe('Filter by ticket type (impl, qa, human, ...)')
  }),
  async execute(args) {
    return list_tickets(args);
  }
};

export const get_ticket_tool = {
  name: 'get_ticket',
  description: 'Get a single ticket: frontmatter, body, status derived from its directory, and file path',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    ticket_id: z.string().describe('Ticket ID (e.g. IMPL-12)')
  }),
  async execute(args) {
    return get_ticket(args);
  }
};

export const pick_next_ticket_tool = {
  name: 'pick_next_ticket',
  description: 'Pick the next ticket to work on according to the project ordering rules',
  inputSchema: z.object({
    project: z.string().describe('Project path or name')
  }),
  async execute(args) {
    return pick_next_ticket(args);
  }
};

export const move_ticket_tool = {
  name: 'move_ticket',
  description: 'Move a ticket to another status directory, respecting the allowed transitions',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    ticket_id: z.string().describe('Ticket ID (e.g. IMPL-12)'),
    target: z.enum(TICKET_STATUSES).describe('Target status')
  }),
  async execute(args) {
    return move_ticket(args);
  }
};

export const create_ticket_tool = {
  name: 'create_ticket',
  description: 'Create a ticket in the backlog; type "human" also gets executor_type: human in frontmatter',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    type: z.string().describe('Ticket type (impl, qa, fix, human, ...)'),
    title: z.string().describe('Ticket title'),
    priority: z.number().optional().describe('Priority, 1 = highest (default: 3)'),
    plan_id: z.string().optional().describe('Parent plan ID (e.g. PLAN-001)'),
    body: z.string().optional().describe('Ticket body in Markdown')
  }),
  async execute(args) {
    return create_ticket(args);
  }
};
