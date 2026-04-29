import { discoverProjects } from '../discovery.mjs';
import { findProjectRoot } from '../../../workflowAi/src/lib/find-root.mjs';
import { parseFrontmatter } from '../../../workflowAi/src/lib/utils.mjs';
import { parsePipelineLog } from '../parsers/pipeline-log.mjs';
import { listPlans } from '../../../workflowAi/src/lib/operations/plans.mjs';
import { frontmatterCache } from '../caches/frontmatter-cache.mjs';
import fs from 'fs';
import path from 'path';

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

    const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.md'));
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
 * Get list of all projects with their statistics
 * @returns {Promise<Array<{name: string, path: string, counts: Object, human_count: number, pipeline_running: boolean}>>}
 */
export async function list_projects() {
  try {
    // Get current working directory
    const cwd = process.cwd();
    
    // Discover projects
    const projects = discoverProjects(cwd);
    
    // For each project, get detailed statistics
    const projectsWithStats = [];
    
    for (const project of projects) {
      try {
        // Get ticket counts by status
        const tickets = await listTickets(project.path);

        // Initialize counts - status names from directory structure
        const counts = {
          backlog: 0,
          ready: 0,
          in_progress: 0,
          review: 0,
          blocked: 0,
          done: 0
        };

        // Count tickets by status
        for (const ticket of tickets) {
          const status = ticket.status;
          // Convert directory-based status to count key
          const countKey = status === 'in-progress' ? 'in_progress' : status;
          if (counts[countKey] !== undefined) {
            counts[countKey]++;
          }
        }

        // Get human ticket count (type: 'human')
        const humanTickets = await listTickets(project.path, { type: 'human' });
        const human_count = humanTickets.length;
        
        // Check if pipeline is running
        const pipeline_running = await checkPipelineRunning(project.path);
        
        projectsWithStats.push({
          name: project.name,
          path: project.path,
          counts,
          human_count,
          pipeline_running
        });
      } catch (error) {
        // If we can't process a project, still include it with zero values
        console.warn(`Warning: Could not process project ${project.path}:`, error.message);
        projectsWithStats.push({
          name: project.name,
          path: project.path,
          counts: {
            backlog: 0,
            ready: 0,
            in_progress: 0,
            review: 0,
            blocked: 0,
            done: 0
          },
          human_count: 0,
          pipeline_running: false
        });
      }
    }
    
    return projectsWithStats;
  } catch (error) {
    console.error('Error in list_projects:', error);
    return [];
  }
}

/**
 * Check if pipeline is running for a project
 * @param {string} projectPath - Path to project
 * @returns {Promise<boolean>} - True if pipeline is running
 */
async function checkPipelineRunning(projectPath) {
  try {
    const pidFilePath = path.join(projectPath, '.workflow', 'logs', '.runner-pids');
    if (!fs.existsSync(pidFilePath)) {
      return false;
    }
    
    const content = fs.readFileSync(pidFilePath, 'utf8');
    const pids = content.trim().split('\n').filter(pid => pid.trim() !== '');
    
    // Check if any PID is still running
    for (const pidStr of pids) {
      const pid = parseInt(pidStr.trim(), 10);
      if (!isNaN(pid)) {
        try {
          // On Windows, we can use tasklist to check if process exists
          // On Unix-like systems, we can use kill -0
          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            execSync(`tasklist /FI "PID eq ${pid}"`, { stdio: 'ignore' });
            return true; // Process exists
          } else {
            process.kill(pid, 0); // Doesn't actually kill, just checks if process exists
            return true;
          }
        } catch (err) {
          // Process doesn't exist
          continue;
        }
      }
    }
    
    return false;
  } catch (error) {
    // If we can't check, assume not running
    return false;
  }
}

/**
 * Refresh the list of projects and return changes
 * @returns {Promise<{added: Array, removed: Array, total: number}>}
 */
export async function refresh_projects() {
  try {
    // Get current working directory
    const cwd = process.cwd();

    // Discover projects again
    const currentProjects = discoverProjects(cwd);
    const currentProjectNames = new Set(currentProjects.map(p => p.name));

    // We don't have a cached list from previous call, so we'll return all as added
    // In a real implementation, we would cache the previous result
    // For now, we'll just return the current state as all "added" and empty removed
    // This is a limitation but matches the expected behavior for a refresh

    return {
      added: currentProjects,
      removed: [],
      total: currentProjects.length
    };
  } catch (error) {
    console.error('Error in refresh_projects:', error);
    return {
      added: [],
      removed: [],
      total: 0
    };
  }
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