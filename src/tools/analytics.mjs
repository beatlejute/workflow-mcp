import { frontmatterCache } from '../caches/frontmatter-cache.mjs';
import fs from 'fs';
import path from 'path';
import { computeStats, computeCycleTime, computeVelocity } from '../analytics/aggregate.mjs';
import { discoverProjects } from '../discovery.mjs';
import { z } from 'zod';
import { mcpCwd, tryResolveProjectRoot } from '../lib/project-root.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

/**
 * Get velocity metrics for a project grouped by time period
 * @param {string} project - Project path
 * @param {Object} options - Options {window_days=14, group_by='day'}
 * @returns {Promise<Object>} Velocity metrics or error object
 */
export async function get_velocity(project, { window_days = 14, group_by = 'day' } = {}) {
  // Validate window_days
  if (window_days < 1 || window_days > 365) {
    return { error: 'WINDOW_TOO_LARGE', message: `window_days must be between 1 and 365, got ${window_days}` };
  }

  // Validate group_by
  if (!['day', 'week'].includes(group_by)) {
    return { error: 'INVALID_GROUP_BY', message: `group_by must be 'day' or 'week', got ${group_by}` };
  }

  // Check if project exists
  if (!fs.existsSync(project)) {
    return { error: 'PROJECT_NOT_FOUND', message: `Project path does not exist: ${project}` };
  }

  // Check if .workflow/tickets/done exists
  const doneDir = path.join(project, '.workflow', 'tickets', 'done');
  if (!fs.existsSync(doneDir)) {
    return { window_days, group_by, points: [] };
  }

  // Get all done tickets
  const ticketFiles = fs.readdirSync(doneDir).filter(f => isWorkflowDoc(f));
  
  if (ticketFiles.length === 0) {
    return { window_days, group_by, points: [] };
  }

  // Calculate cutoff date
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - (window_days * 24 * 60 * 60 * 1000));

  // Process tickets and group by time period
  const groups = new Map();

  for (const file of ticketFiles) {
    try {
      const filePath = path.join(doneDir, file);
      const { frontmatter } = frontmatterCache.getFrontmatter(filePath);

      // Skip if not done status
      if (frontmatter.status !== 'done') {
        continue;
      }

      // Skip if completed_at is missing
      if (!frontmatter.completed_at) {
        continue;
      }

      const completedDate = new Date(frontmatter.completed_at);

      // Skip if completed before cutoff
      if (completedDate < cutoffDate) {
        continue;
      }

      // Determine group key based on group_by
      let groupKey;
      if (group_by === 'day') {
        // Format as YYYY-MM-DD
        groupKey = completedDate.toISOString().split('T')[0];
      } else if (group_by === 'week') {
        // Format as YYYY-WW (year-weeknumber)
        const year = completedDate.getFullYear();
        // Get week number (ISO week date)
        const weekNumber = getWeekNumber(completedDate);
        groupKey = `${year}-W${String(weekNumber).padStart(2, '0')}`;
      }

      // Initialize group if not exists
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { count: 0, total_complexity: 0 });
      }

      // Update group stats
      const group = groups.get(groupKey);
      group.count += 1;
      
      // Add complexity if available, otherwise count as 1
      const complexity = frontmatter.complexity != null ? Number(frontmatter.complexity) : 1;
      group.total_complexity += complexity;

    } catch (error) {
      // Skip files that can't be parsed
      continue;
    }
  }

  // Convert groups to points array and sort by date
  const points = [];
  for (const [date, stats] of groups.entries()) {
    points.push({
      date,
      count: stats.count,
      total_complexity: stats.total_complexity
    });
  }

  // Sort points by date ASC
  points.sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    window_days,
    group_by,
    points
  };
}

/**
 * Get ticket statistics for a project
 * @param {string} project - Project path
 * @param {Object} options - Options {window_days=14}
 * @returns {Object} Ticket statistics or error object
 */
/**
 * MCP Tool: get_ticket_stats
 * Get ticket statistics for a project
 */
export const get_ticket_stats = {
  name: 'get_ticket_stats',
  description: 'Get ticket statistics for a project (by_status, by_type, blocked_top) filtered by creation window',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    window_days: z.number().min(1).max(365).optional().describe('Window in days for filtering by created_at (default: 14)')
  }),
  async execute(args) {
    const resolved = tryResolveProjectRoot(args.project);
    if (!resolved.ok) {
      return { error: 'PROJECT_NOT_FOUND', message: resolved.message };
    }

    // Compute stats using aggregate function
    const result = computeStats(resolved.root, args.window_days || 14);

    // Normalize by_status: only include expected status buckets
    const expectedStatuses = ["ready", "in_progress", "blocked", "done", "review", "backlog"];
    const statusMap = {
      "in_progress": ["in_progress", "in-progress"],
      "ready": ["ready"],
      "blocked": ["blocked"],
      "done": ["done"],
      "review": ["review"],
      "backlog": ["backlog"]
    };
    const by_status = {};
    for (const status of expectedStatuses) {
      let count = 0;
      for (const key of statusMap[status]) {
        if (result.by_status[key] != null) {
          count += result.by_status[key];
          break;
        }
      }
      by_status[status] = count;
    }

    // Normalize by_type: map invalid types to OTHER
    const by_type = {};
    const validTypes = ['IMPL', 'QA', 'DOCS', 'ARCH', 'FIX', 'REVIEW', 'ADMIN', 'HUMAN', 'RSH'];
    for (const [type, count] of Object.entries(result.by_type)) {
      if (validTypes.includes(type)) {
        by_type[type] = (by_type[type] || 0) + count;
      } else {
        by_type.OTHER = (by_type.OTHER || 0) + count;
      }
    }

    return {
      by_status,
      by_type,
      blocked_top: result.blocked_top
    };
  }
};

/**
 * Get cycle time metrics for a project
 * @param {string} project - Project path
 * @param {Object} options - Options {window_days=14, percentiles?=[50,90]}
 * @returns {Object} Cycle time metrics or error object
 */
export async function get_cycle_time(project, { window_days = 14, percentiles = [50, 90] } = {}) {
  // Validate window_days
  if (window_days < 1 || window_days > 365) {
    return { error: 'WINDOW_TOO_LARGE', message: `window_days must be between 1 and 365, got ${window_days}` };
  }

  // Validate percentiles
  if (!Array.isArray(percentiles) || percentiles.some(p => p < 0 || p > 100)) {
    return { error: 'INVALID_PERCENTILES', message: `percentiles must be an array of numbers between 0 and 100` };
  }

  // Check if project exists
  if (!fs.existsSync(project)) {
    return { error: 'PROJECT_NOT_FOUND', message: `Project path does not exist: ${project}` };
  }

  // Compute cycle time using the aggregate function
  const result = computeCycleTime(project, window_days, percentiles);

  // Handle empty result
  if (result.count === 0) {
    const percentilesResult = {};
    for (const p of percentiles) {
      percentilesResult[`p${p}_sec`] = null;
    }
    return {
      count: 0,
      mean_sec: null,
      ...percentilesResult,
      samples: []
    };
  }

  // Build percentiles object
  const percentilesResult = {};
  for (const p of percentiles) {
    // p50, p85, p95 are always computed by computeCycleTime
    const key = `p${p}_sec`;
    const value = result[`p${p}`];
    percentilesResult[key] = value !== null ? value * 86400 : null;
  }

  // Build samples (limited to 50)
  const samples = result.tickets.slice(0, 50).map(t => ({
    ticket_id: t.id,
    cycle_sec: Math.round(t.days * 86400)
  }));

  return {
    count: result.count,
    mean_sec: result.avg !== null ? result.avg * 86400 : null,
    ...percentilesResult,
    samples
  };
}

/**
 * Get ISO week number for a date
 * @param {Date} date - Date object
 * @returns {number} Week number (1-53)
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday is 0, we want 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/**
 * MCP Tool: aggregate_metrics
 * Aggregate velocity, cycle time, and stats across multiple projects
 */
export const aggregate_metrics = {
  name: 'aggregate_metrics',
  description: 'Aggregate velocity, cycle time, and ticket statistics across multiple workflow projects',
  inputSchema: z.object({
    projects: z.array(z.string()).optional().describe('Optional list of project names or paths (default: all discovered projects)'),
    window_days: z.number().min(1).max(365).optional().describe('Time window in days for filtering metrics (default: 14)')
  }),
  async execute(args) {
    const cwd = mcpCwd();
    const windowDays = args.window_days || 14;

    // Resolve projects list
    let projectsToProcess;
    if (args.projects !== undefined && args.projects !== null) {
      if (!Array.isArray(args.projects)) {
        return { error: 'INVALID_PROJECTS', message: 'projects must be an array' };
      }
      if (args.projects.length > 0) {
        // Validate and resolve provided project paths/names
        const discovered = discoverProjects(cwd);
        const discoveredMap = new Map(discovered.map(p => [p.name, p.path]));
        projectsToProcess = [];
        for (const projRef of args.projects) {
          // Try as name first, then as path
          let projectPath = discoveredMap.get(projRef);
          if (!projectPath) {
            // Try resolving as path relative to cwd
            const resolvedPath = path.resolve(cwd, projRef);
            if (fs.existsSync(path.join(resolvedPath, '.workflow'))) {
              projectPath = resolvedPath;
            }
          }
          if (!projectPath) {
            console.warn(`Warning: project "${projRef}" not found, skipping`);
            continue;
          }
          projectsToProcess.push({
            name: path.basename(projectPath),
            path: projectPath
          });
        }
      } else {
        // Explicit empty array -> no projects
        projectsToProcess = [];
      }
    } else {
      // Default: all discovered projects
      const discovered = discoverProjects(cwd);
      projectsToProcess = discovered;
    }

    // Handle empty project list
    if (projectsToProcess.length === 0) {
      return {
        projects: [],
        totals: {
          total_done: 0,
          mean_p50_cycle_sec: null,
          blocked_count: 0
        }
      };
    }

    // Process projects with concurrency limit of 5
    const CONCURRENCY_LIMIT = 5;

    // Helper: process a single project
    async function processProject(proj) {
      try {
        const velocity = computeVelocity(proj.path, windowDays);
        const cycleTime = computeCycleTime(proj.path, windowDays, [50, 90]);
        const stats = computeStats(proj.path, windowDays);

        return {
          project: proj.name,
          velocity_summary: {
            count: velocity.count,
            sum_complexity: velocity.sum_complexity
          },
          cycle_time_summary: {
            count: cycleTime.count,
            // `computeCycleTime` отдаёт среднее в поле `avg` и в днях. Читался
            // же `mean_sec`, которого там нет вовсе: среднее всегда было
            // `null` — даже когда рядом стояли `count: 2` и оба процентиля.
            mean_sec: cycleTime.avg !== null ? Math.round(cycleTime.avg * 86400) : null,
            p50_sec: cycleTime.p50 !== null ? Math.round(cycleTime.p50 * 86400) : null,
            p90_sec: cycleTime.p90 !== null ? Math.round(cycleTime.p90 * 86400) : null
          },
          stats_summary: stats
        };
      } catch (error) {
        console.warn(`Warning: failed to compute metrics for project ${proj.name}: ${error.message}`);
        return null;
      }
    }

    // Chunk array into batches of CONCURRENCY_LIMIT
    function chunkArray(array, chunkSize) {
      const chunks = [];
      for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
      }
      return chunks;
    }

    // Process in parallel batches
    const batches = chunkArray(projectsToProcess, CONCURRENCY_LIMIT);
    const projectResults = [];

    for (const batch of batches) {
      const batchPromises = batch.map(processProject);
      const batchResults = await Promise.all(batchPromises);
      projectResults.push(...batchResults.filter(r => r !== null));
    }

    // Compute totals
    let totalDone = 0;
    let totalBlocked = 0;
    let sumP50 = 0;
    let countP50 = 0;

    for (const result of projectResults) {
      // Sum done tickets from stats (handle 'done' and 'Done' variations)
      if (result.stats_summary.by_status) {
        for (const [status, count] of Object.entries(result.stats_summary.by_status)) {
          if (status && typeof status === 'string' && status.toLowerCase() === 'done') {
            totalDone += count;
          }
        }
      }
      // Sum blocked tickets from by_status
      if (result.stats_summary.by_status) {
        for (const [status, count] of Object.entries(result.stats_summary.by_status)) {
          if (status && typeof status === 'string' && status.toLowerCase() === 'blocked') {
            totalBlocked += count;
          }
        }
      }
      // Collect p50 values for mean (only if available)
      if (result.cycle_time_summary.p50_sec !== null) {
        sumP50 += result.cycle_time_summary.p50_sec;
        countP50++;
      }
    }

    const meanP50 = countP50 > 0 ? sumP50 / countP50 : null;

    return {
      projects: projectResults,
      totals: {
        total_done: totalDone,
        mean_p50_cycle_sec: meanP50 !== null ? Math.round(meanP50) : null,
        blocked_count: totalBlocked
      }
    };
  }
};

// Tools подхватываются auto-discovery в server.mjs напрямую из именованных
// экспортов — своя фабрика loadTools() тут была не нужна и не вызывалась.

/**
 * Регистрация get_velocity и get_cycle_time как MCP-tools.
 *
 * Сами функции существуют с первого коммита и объявлены в README/CHANGELOG,
 * но зарегистрированы не были: `callTool` по этим именам возвращал
 * `Tool not found`. Функции принимают project позиционно — обёртка переводит
 * вызов в форму, которую отдаёт клиент.
 */
export const get_velocity_tool = {
  name: 'get_velocity',
  description: 'Velocity metrics for a project: completed tickets grouped by day or week over a time window',
  inputSchema: z.object({
    project: z.string().describe('Project path'),
    window_days: z.number().min(1).max(365).optional().describe('Window in days (default: 14)'),
    group_by: z.enum(['day', 'week']).optional().describe("Grouping: 'day' or 'week' (default: day)")
  }),
  async execute({ project, window_days, group_by }) {
    const resolved = tryResolveProjectRoot(project);
    if (!resolved.ok) {
      return { error: 'PROJECT_NOT_FOUND', message: resolved.message };
    }
    return get_velocity(resolved.root, { window_days, group_by });
  }
};

export const get_cycle_time_tool = {
  name: 'get_cycle_time',
  description: 'Cycle time statistics for a project: percentiles and mean time from ticket creation to completion',
  inputSchema: z.object({
    project: z.string().describe('Project path'),
    window_days: z.number().min(1).max(365).optional().describe('Window in days (default: 14)'),
    percentiles: z.array(z.number().min(0).max(100)).optional().describe('Percentiles to compute (default: [50, 90])')
  }),
  async execute({ project, window_days, percentiles }) {
    const resolved = tryResolveProjectRoot(project);
    if (!resolved.ok) {
      return { error: 'PROJECT_NOT_FOUND', message: resolved.message };
    }
    return get_cycle_time(resolved.root, { window_days, percentiles });
  }
};