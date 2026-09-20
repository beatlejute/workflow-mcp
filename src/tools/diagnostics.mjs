import { discoverProjects } from '../discovery.mjs';
import { getFrontmatter } from '../caches/frontmatter-cache.mjs';
import { parsePipelineLog } from '../parsers/pipeline-log.mjs';
import { getMcpConfig } from '../health/thresholds.mjs';
import { buildGhostMarkerMatcher } from '../health/ghost-marker.mjs';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { mcpCwd } from '../lib/project-root.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

// FIX-001: excerpt строился без ограничения длины, и в него попадали строки
// AI_APICallError по 232 КБ — ответ list_ghost_executions разрастался до 5.5 МБ.
// Режем по строке и по записи целиком.
const MAX_EXCERPT_LINE_CHARS = 500;
const MAX_EXCERPT_CHARS = 4000;

/**
 * Обрезает строку excerpt'а, помечая, сколько символов отброшено.
 * @param {string} line
 * @returns {string}
 */
function capExcerptLine(line) {
  if (line.length <= MAX_EXCERPT_LINE_CHARS) return line;
  const dropped = line.length - MAX_EXCERPT_LINE_CHARS;
  return `${line.slice(0, MAX_EXCERPT_LINE_CHARS)} … [обрезано ${dropped} симв.]`;
}

/**
 * Собирает excerpt вокруг строки с маркером с ограничением по размеру.
 * @param {string[]} lines
 * @param {number} index - строка с маркером
 * @returns {string}
 */
function buildCappedExcerpt(lines, index) {
  const startIdx = Math.max(0, index - 5);
  const endIdx = Math.min(lines.length - 1, index + 5);
  const capped = lines.slice(startIdx, endIdx + 1).map(capExcerptLine);

  let excerpt = capped.join('\n');
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    const dropped = excerpt.length - MAX_EXCERPT_CHARS;
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_CHARS)} … [обрезано ${dropped} симв.]`;
  }
  return excerpt;
}

/**
 * list_blocked_tickets - Aggregate blocked tickets from all or one project
 * @param {Object} params - Parameters
 * @param {string} [params.project] - Optional project path/name to filter by
 * @returns {Promise<Array<{project: string, id: string, title: string, blocked_reason: string, age_sec: number, ticket_path: string}>>}
 */
export async function list_blocked_tickets({ project }) {
  const cwd = mcpCwd();
  const projectsToScan = [];

  if (project) {
    // Single project mode - resolve project root
    const resolved = path.resolve(cwd, project);
    const workflowDir = path.join(resolved, '.workflow');
    if (!fs.existsSync(workflowDir)) {
      throw new Error(`Project not found or not a workflow project: ${project}`);
    }
    projectsToScan.push({ name: path.basename(resolved), path: resolved });
  } else {
    // All projects mode - discover projects
    const discovered = discoverProjects(cwd);
    projectsToScan.push(...discovered);
  }

  const result = [];

  for (const proj of projectsToScan) {
    const ticketsDir = path.join(proj.path, '.workflow', 'tickets');
    const blockedDir = path.join(ticketsDir, 'blocked');

    if (!fs.existsSync(blockedDir)) {
      // No blocked directory for this project - return empty result for this project
      continue;
    }

    const files = fs.readdirSync(blockedDir).filter(f => isWorkflowDoc(f));

    for (const file of files) {
      const filePath = path.join(blockedDir, file);
      try {
        const { frontmatter } = getFrontmatter(filePath);

        const ticketId = frontmatter.id || file.replace('.md', '');
        const title = frontmatter.title || '';
        const updatedAt = frontmatter.updated_at || frontmatter.created_at || '';

        // Calculate age_sec
        let ageSec = 0;
        if (updatedAt) {
          const updatedDate = new Date(updatedAt);
          const now = new Date();
          if (!isNaN(updatedDate.getTime())) {
            ageSec = Math.floor((now - updatedDate) / 1000);
          }
        }

        // blocked_reason from last event in frontmatter
        let blockedReason = '';
        if (frontmatter.events && Array.isArray(frontmatter.events) && frontmatter.events.length > 0) {
          const lastEvent = frontmatter.events[frontmatter.events.length - 1];
          blockedReason = lastEvent.reason || lastEvent.message || lastEvent.note || '';
        }
        if (!blockedReason && frontmatter.blocked_reason) {
          blockedReason = frontmatter.blocked_reason;
        }

        result.push({
          project: proj.name,
          id: ticketId,
          title,
          blocked_reason: blockedReason,
          age_sec: ageSec,
          ticket_path: filePath
        });
      } catch (e) {
        // Skip malformed frontmatter - emit warning to stderr
        console.warn(`Warning: Skipping malformed ticket file ${filePath}: ${e.message}`);
        continue;
      }
    }
  }

  // Sort by age_sec DESC (oldest first)
  result.sort((a, b) => b.age_sec - a.age_sec);

  return result;
}

/**
 * MCP Tool: list_blocked_tickets
 */
export default {
  name: 'list_blocked_tickets',
  description: 'List blocked tickets across all projects or filter by a single project',
  inputSchema: z.object({
    project: z.string().optional().describe('Optional: filter by specific project name or path')
  }),
  async execute(args) {
    try {
      const tickets = await list_blocked_tickets({ project: args.project });
      return {
        project_filter: args.project || 'all',
        count: tickets.length,
        tickets: tickets.map(t => ({
          project: t.project,
          id: t.id,
          title: t.title,
          blocked_reason: t.blocked_reason,
          age_sec: t.age_sec,
          ticket_path: t.ticket_path
        }))
      };
    } catch (err) {
      return {
        error: err.message
      };
    }
  }
};

/**
 * list_ghost_executions - Scan pipeline logs for ghost execution markers
 * @param {Object} params - Parameters
 * @param {string} [params.project] - Optional project path/name to filter by
 * @param {string} [params.since] - Optional ISO date to filter results (detected_at >= since)
 * @returns {Promise<Array<{project: string, run_id: string, step_number: number, ticket_id: string, log_excerpt: string, detected_at: string}>>}
 */
async function listGhostExecutionsImpl({ project, since }) {
  const cwd = mcpCwd();
  const projectsToScan = [];

  if (project) {
    const resolved = path.resolve(cwd, project);
    const workflowDir = path.join(resolved, '.workflow');
    if (!fs.existsSync(workflowDir)) {
      throw new Error(`Project not found or not a workflow project: ${project}`);
    }
    projectsToScan.push({ name: path.basename(resolved), path: resolved });
  } else {
    const discovered = discoverProjects(cwd);
    projectsToScan.push(...discovered);
  }

  const sinceDate = since ? new Date(since) : null;
  const results = [];
  const MAX_RESULTS = 100;
  let truncated = false;

  for (const proj of projectsToScan) {
    const logsDir = path.join(proj.path, '.workflow', 'logs');
    if (!fs.existsSync(logsDir)) {
      continue;
    }

    // Get all pipeline_*.log files sorted by mtime descending (newest first)
    let logFiles;
    try {
      logFiles = fs.readdirSync(logsDir)
        .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'))
        .map(f => path.join(logsDir, f))
        .map(filePath => ({
          path: filePath,
          name: path.basename(filePath),
          mtime: fs.statSync(filePath).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      continue;
    }

    if (logFiles.length === 0) {
      continue;
    }

    // FIX-001: маркер ищется как структурный обособленный токен, а не подстрокой.
    const matcher = buildGhostMarkerMatcher(getMcpConfig(proj.path)?.ghost_execution_log_marker);

    for (const logFile of logFiles) {
      // mtime-based filter: if since provided and log mtime < since, skip older logs
      if (sinceDate && logFile.mtime < sinceDate) {
        console.error('DEBUG: Skipping log file due to mtime filter:', logFile.name, 
                    'mtime:', logFile.mtime, 'since:', sinceDate);
        continue;
      }

      let logContent;
      try {
        logContent = fs.readFileSync(logFile.path, 'utf8');
      } catch (e) {
        continue;
      }

      if (!logContent || logContent.trim().length === 0) {
        continue;
      }

      const lines = logContent.split('\n');
      
      // Parse the log once to get step info for all markers
      const steps = parsePipelineLog(logContent);
      
      // Дедуп: совпадения ближе 5 строк друг к другу дают один и тот же
      // excerpt (±5 строк) и раньше плодили дубли, разнесённые по соседним шагам.
      let lastMatchIdx = -Infinity;

      // Scan for marker lines
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) {
          continue;
        }

        if (i - lastMatchIdx <= 5) {
          continue;
        }
        lastMatchIdx = i;

        // Extract detected_at from the timestamp of the log line that contains the marker
        let detectedAt = new Date().toISOString();
        
        // Look for timestamp in the current line or nearby lines
        for (let lineIdx = Math.max(0, i - 2); lineIdx <= Math.min(lines.length - 1, i + 2); lineIdx++) {
          const timestampMatch = lines[lineIdx].match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
          if (timestampMatch) {
            try {
              // Parse the timestamp and ensure it's treated as UTC
              const localDate = new Date(timestampMatch[1].replace(' ', 'T'));
              detectedAt = localDate.toISOString();
              console.error('DEBUG: Found timestamp in line', lineIdx, ':', timestampMatch[1], '->', detectedAt);
              break; // Use the first timestamp we find
            } catch (e) {
              // Continue to next line
            }
          }
        }

        // Apply since filter on detected_at (only if file mtime filter didn't catch it)
        // Note: file mtime filter already skipped files older than sinceDate
        // This filter is for markers within files that might be newer than the file
        if (sinceDate && new Date(detectedAt) < sinceDate) {
          console.error('DEBUG: Skipping marker due to detected_at filter:', detectedAt, 'since:', sinceDate);
          continue;
        }

        // Build log_excerpt: ±5 lines around marker, с ограничением размера
        const logExcerpt = buildCappedExcerpt(lines, i);

        // Find step that covers this line number using pre-parsed steps
        // We need to determine which step the marker line belongs to
        let stepNumber = null;
        let ticketId = '';
        
        // Simple approach: find the most recent "Step N" marker that appears before the marker line
        let lastStepBeforeMarker = 0;
        for (let lineIdx = 0; lineIdx <= i; lineIdx++) {
          const line = lines[lineIdx];
          const sanitized = line.replace(/\x1b\[[0-9;]*m/g, '');
          
          // Detect "Step N" marker
          const stepMatch = sanitized.match(/\[PipelineRunner\] Step (\d+)/);
          if (stepMatch) {
            lastStepBeforeMarker = parseInt(stepMatch[1], 10);
          }
        }
        
        // If we found a step before the marker, use it
        if (lastStepBeforeMarker > 0) {
          stepNumber = lastStepBeforeMarker;
        }

        // Find ticket_id from steps context
        const matchingStep = steps.find(s => s.step_number === stepNumber);
        if (matchingStep && matchingStep.context) {
          ticketId = matchingStep.context.ticket_id || matchingStep.context.ticketId || '';
        }

        // Extract run_id from log filename: pipeline_<run_id>.log
        const runIdMatch = logFile.name.match(/pipeline_(.+?)\.log$/);
        const runId = runIdMatch ? runIdMatch[1] : 'unknown';

        results.push({
          project: proj.name,
          run_id: runId,
          step_number: stepNumber || 0,
          ticket_id: ticketId,
          log_excerpt: logExcerpt,
          detected_at: detectedAt
        });

        if (results.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    project_filter: project || 'all',
    count: results.length,
    truncated,
    executions: results
  };
}

/**
 * MCP Tool: list_ghost_executions
 */
export const list_ghost_executions = {
  name: 'list_ghost_executions',
  description: 'Scan pipeline logs for ghost execution markers across projects',
  inputSchema: z.object({
    project: z.string().optional().describe('Optional: filter by specific project name or path'),
    since: z.string().optional().describe('Optional: ISO 8601 date to filter results (only entries detected at or after this date)')
  }),
  // Обёртку в content[] делает сам сервер (см. registerTools в server.mjs).
  // Своя такая же здесь давала клиенту данные на уровень глубже, чем у всех
  // остальных tools; ошибку сервер тоже ловит и форматирует тем же текстом.
  async execute(args) {
    return listGhostExecutionsImpl({
      project: args.project,
      since: args.since
    });
  }
};
