import { listPlans, getPlan } from '../../../workflowAi/src/lib/operations/plans.mjs';
import { list_tickets } from './tickets.mjs';
import path from 'path';
import fs from 'fs';

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
    const err = new Error(`Project not found or not a workflow project: ${project}`);
    err.code = 'INVALID_PROJECT';
    throw err;
  }
  return resolved;
}

/**
 * list_plans — обёртка над operations/plans::listPlans
 * @param {Object} params - Параметры
 * @param {string} params.project - Путь к проекту
 * @param {string} [params.status] - Фильтр по статусу (draft, approved, active, completed, archived)
 * @returns {Promise<Array<{id: string, title: string, status: string, path: string}>>}
 */
export async function list_plans({ project, status }) {
  const projectRoot = resolveProjectRoot(project);
  const plans = await listPlans(projectRoot, { status });
  return plans;
}

/**
 * get_plan — обёртка над operations/plans::getPlan с join тикетов
 * @param {Object} params - Параметры
 * @param {string} params.project - Путь к проекту
 * @param {string} params.plan_id - ID плана (e.g., 'PLAN-001')
 * @returns {Promise<{frontmatter: Object, body: string, tickets: Array, human_tickets: Array}>}
 */
export async function get_plan({ project, plan_id }) {
  const projectRoot = resolveProjectRoot(project);

  // Validate plan_id: reject path traversal
  if (!plan_id || plan_id.includes('..') || path.isAbsolute(plan_id)) {
    const err = new Error(`Invalid plan_id: ${plan_id}`);
    err.code = 'INVALID_PLAN_ID';
    throw err;
  }

  let plan;
  try {
    plan = await getPlan(projectRoot, plan_id);
  } catch (e) {
    if (e.code !== 'INVALID_PROJECT' && e.code !== 'INVALID_PLAN_ID') {
      const err = new Error(e.message);
      err.code = 'PLAN_NOT_FOUND';
      throw err;
    }
    throw e;
  }

  // Получить все тикеты для этого плана
  const allTickets = await list_tickets({ project, plan_id });

  // Разделить на обычные и HUMAN-тикеты
  const tickets = allTickets
    .filter(t => t.type !== 'human' && !t.id.startsWith('HUMAN-'))
    .map(t => ({ id: t.id, type: t.type, status: t.status, title: t.title }));

  const human_tickets = allTickets
    .filter(t => t.type === 'human' || t.id.startsWith('HUMAN-'))
    .map(t => ({ id: t.id, type: t.type, status: t.status, title: t.title }));

  return {
    frontmatter: plan.frontmatter,
    body: plan.body,
    tickets,
    human_tickets
  };
}
