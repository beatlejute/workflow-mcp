import { findProjectRoot } from '../../../workflowAi/src/lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../../../workflowAi/src/lib/utils.mjs';
import { getFrontmatter, invalidate as invalidateCache } from '../caches/frontmatter-cache.mjs';
import {
  getNextId,
  moveTicket,
  createTicket,
  pickNext
} from '../../../workflowAi/src/lib/operations/tickets.mjs';
import path from 'path';
import fs from 'fs';

const TICKETS_DIR = '.workflow/tickets';

/**
 * Получить абсолютный путь к корню проекта
 * @param {string} project - Путь к проекту (относительно cwd или абсолютный)
 * @returns {string} Абсолютный путь к корню проекта
 */
function resolveProjectRoot(project) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, project);
  // Проверить, что это действительно проект workflow-ai (имеет .workflow)
  const workflowDir = path.join(resolved, '.workflow');
  if (!fs.existsSync(workflowDir)) {
    throw new Error(`Project not found or not a workflow project: ${project}`);
  }
  return resolved;
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
  const statusesToScan = status ? [status] : ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

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
  const projectRoot = resolveProjectRoot(project);
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);

  // Определить статус по пути
  let status_from_dir = null;
  let ticketPath = null;

  for (const st of ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive']) {
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
  const projectRoot = resolveProjectRoot(project);

  // Выполнить перемещение
  const result = await moveTicket(projectRoot, ticket_id, target);

  // Инвалидировать кеш для старого и нового путей
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);
  for (const status of ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive']) {
    const candidate = path.join(ticketsDir, status, `${ticket_id}.md`);
    if (fs.existsSync(candidate)) {
      invalidateCache(candidate);
    }
  }

  return result;
}

/**
 * create_ticket — обёртка operations/tickets::createTicket + getNextId + executor_type для HUMAN
 */
export async function create_ticket({ project, type, title, priority, plan_id, body }) {
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
