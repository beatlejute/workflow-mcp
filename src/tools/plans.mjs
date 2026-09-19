import { listPlans, getPlan } from 'workflow-ai/lib/operations/plans.mjs';
import { list_tickets } from './tickets.mjs';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { mcpCwd, resolveProjectRoot } from '../lib/project-root.mjs';

/**
 * Получить абсолютный путь к корню проекта
 * @param {string} project - Путь к проекту (относительно cwd или абсолютный)
 * @returns {string} Абсолютный путь к корню проекта
 */
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

/**
 * Регистрация планов как MCP-tools. Функции выше остаются доступны напрямую —
 * их зовёт в том числе `get_plan` внутри себя.
 */
export const list_plans_tool = {
  name: 'list_plans',
  description: 'List plans of a project with an optional status filter',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    status: z.string().optional().describe('Filter by status: draft, approved, active, completed, archived')
  }),
  async execute(args) {
    return list_plans(args);
  }
};

export const get_plan_tool = {
  name: 'get_plan',
  description: 'Get a plan with its body and the tickets attached to it, split into regular and human tickets',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    plan_id: z.string().describe('Plan ID (e.g. PLAN-001)')
  }),
  async execute(args) {
    return get_plan(args);
  }
};
