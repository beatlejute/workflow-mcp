import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { parsePipelineLog } from '../parsers/pipeline-log.mjs';
import { listPlans } from 'workflow-ai/lib/operations/plans.mjs';
import { frontmatterCache } from '../caches/frontmatter-cache.mjs';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { tryResolveProjectRoot } from '../lib/project-root.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

/**
 * List tickets from a project directory
 * @param {string} projectPath - Path to project root
 * @param {Object} options - Options (e.g., type: 'human')
 * @returns {Promise<Array>} Array of ticket objects
 */
async function listTickets(projectPath, options = {}) {
  const ticketsDir = path.join(projectPath, '.workflow', 'tickets');
  const tickets = [];

  if (!fs.existsSync(ticketsDir)) {
    return tickets;
  }

  // Статусы, соответствующие директориям
  const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

  for (const status of statuses) {
    const statusDir = path.join(ticketsDir, status);
    if (!fs.existsSync(statusDir)) {
      continue;
    }

    const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
    for (const file of files) {
      const filePath = path.join(statusDir, file);
      try {
        const { frontmatter } = frontmatterCache.getFrontmatter(filePath);

        const ticket = {
          status,
          ...frontmatter
        };

        // Фильтр по типу если указан
        if (options.type && frontmatter.type !== options.type) {
          continue;
        }

        tickets.push(ticket);
      } catch (error) {
        // Пропускаем файлы, которые не удалось прочитать
        continue;
      }
    }
  }

  return tickets;
}

/**
 * Get project status with counts, active plan, recent pipeline steps, and pending human tasks
 * @param {string} project - Project path
 * @returns {Promise<{counts: Object, active_plan: {id: string, title: string, status: string}|null, recent_steps: Array, pending_human: Array}>}
 */
export async function get_project_status(project) {
  // Return error object (not throw) for non-existent project path
  if (!fs.existsSync(project)) {
    return { error: 'INVALID_PROJECT', message: `Project path does not exist: ${project}` };
  }

  try {
    // Get ticket counts by status
    const tickets = await listTickets(project);
    const counts = {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      blocked: 0,
      done: 0
    };

    for (const ticket of tickets) {
      const status = ticket.status;
      const countKey = status === 'in-progress' ? 'in_progress' : status;
      if (counts[countKey] !== undefined) {
        counts[countKey]++;
      }
    }

    // Get active plan (first plan with status: active)
    let active_plan = null;
    try {
      const plans = await listPlans(project, { status: 'active' });
      if (plans.length > 0) {
        const plan = plans[0];
        active_plan = {
          id: plan.id,
          title: plan.title,
          status: plan.status
        };
      }
    } catch (err) {
      // If unable to get plans, just continue
    }

    // Get recent steps from pipeline logs
    let recent_steps = [];
    try {
      const logsDir = path.join(project, '.workflow', 'logs');
      if (fs.existsSync(logsDir)) {
        const files = fs.readdirSync(logsDir)
          .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
          .sort()
          .reverse();

        if (files.length > 0) {
          const latestLog = path.join(logsDir, files[0]);
          const content = fs.readFileSync(latestLog, 'utf8');
          const steps = parsePipelineLog(content);

          // Get last 5 steps, map to required structure
          recent_steps = steps.slice(-5).map(step => ({
            step_number: step.step_number,
            stage: step.stage,
            status: step.status,
            duration_ms: step.duration_ms,
            context: step.context && step.context.ticket_id ? { ticket_id: step.context.ticket_id } : undefined
          }));
        }
      }
    } catch (err) {
      // If unable to get steps, just continue with empty array
    }

    // Get pending human tickets (type: human in ready, in_progress, blocked)
    let pending_human = [];
    try {
      const humanTickets = await listTickets(project, { type: 'human' });
      pending_human = humanTickets
        .filter(t => ['ready', 'in-progress', 'in_progress', 'blocked'].includes(t.status))
        .map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority
        }));
    } catch (err) {
      // If unable to get human tickets, just continue
    }

    return {
      counts,
      active_plan,
      recent_steps,
      pending_human
    };
  } catch (error) {
    console.error('Error in get_project_status:', error);
    return {
      counts: {
        backlog: 0,
        ready: 0,
        in_progress: 0,
        review: 0,
        blocked: 0,
        done: 0
      },
      active_plan: null,
      recent_steps: [],
      pending_human: []
    };
  }
}
/**
 * Регистрация статуса проекта как MCP-tool.
 *
 * Соседние `list_projects` и `refresh_projects` удалены: первый дублировал
 * ресурс `project://*`, второй по своему же комментарию не умел сравнивать с
 * прошлым состоянием и всегда возвращал всё как «added».
 */
export const get_project_status_tool = {
  name: 'get_project_status',
  description: 'Get project status: ticket counts by status, the active plan, recent pipeline steps and pending human tasks',
  inputSchema: z.object({
    project: z.string().describe('Project path')
  }),
  async execute({ project }) {
    const resolved = tryResolveProjectRoot(project);
    if (!resolved.ok) {
      return { error: 'INVALID_PROJECT', message: resolved.message };
    }
    return get_project_status(resolved.root);
  }
};
