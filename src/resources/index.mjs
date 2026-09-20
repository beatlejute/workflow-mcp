/**
 * Resource registry for MCP server.
 * This module exports resources available to MCP clients.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverProjects, readConfig } from '../discovery.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { workflowAiPath } from '../lib/workflow-ai.mjs';
import { mcpCwd } from '../lib/project-root.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Global alert subscribers
// ============================================================
const alertSubscribers = new Set();
let notificationHandler = null;

export function subscribe_workflow_alerts(callback) {
  alertSubscribers.add(callback);
  return () => { alertSubscribers.delete(callback); };
}

export function setResourceNotificationHandler(handler) {
  notificationHandler = handler;
}

export function notify_workflow_alerts(alert) {
  for (const cb of alertSubscribers) {
    try { cb(alert); } catch (e) { console.error('Error in workflow alerts subscriber:', e.message); }
  }
  // Обработчик ставился сервером и не читался нигде: подписчиков у
  // `subscribe_workflow_alerts` в живом коде нет, а `resources/updated` для
  // `workflow://alerts` не уходил никогда. Без этой строки клиент узнавал бы
  // про алерт, только если сам решит перечитать ресурс.
  if (notificationHandler) {
    try { notificationHandler('workflow://alerts'); } catch (e) { console.error('Error notifying workflow://alerts update:', e.message); }
  }
}

// ============================================================
// Pipeline-state: cache, watchers, coalescing, subscribers
// ============================================================
const pipelineStateSubscribers = new Set();
let pipelineStateNotificationHandler = null;
let pipelineStateCache = null;
let pipelineStateCoalesceTimer = null;
const pipelineStateWatchers = new Map(); // projectName -> { logsWatcher, approvalsWatcher }

function getCoalesceWindowMs(cwd) {
  const config = readConfig(cwd);
  return (config.notifications?.coalesce_window_ms ?? 200);
}

// Логика снимка состояния пайплайна живёт в `resources/pipeline-state.mjs`.
// Здесь её копия пролежала неиспользованной: семь функций, ни одного вызова.

export function startProjectWatchers(projectRoot, projectName, cwd) {
  if (pipelineStateWatchers.has(projectName)) return;
  // Следим за каталогом логов, а не за самим lock-файлом: в момент подписки
  // пайплайн обычно не запущен и файла ещё нет, а `fs.watch` по
  // несуществующему пути молча ничего не даёт. Прежняя версия подписывалась на
  // `.runner-pids`, которого не бывает никогда, — уведомления об изменении
  // состояния пайплайна не приходили клиенту вовсе.
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  const approvalsDir = path.join(projectRoot, '.workflow', 'approvals');
  const coalesceMs = getCoalesceWindowMs(cwd);
  let rw = null, aw = null;
  try {
    // Каталог создаётся `workflow init`, но он же в `.gitignore`: у свежего
    // клона до первого прогона логов нет. `fs.watch` по несуществующему пути
    // ничего не даёт и молча, поэтому каталог создаётся здесь — иначе
    // подписка до первого пайплайна остаётся глухой, ровно как раньше.
    fs.mkdirSync(logsDir, { recursive: true });
    rw = fs.watch(logsDir, (_event, filename) => {
      if (filename && !String(filename).startsWith('.pipeline.lock')) return;
      scheduleCoalesceUpdate(cwd, coalesceMs);
    });
  } catch { }
  try {
    // Та же история, что с каталогом логов, только хуже: `workflow init`
    // `approvals` вообще не создаёт, раннер делает его лениво при первом
    // manual-gate, а `approve_step` о своих записях не уведомляет. Подписка,
    // поставленная до первого гейта проекта, иначе никогда не узнала бы про
    // `awaiting_approval` и перевод в `paused`.
    fs.mkdirSync(approvalsDir, { recursive: true });
    aw = fs.watch(approvalsDir, { recursive: true }, () => scheduleCoalesceUpdate(cwd, coalesceMs));
  } catch { }
  pipelineStateWatchers.set(projectName, { logsWatcher: rw, approvalsWatcher: aw });
}

export function stopProjectWatchers(projectName) {
  const w = pipelineStateWatchers.get(projectName);
  if (!w) return;
  try { if (w.logsWatcher) w.logsWatcher.close(); } catch { }
  try { if (w.approvalsWatcher) w.approvalsWatcher.close(); } catch { }
  pipelineStateWatchers.delete(projectName);
}

export function startAllPipelineStateWatchers(cwd) {
  for (const p of discoverProjects(cwd)) startProjectWatchers(p.path, p.name, cwd);
}

export function stopAllPipelineStateWatchers() {
  if (pipelineStateCoalesceTimer) { clearTimeout(pipelineStateCoalesceTimer); pipelineStateCoalesceTimer = null; }
  for (const [name] of pipelineStateWatchers) stopProjectWatchers(name);
}

function scheduleCoalesceUpdate(cwd, coalesceMs) {
  if (pipelineStateCoalesceTimer) { clearTimeout(pipelineStateCoalesceTimer); pipelineStateCoalesceTimer = null; }
  pipelineStateCoalesceTimer = setTimeout(async () => {
    pipelineStateCoalesceTimer = null;
    try {
      await buildPipelineStateSnapshot(cwd);
      for (const cb of pipelineStateSubscribers) { try { cb(); } catch (e) { console.error('Pipeline-state subscriber error:', e.message); } }
      if (pipelineStateNotificationHandler) {
        try { pipelineStateNotificationHandler('workflow://pipeline-state'); } catch (e) { console.error('Pipeline-state notify error:', e.message); }
      }
    } catch (e) { console.error('Coalesce update failed:', e.message); }
  }, coalesceMs);
}

async function buildPipelineStateSnapshot(cwd = mcpCwd()) {
  const absoluteCwd = path.resolve(cwd);
  const { get_workflow_pipeline_state: getState } = await import('./pipeline-state.mjs');
  pipelineStateCache = getState(absoluteCwd);
  return pipelineStateCache;
}

/**
 * Subscribe to pipeline-state updates.
 * Starts watchers on first subscriber, stops on last.
 */
export function subscribe_workflow_pipeline_state(callback) {
  pipelineStateSubscribers.add(callback);
  if (pipelineStateSubscribers.size === 1) startAllPipelineStateWatchers(mcpCwd());
  return () => {
    pipelineStateSubscribers.delete(callback);
    if (pipelineStateSubscribers.size === 0) {
      stopAllPipelineStateWatchers();
      pipelineStateCache = null;
    }
  };
}

export function setPipelineStateNotificationHandler(handler) {
  pipelineStateNotificationHandler = handler;
}

export function notify_workflow_pipeline_state() {
  const cwd = mcpCwd();
  scheduleCoalesceUpdate(cwd, getCoalesceWindowMs(cwd));
}

export function clearPipelineStateCache() {
  pipelineStateCache = null;
  if (pipelineStateCoalesceTimer) {
    clearTimeout(pipelineStateCoalesceTimer);
    pipelineStateCoalesceTimer = null;
  }
}

export async function get_workflow_pipeline_state(cwd = mcpCwd()) {
  if (pipelineStateCache === null) await buildPipelineStateSnapshot(cwd);
  return {
    uri: 'workflow://pipeline-state',
    mimeType: 'application/json',
    text: JSON.stringify(pipelineStateCache, null, 2)
  };
}

// ============================================================
// Resource registration list
// ============================================================
export function resources_list() {
  return [
    { uri: 'workflow://projects', format: 'JSON', description: 'List of registered projects with name, path, and counters' },
    { uri: 'workflow://{project}/board', format: 'JSON', description: 'Kanban board snapshot for a project: columns × tickets' },
    { uri: 'workflow://{project}/tickets/{id}', format: 'Markdown', description: 'Content of a specific ticket file' },
    { uri: 'workflow://{project}/config/pipeline', format: 'YAML', description: 'Pipeline configuration YAML', mimeType: 'application/yaml' },
    { uri: 'workflow://{project}/config/ticket-movement-rules', format: 'YAML', description: 'Ticket movement rules configuration YAML', mimeType: 'application/yaml' },
    { uri: 'workflow://skills/{skill_name}/SKILL.md', format: 'Markdown', description: 'Skill definition from the installed workflow-ai package' },
    { uri: 'workflow://templates/{type}', format: 'Markdown', description: 'Global template (ticket, plan, or report)' },
    { uri: 'workflow://alerts', format: 'JSON', description: 'Current list of active alerts from health monitoring', mimeType: 'application/json', subscribable: true },
    { uri: 'workflow://alerts/history', format: 'JSON', description: 'Historical alerts from alerts-history.jsonl with optional since parameter', mimeType: 'application/json' },
    { uri: 'workflow://human-queue', format: 'JSON', description: 'Aggregated human tickets across all projects', mimeType: 'application/json', subscribable: true },
    { uri: 'workflow://pipeline-state', format: 'JSON', description: 'Aggregated running pipeline state across all projects', mimeType: 'application/json', subscribable: true }
  ];
}

// ============================================================
// Other resource getters (original from index.mjs)
// ============================================================
export async function get_workflow_projects(cwd = mcpCwd()) {
  try {
    const projects = discoverProjects(cwd);
    return {
      uri: 'workflow://projects',
      mimeType: 'application/json',
      text: JSON.stringify(projects.map(p => ({ name: p.name, path: p.path, counters: { backlog:0,ready:0,in_progress:0,review:0,blocked:0,done:0 } })), null, 2)
    };
  } catch (error) {
    throw new Error(`Failed to list projects: ${error.message}`);
  }
}

export async function get_workflow_project_pipeline_log_latest(cwd, projectName, uri = null) {
  try {
    const { get_workflow_project_pipeline_log_latest: getLog } = await import('./pipeline-log-latest.mjs');
    const result = await getLog(cwd, projectName, uri);
    return { uri: `workflow://${projectName}/logs/pipeline/latest`, mimeType: result.mimeType, text: result.content };
  } catch (error) {
    throw new Error(`Failed to get pipeline log latest: ${error.message}`);
  }
}

export async function start_pipeline_log_watch(cwd, projectName, notifyCallback) {
  try {
    const { startWatching } = await import('./pipeline-log-latest.mjs');
    startWatching(projectName, notifyCallback, cwd);
  } catch (error) { console.error(`Failed to start watch for ${projectName}:`, error.message); }
}

export async function stop_pipeline_log_watch(projectName) {
  try {
    const { stopWatching } = await import('./pipeline-log-latest.mjs');
    stopWatching(projectName);
  } catch { }
}

export async function get_workflow_project_board(cwd = mcpCwd(), projectName) {
  try {
    const projects = discoverProjects(cwd);
    const project = projects.find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);
    const ticketsDir = path.join(project.path, '.workflow', 'tickets');
    const board = { project: projectName, columns: {} };
    const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
    for (const status of statuses) {
      board.columns[status] = [];
      const statusDir = path.join(ticketsDir, status);
      if (!fs.existsSync(statusDir)) continue;
      for (const file of fs.readdirSync(statusDir).filter(f => f.endsWith('.md'))) {
        const filePath = path.join(statusDir, file);
        try {
          const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
          board.columns[status].push({ id: frontmatter.id || file.replace('.md', ''), title: frontmatter.title, priority: frontmatter.priority, type: frontmatter.type });
        } catch (parseErr) {
          console.error(`Skipping malformed ticket ${filePath}: ${parseErr.message}`);
        }
      }
    }
    return { uri: `workflow://${projectName}/board`, mimeType: 'application/json', text: JSON.stringify(board, null, 2) };
  } catch (error) {
    throw new Error(`Failed to get board for project "${projectName}": ${error.message}`);
  }
}

export async function get_workflow_ticket(cwd = mcpCwd(), projectName, ticketId) {
  try {
    const projects = discoverProjects(cwd);
    const project = projects.find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);
    const ticketsDir = path.join(project.path, '.workflow', 'tickets');
    const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
    for (const status of statuses) {
      const filePath = path.join(ticketsDir, status, `${ticketId}.md`);
      if (fs.existsSync(filePath)) return { uri: `workflow://${projectName}/tickets/${ticketId}`, mimeType: 'text/markdown', text: fs.readFileSync(filePath, 'utf8') };
    }
    throw new Error(`Ticket "${ticketId}" not found in project "${projectName}"`);
  } catch (error) {
    throw new Error(`Failed to get ticket: ${error.message}`);
  }
}

export async function get_workflow_skill(skillName) {
  try {
    // SKILL.md берём из установленного пакета workflow-ai, а не из соседнего
    // каталога — пакет их публикует (`src/skills/*/SKILL.md` в его `files`).
    const skillPath = workflowAiPath('src', 'skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) throw new Error(`Skill "${skillName}" not found`);
    return { uri: `workflow://skills/${encodeURIComponent(skillName)}/SKILL.md`, mimeType: 'text/markdown', text: fs.readFileSync(skillPath, 'utf8') };
  } catch (error) { throw new Error(`Failed to get skill: ${error.message}`); }
}

export async function get_workflow_template(templateType) {
  try {
    const validTypes = ['ticket', 'plan', 'report'];
    if (!validTypes.includes(templateType)) throw new Error(`Invalid template type "${templateType}"`);
    // Раньше путь строился от cwd процесса — работало только когда сервер
    // запущен из корня workflow-mcp.
    const templatePath = workflowAiPath('templates', `${templateType}-template.md`);
    if (!fs.existsSync(templatePath)) throw new Error(`Template "${templateType}" not found`);
    return { uri: `workflow://templates/${templateType}`, mimeType: 'text/markdown', text: fs.readFileSync(templatePath, 'utf8') };
  } catch (error) { throw new Error(`Failed to get template: ${error.message}`); }
}

export async function get_workflow_alerts(stateDir) {
  try {
    if (!stateDir || !stateDir.dir || stateDir.mode === 'read-only') return { uri: 'workflow://alerts', mimeType: 'application/json', text: JSON.stringify([]) };
    const historyPath = path.join(stateDir.dir, 'alerts-history.jsonl');
    if (!fs.existsSync(historyPath)) return { uri: 'workflow://alerts', mimeType: 'application/json', text: JSON.stringify([]) };
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return { uri: 'workflow://alerts', mimeType: 'application/json', text: JSON.stringify([]) };
    const now = Date.now(), oneDay = 24*60*60*1000;
    const recent = new Map();
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        const t = r.detected_at ? new Date(r.detected_at).getTime() : NaN;
        if (Number.isNaN(t) || now - t > oneDay) continue;
        const fp = r._fingerprint || r.fingerprint;
        const ex = recent.get(fp);
        if (!ex || t > new Date(ex.detected_at).getTime()) recent.set(fp, r);
      } catch { continue }
    }
    const alerts = Array.from(recent.values()).sort((a,b) => new Date(b.detected_at) - new Date(a.detected_at));
    return { uri: 'workflow://alerts', mimeType: 'application/json', text: JSON.stringify(alerts, null, 2) };
  } catch (error) { throw new Error(`Failed to get alerts: ${error.message}`); }
}

export async function get_workflow_alerts_history(stateDir, since) {
  try {
    if (!stateDir || !stateDir.dir || stateDir.mode === 'read-only') return { uri: `workflow://alerts/history${since?'?since='+encodeURIComponent(since):''}`, mimeType: 'application/json', text: JSON.stringify({ data: [], meta: { warnings: ["state dir not available"] } }, null, 2) };
    const historyPath = path.join(stateDir.dir, 'alerts-history.jsonl');
    if (!fs.existsSync(historyPath)) return { uri: `workflow://alerts/history${since?'?since='+encodeURIComponent(since):''}`, mimeType: 'application/json', text: JSON.stringify({ data: [], meta: {} }, null, 2) };
    const sinceMs = since ? new Date(since).getTime() : 0;
    const results = [];
    for (const line of fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim())) {
      try {
        const rec = JSON.parse(line);
        const t = rec.detected_at ? new Date(rec.detected_at).getTime() : NaN;
        if (!since || t > sinceMs) results.push(rec);
      } catch { continue }
    }
    return { uri: `workflow://alerts/history${since?'?since='+encodeURIComponent(since):''}`, mimeType: 'application/json', text: JSON.stringify(results, null, 2) };
  } catch (error) { throw new Error(`Failed to get alerts history: ${error.message}`); }
}

// ============================================================
// Human-queue
// ============================================================
const humanQueueSubscribers = new Set();
let humanQueueNotificationHandler = null;

export function subscribe_workflow_human_queue(callback) {
  humanQueueSubscribers.add(callback);
  return () => { humanQueueSubscribers.delete(callback); };
}

export function setHumanQueueNotificationHandler(handler) {
  humanQueueNotificationHandler = handler;
}

export function notify_workflow_human_queue(update) {
  for (const cb of humanQueueSubscribers) { try { cb(update); } catch (e) { console.error('Error in human-queue subscriber:', e.message); } }
  if (humanQueueNotificationHandler) { try { humanQueueNotificationHandler('workflow://human-queue'); } catch (e) { console.error('Error sending human-queue notification:', e.message); } }
}

export async function get_workflow_human_queue(cwd = mcpCwd()) {
  try {
    const { discoverProjects } = await import('../discovery.mjs');
    const projects = discoverProjects(cwd);
    const humanTickets = [];
    for (const project of projects) {
      const ticketsDir = path.join(project.path, '.workflow', 'tickets');
      if (!fs.existsSync(ticketsDir)) continue;
      const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
      for (const status of statuses) {
        const statusDir = path.join(ticketsDir, status);
        if (!fs.existsSync(statusDir)) continue;
        for (const file of fs.readdirSync(statusDir).filter(f => f.endsWith('.md'))) {
          const filePath = path.join(statusDir, file);
          const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
          const isHuman = file.startsWith('HUMAN-') || (frontmatter && frontmatter.type === 'human');
          if (isHuman) {
            const stats = fs.statSync(filePath);
            humanTickets.push({ project: project.name, id: frontmatter.id || file.replace('.md',''), title: frontmatter.title, priority: frontmatter.priority, status, type: frontmatter.type, age_sec: Math.floor((Date.now() - stats.mtime.getTime())/1000), updated_at: stats.mtime.toISOString() });
          }
        }
      }
    }
    humanTickets.sort((a,b) => (a.priority||3) - (b.priority||3) || new Date(a.updated_at) - new Date(b.updated_at));
    return { uri: 'workflow://human-queue', mimeType: 'application/json', text: JSON.stringify(humanTickets, null, 2) };
  } catch (error) { throw new Error(`Failed to get human-queue: ${error.message}`); }
}
