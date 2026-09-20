import { discoverProjects } from '../discovery.mjs';
import { parseFrontmatter, serializeFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { move_ticket } from './tickets.mjs';
import { isValidHumanTicket, loadConfig } from '../validators/human-ticket.mjs';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { mcpCwd, resolveProjectRoot } from '../lib/project-root.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

const TICKETS_DIR = '.workflow/tickets';
const STATUS_DIRS = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

/**
 * Check if a ticket is a HUMAN ticket based on criteria:
 * - type === 'human' in frontmatter, OR
 * - filename starts with 'HUMAN-'
 * @param {Object} frontmatter - Ticket frontmatter
 * @param {string} filename - Ticket filename (e.g., 'HUMAN-123.md')
 * @returns {boolean}
 */
function isHumanTicket(frontmatter, filename) {
  const type = frontmatter.type;
  const isHumanType = type && type.toLowerCase() === 'human';
  const isHumanPrefix = filename.startsWith('HUMAN-');
  return isHumanType || isHumanPrefix;
}

/**
 * List human tickets across all projects or a specific project
 * @param {Object} params - Parameters
 * @param {string} [params.project] - Optional project path to filter by
 * @param {string} [params.status] - Optional status filter
 * @returns {Promise<Array<{project: string, id: string, title: string, priority: number, status: string, age_sec: number, updated_at: string}>>}
 */
export async function list_human_queue({ project, status }) {
  const cwd = mcpCwd();
  const projectsToScan = [];

  if (project) {
    // Single project mode
    const projectRoot = resolveProjectRoot(project);
    projectsToScan.push({ name: path.basename(projectRoot), path: projectRoot });
  } else {
    // All projects mode - discover projects
    const discovered = discoverProjects(cwd);
    projectsToScan.push(...discovered);
  }

  // Status directories to scan (filter if status provided)
  const statusesToScan = status ? [status] : STATUS_DIRS;

  const result = [];

  for (const proj of projectsToScan) {
    const ticketsDir = path.join(proj.path, TICKETS_DIR);

    if (!fs.existsSync(ticketsDir)) {
      continue;
    }

    for (const st of statusesToScan) {
      const statusDir = path.join(ticketsDir, st);
      if (!fs.existsSync(statusDir)) {
        continue;
      }

      const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
      for (const file of files) {
        const filePath = path.join(statusDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const { frontmatter } = parseFrontmatter(content);

          // Check if it's a HUMAN ticket
          if (!isHumanTicket(frontmatter, file)) {
            continue;
          }

          // Extract required fields
          const ticketId = frontmatter.id || file.replace('.md', '');
          const title = frontmatter.title || '';
          const priority = frontmatter.priority || 5; // Default to lowest priority
          const updatedAt = frontmatter.updated_at || frontmatter.created_at || '';

          // Calculate age_sec
          let ageSec = 0;
          if (updatedAt) {
            const updatedDate = new Date(updatedAt);
            const now = new Date();
            ageSec = Math.floor((now - updatedDate) / 1000);
          }

          result.push({
            project: proj.name,
            id: ticketId,
            title,
            priority,
            status: st,
            age_sec: ageSec,
            updated_at: updatedAt
          });
        } catch (e) {
          // Skip malformed tickets
          continue;
        }
      }
    }
  }

  // Sort: priority ASC, then updated_at ASC
  result.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // Sort by updated_at ascending (oldest first)
    return new Date(a.updated_at || 0) - new Date(b.updated_at || 0);
  });

  return result;
}

/**
 * Get extended context for a HUMAN ticket
 * @param {Object} params - Parameters
 * @param {string} params.project - Project path or name
 * @param {string} params.ticket_id - Ticket ID to get context for
 * @returns {Promise<{ticket: Object, parent_plan: Object, deps: Array<{id: string, status: string, result_excerpt: string}>, related_reports: Array<string>, pipeline_steps: Array<Object>}>}
 */
export async function get_human_context({ project, ticket_id }) {
  const cwd = mcpCwd();
  const projectRoot = resolveProjectRoot(project);
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);
  
  // Find the ticket file
  let ticketPath = null;
  let ticketContent = null;
  let ticketFrontmatter = null;
  let ticketBody = null;
  
  // Search for the ticket in all status directories
  for (const status of STATUS_DIRS) {
    const statusDir = path.join(ticketsDir, status);
    if (!fs.existsSync(statusDir)) continue;
    
    const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
    for (const file of files) {
      const filePath = path.join(statusDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(content);
        
        if (frontmatter.id === ticket_id || file === `${ticket_id}.md`) {
          ticketPath = filePath;
          ticketContent = content;
          ticketFrontmatter = frontmatter;
          ticketBody = body;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    if (ticketPath) break;
  }
  
  if (!ticketPath) {
    throw new Error(`Ticket not found: ${ticket_id}`);
  }
  
  // Build result object
  const result = {
    ticket: {
      id: ticket_id,
      ...ticketFrontmatter,
      path: ticketPath,
      body: ticketBody
    },
    parent_plan: null,
    deps: [],
    related_reports: [],
    pipeline_steps: []
  };
  
  // Get parent_plan from frontmatter
  if (ticketFrontmatter.parent_plan) {
    try {
      const planPath = path.join(projectRoot, ticketFrontmatter.parent_plan);
      if (fs.existsSync(planPath)) {
        const planContent = fs.readFileSync(planPath, 'utf8');
        const { frontmatter: planFrontmatter } = parseFrontmatter(planContent);
        result.parent_plan = {
          path: planPath,
          ...planFrontmatter
        };
      }
    } catch (e) {
      // Parent plan not found, continue without it
    }
  }
  
  // Get dependencies
  if (ticketFrontmatter.dependencies) {
    for (const depId of ticketFrontmatter.dependencies) {
      let depPath = null;
      let depContent = null;
      
      // Find dependency ticket
      for (const status of STATUS_DIRS) {
        const statusDir = path.join(ticketsDir, status);
        if (!fs.existsSync(statusDir)) continue;
        
        const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
        for (const file of files) {
          const filePath = path.join(statusDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const { frontmatter, body } = parseFrontmatter(content);
            
            if (frontmatter.id === depId || file === `${depId}.md`) {
              depPath = filePath;
              depContent = content;
              break;
            }
          } catch (e) {
            continue;
          }
        }
        if (depPath) break;
      }
      
        if (depPath) {
          const { frontmatter: depFrontmatter, body: depBody } = parseFrontmatter(depContent);
          
          // Extract result excerpt
          let resultExcerpt = '';
          const resultMatch = depBody.match(/## Результат выполнения\s*\n\n### Summary\s*\n\n([\s\S]*?)(?=\n\n##|\n###|\n##|$)/);
          if (resultMatch) {
            resultExcerpt = resultMatch[1].trim().slice(0, 300);
          }
          
          result.deps.push({
            id: depId,
            status: depPath.includes('done') ? 'done' : depPath.includes('blocked') ? 'blocked' : 'in_progress',
            result_excerpt: resultExcerpt
          });
        }
    }
  }
  
  // Get related reports from parent plan
  if (result.parent_plan && result.parent_plan.related_reports) {
    result.related_reports = result.parent_plan.related_reports || [];
  }
  
  // Get pipeline steps from latest pipeline log
  try {
    const pipelineLogsDir = path.join(projectRoot, '.workflow', 'logs', 'pipeline');
    if (fs.existsSync(pipelineLogsDir)) {
      const logFiles = fs.readdirSync(pipelineLogsDir)
        .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
        .sort();
      
      if (logFiles.length > 0) {
        const latestLog = path.join(pipelineLogsDir, logFiles[logFiles.length - 1]);
        const logContent = fs.readFileSync(latestLog, 'utf8');
        
        // Parse log entries for this ticket
        const logEntries = logContent.split('\n').filter(line => {
          return line.includes(`ticket_id: ${ticket_id}`) || line.includes(`ticket_id:${ticket_id}`);
        });
        
        result.pipeline_steps = logEntries.map(entry => {
          const stepMatch = entry.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):\s*(.*)/);
          if (stepMatch) {
            return {
              timestamp: stepMatch[1],
              action: stepMatch[2].trim()
            };
          }
          return {
            timestamp: '',
            action: entry
          };
        });
      }
    }
  } catch (e) {
    // Pipeline logs not found, continue without them
  }
  
  return result;
}

/**
 * Resolve a human ticket by adding result section and moving it to next status
 * @param {Object} params - Parameters
 * @param {string} params.project - Project path or name
 * @param {string} params.ticket_id - Ticket ID to resolve
 * @param {Object} params.decision - Decision information
 * @param {string} params.result_body - Result body content
 * @param {string} [params.next_status] - Next status (defaults to 'done')
 * @param {boolean} [params.strict] - Enable strict validation (overrides config)
 * @returns {Promise<{id: string, new_status: string, path: string}>}
 */
export async function resolve_human_ticket({ project, ticket_id, decision, result_body, next_status = 'done', strict }) {
  const cwd = mcpCwd();
  const projectRoot = resolveProjectRoot(project);
  const ticketsDir = path.join(projectRoot, TICKETS_DIR);
  
  // Find the ticket file
  let ticketPath = null;
  let ticketContent = null;
  let ticketFrontmatter = null;
  let ticketBody = null;
  let currentStatus = null;
  
  // Search for the ticket in all status directories
  for (const status of STATUS_DIRS) {
    const statusDir = path.join(ticketsDir, status);
    if (!fs.existsSync(statusDir)) continue;
    
    const files = fs.readdirSync(statusDir).filter(f => isWorkflowDoc(f));
    for (const file of files) {
      const filePath = path.join(statusDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(content);
        
        if (frontmatter.id === ticket_id || file === `${ticket_id}.md`) {
          ticketPath = filePath;
          ticketContent = content;
          ticketFrontmatter = frontmatter;
          ticketBody = body;
          currentStatus = status;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    if (ticketPath) break;
  }
  
  if (!ticketPath) {
    throw new Error(`TICKET_NOT_FOUND: Ticket not found: ${ticket_id}`);
  }
  
  // Check if it's a human ticket
  if (!isHumanTicket(ticketFrontmatter, path.basename(ticketPath))) {
    throw new Error(`NOT_HUMAN_TICKET: Ticket is not a human ticket: ${ticket_id}`);
  }

  // Check if already resolved (in done/ and has Result section)
  if (currentStatus === 'done' && ticketBody.includes('## Результат')) {
    throw new Error(`ALREADY_RESOLVED: Ticket is already resolved: ${ticket_id}`);
  }

  // Validate result body
  if (result_body.trim().length === 0) {
    throw new Error(`INCOMPLETE_RESULT: Result body is empty: ${ticket_id}`);
  }

  // Load config and determine strict mode
  const config = loadConfig(projectRoot);
  const isStrict = strict !== undefined ? strict : config.strict_validation;

  // Apply strict validation if enabled
  if (isStrict) {
    const validationResult = isValidHumanTicket(ticketFrontmatter, result_body, {
      ...config,
      projectPath: projectRoot
    });

    if (!validationResult.valid) {
      throw new Error(`INVALID_HUMAN_RESULT: ${validationResult.reason}`);
    }
  }
  
  // Create atomic lock file path
  const lockFilePath = ticketPath + '.lock';
  
  try {
    // Try to create atomic lock using fs.rename
    fs.renameSync(ticketPath, lockFilePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Another process already locked and processed the ticket
      throw new Error(`ALREADY_RESOLVED: Ticket was already resolved by another process: ${ticket_id}`);
    } else {
      throw new Error(`CONCURRENT_MODIFICATION: Could not acquire lock for ticket: ${ticket_id}`);
    }
  }
  
  try {
    // Parse the ticket content again (from lock file)
    const lockContent = fs.readFileSync(lockFilePath, 'utf8');
    let { frontmatter, body } = parseFrontmatter(lockContent);

    // Check again if already resolved (double-check after acquiring lock)
    if (currentStatus === 'done' && body.includes('## Результат')) {
      throw new Error(`ALREADY_RESOLVED: Ticket is already resolved: ${ticket_id}`);
    }

    // Validate result body again
    if (result_body.trim().length === 0) {
      throw new Error(`INCOMPLETE_RESULT: Result body is empty: ${ticket_id}`);
    }

    // Apply strict validation again if enabled
    if (isStrict) {
      const validationResult = isValidHumanTicket(frontmatter, result_body, {
        ...config,
        projectPath: projectRoot
      });

      if (!validationResult.valid) {
        throw new Error(`INVALID_HUMAN_RESULT: ${validationResult.reason}`);
      }
    }

    // Prepare result section
    const isoDate = new Date().toISOString();
    const resultSection = `\n\n## Результат\n**Решение:** ${decision}\n**Дата:** ${isoDate}\n**Исполнитель:** human\n${result_body}`;

    // Add result section to body
    const newBody = body + resultSection;

    // Update frontmatter with review_log entry
    if (!frontmatter.review_log) {
      frontmatter.review_log = [];
    }
    frontmatter.review_log.push({
      date: isoDate,
      action: 'resolved',
      decision: decision.substring(0, 100) // Store summary of decision
    });

    // Serialize the updated content
    const newContent = serializeFrontmatter(frontmatter) + newBody;

    // Write the updated ticket back to original path (from lock)
    fs.writeFileSync(ticketPath, newContent);
    
    // Move the ticket to next status
    await move_ticket({ project, ticket_id, target: next_status });
    
    // Clean up lock file
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
    
    return {
      id: ticket_id,
      new_status: next_status,
      path: ticketPath
    };
    
  } catch (e) {
    // Clean up lock file on error
    if (fs.existsSync(lockFilePath)) {
      fs.renameSync(lockFilePath, ticketPath);
    }
    throw e;
  }
}

/**
 * Регистрация human-очереди как MCP-tools.
 *
 * `resolve_human_ticket` обещан в README и CHANGELOG 1.2.0 как tool с самого
 * начала, но зарегистрирован не был; два соседних тоже нужны клиенту, который
 * ведёт human-тикеты.
 */
export const list_human_queue_tool = {
  name: 'list_human_queue',
  description: 'List HUMAN tickets across all discovered projects or a single one, sorted by priority and age',
  inputSchema: z.object({
    project: z.string().optional().describe('Project path or name; omit to scan all discovered projects'),
    // Значение уходит в path.join к каталогу статусов — держим его закрытым
    // перечислением, как в list_tickets.
    status: z.enum(STATUS_DIRS).optional().describe('Filter by status (directory under .workflow/tickets)')
  }),
  async execute(args) {
    return list_human_queue(args);
  }
};

export const get_human_context_tool = {
  name: 'get_human_context',
  description: 'Get extended context for a HUMAN ticket: the ticket itself, its parent plan, dependencies, related reports and pipeline steps',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    ticket_id: z.string().describe('Ticket ID (e.g. HUMAN-12)')
  }),
  async execute(args) {
    return get_human_context(args);
  }
};

export const resolve_human_ticket_tool = {
  name: 'resolve_human_ticket',
  description: 'Resolve a HUMAN ticket: append the result section and move the ticket to the next status',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    ticket_id: z.string().describe('Ticket ID (e.g. HUMAN-12)'),
    decision: z.string().describe('Decision recorded in the result section'),
    result_body: z.string().describe('Result body appended to the ticket'),
    next_status: z.enum(STATUS_DIRS).optional().describe('Target status (default: done)'),
    strict: z.boolean().optional().describe('Enable strict validation of the result, overriding human_ticket config')
  }),
  async execute(args) {
    return resolve_human_ticket(args);
  }
};
