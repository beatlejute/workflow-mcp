import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {
  RUNS_LOG, GRADES, readRunEvents, readOpenRun, statsTable, runStatsTable, activeBans, recordUnban,
} from 'workflow-ai/lib/agent-runs.mjs';
import { discoverProjects } from '../discovery.mjs';
import { mcpCwd, resolveProjectRoot } from '../lib/project-root.mjs';

/**
 * Модели агентов по журналу запусков проекта `.workflow/metrics/agent-runs.jsonl`
 * (workflow-ai 1.14.0, PLAN-003 workflowAi): таблица по модели и типу тикета и
 * снятие запрета. Журнал пишет раннер, градации и запреты вычисляет модуль
 * workflow-ai при чтении — здесь только чтение и одно событие `unban`, своих правил
 * нет: иначе сервер и раннер разошлись бы в том, какая модель под запретом.
 */

function journalError(err) {
  const wrapped = new Error(`Agent runs journal is not readable: ${err.message}`);
  wrapped.code = 'JOURNAL_UNREADABLE';
  return wrapped;
}

// Модель null («модель неизвестна» — kilo-запуск с непрочитанной моделью) — в конце.
function byModelAndType(a, b) {
  if (a.model !== b.model) {
    if (a.model === null) return 1;
    if (b.model === null) return -1;
    return a.model.localeCompare(b.model);
  }
  return String(a.ticket_type ?? '').localeCompare(String(b.ticket_type ?? ''));
}

/**
 * get_model_stats — таблица запусков исполнителя по модели и типу тикета и действующие
 * запреты.
 * @param {Object} params
 * @param {string} params.project - Путь к проекту или имя
 * @param {string} [params.model] - Только эта модель
 * @param {string} [params.ticket_type] - Только этот тип тикета
 * @returns {Promise<{journal: string, events: number, executor_runs: number, rows: Array, bans: {permanent: Array, crash: Array}}>}
 */
export async function get_model_stats({ project, model, ticket_type }) {
  const projectRoot = resolveProjectRoot(project);
  let events;
  try {
    events = readRunEvents(projectRoot);
  } catch (err) {
    throw journalError(err);
  }
  const now = Date.now();
  const matches = (row) => (model === undefined || row.model === model)
    && (ticket_type === undefined || row.ticket_type === ticket_type);
  const rows = statsTable(events, now).filter(matches).sort(byModelAndType);
  const bans = activeBans(events, now);
  return {
    journal: RUNS_LOG,
    events: events.length,
    executor_runs: rows.reduce((sum, row) => sum + row.runs, 0),
    rows,
    bans: {
      permanent: bans.permanent.filter(matches),
      // Временный запрет — на модель целиком, типа тикета у него нет.
      crash: bans.crash.filter((ban) => model === undefined || ban.model === model),
    },
  };
}

/**
 * unban_model — снятие запрета человеком: событие `unban` в журнале. С `ticket_type` —
 * постоянный запрет пары «модель + тип тикета», без него — временные запреты модели: за
 * сбой и за серию «модель недоступна» (серия считается заново с этого unban).
 * Запрета нет — NO_BAN, строка не пишется.
 *
 * После записи журнал перечитывается: запрет, который остался действовать, — отказ
 * UNBAN_NOT_APPLIED. Так бывает, если последняя строка журнала оборвана (раннер снят
 * посреди записи, ручная правка без перевода строки): событие склеивается с ней, и
 * читатель пропускает склеенную строку. Журнал не перечитался — ответ `remaining: null`
 * с `remaining_error`: снятие уже записано, и отказ ввёл бы в заблуждение.
 * @param {Object} params
 * @param {string} params.project - Путь к проекту или имя
 * @param {string} params.model - Модель, как в таблице get_model_stats
 * @param {string} [params.ticket_type] - Тип тикета постоянного запрета; без него — временные запреты модели
 * @param {string} params.reason - Почему снят запрет
 * @returns {Promise<{ok: true, event: Object, remaining: {permanent: Array, crash: Array}|null, remaining_error?: string}>}
 */
export async function unban_model({ project, model, ticket_type, reason }) {
  const projectRoot = resolveProjectRoot(project);
  const result = recordUnban(projectRoot, { model, ticket_type: ticket_type ?? null, reason });
  if (!result.ok) {
    const err = new Error(result.error);
    err.code = result.code === 'READ_FAILED' ? 'JOURNAL_UNREADABLE' : result.code;
    throw err;
  }
  // Что ещё действует для этой модели — чтобы снявший видел итог без второго вызова.
  let bans;
  try {
    bans = activeBans(readRunEvents(projectRoot), Date.now());
  } catch (err) {
    return { ok: true, event: result.event, remaining: null, remaining_error: err.message };
  }
  const remaining = {
    permanent: bans.permanent.filter((ban) => ban.model === model),
    crash: bans.crash.filter((ban) => ban.model === model),
  };
  const stillBanned = ticket_type
    ? remaining.permanent.some((ban) => ban.ticket_type === ticket_type)
    : remaining.crash.length > 0;
  if (stillBanned) {
    const err = new Error('The unban event was written but the ban is still active: the journal likely ends with a broken line that the event was glued to. Check the last lines of .workflow/metrics/agent-runs.jsonl');
    err.code = 'UNBAN_NOT_APPLIED';
    throw err;
  }
  return { ok: true, event: result.event, remaining };
}

// GRADES из workflow-ai задаёт стабильный набор колонок executor outcomes.
const PROJECT_CONCURRENCY = 5;

function parseUtcOffset(value) {
  if (value === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const total = hours * 60 + minutes;
  return match[1] === '-' ? -total : total;
}

function reportRange(dateFrom, dateTo, utcOffset) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(dateFrom) || !datePattern.test(dateTo)) {
    return { error: 'date_from and date_to must be calendar dates in YYYY-MM-DD format' };
  }
  const offsetMinutes = parseUtcOffset(utcOffset);
  if (offsetMinutes === null) {
    return { error: 'utc_offset must be Z or a fixed offset such as +05:00 (maximum ±14:00)' };
  }
  const startCalendar = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const endCalendar = Date.parse(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(startCalendar) || !Number.isFinite(endCalendar)
    || new Date(startCalendar).toISOString().slice(0, 10) !== dateFrom
    || new Date(endCalendar).toISOString().slice(0, 10) !== dateTo) {
    return { error: 'date_from and date_to must be real calendar dates' };
  }
  if (endCalendar < startCalendar) return { error: 'date_to must be on or after date_from' };
  const offsetMs = offsetMinutes * 60_000;
  const fromMs = startCalendar - offsetMs;
  const toExclusiveMs = endCalendar + 86_400_000 - offsetMs;
  return {
    fromMs,
    toExclusiveMs,
    utc: {
      from_inclusive: new Date(fromMs).toISOString(),
      to_exclusive: new Date(toExclusiveMs).toISOString(),
    },
  };
}

function normalizedProjectPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function selectProjects(projectRefs, cwd) {
  try {
    fs.readdirSync(cwd);
  } catch (err) {
    return {
      projects: [],
      errors: [{ project: path.basename(cwd), scope: 'workspace', code: 'DISCOVERY_FAILED', message: err.message }],
    };
  }
  const discoveryErrors = [];
  const discovered = discoverProjects(cwd, {
    onError: (issue) => discoveryErrors.push({
      project: issue.project || path.basename(cwd),
      project_path: issue.project_path || null,
      path: issue.path || null,
      scope: issue.scope || 'workspace',
      kind: issue.kind || null,
      code: 'DISCOVERY_FAILED',
      message: issue.error?.message || String(issue.error),
    }),
  });
  // A broken workspace config can disable its whitelist/blacklist. Do not return
  // rows from the fallback all-project scan as if they matched the requested scope.
  if (discoveryErrors.some((error) => error.kind === 'config')) {
    return { projects: [], errors: discoveryErrors.filter((error) => error.scope !== 'project' || error.kind === 'config') };
  }
  if (projectRefs === undefined) return { projects: discovered, errors: discoveryErrors };

  const relevantDiscoveryErrors = discoveryErrors.filter((issue) => issue.scope !== 'project'
    || projectRefs.some((ref) => ref === issue.project
      || (issue.project_path && normalizedProjectPath(path.resolve(cwd, ref)) === normalizedProjectPath(issue.project_path))));
  const projects = [];
  const errors = [];
  const seen = new Set();
  for (const ref of projectRefs) {
    const byName = discovered.find((project) => project.name === ref);
    const resolvedRef = normalizedProjectPath(path.resolve(cwd, ref));
    const project = byName || discovered.find((candidate) => normalizedProjectPath(candidate.path) === resolvedRef);
    if (!project) {
      const discoveryFailure = relevantDiscoveryErrors.some((issue) => issue.scope === 'project'
        && (ref === issue.project
          || (issue.project_path && resolvedRef === normalizedProjectPath(issue.project_path))));
      if (!discoveryFailure) errors.push({ project: ref, code: 'INVALID_PROJECT', message: 'Project is not in the discovered workspace' });
      continue;
    }
    if (!seen.has(project.path)) {
      seen.add(project.path);
      projects.push(project);
    }
  }
  return { projects, errors: [...relevantDiscoveryErrors, ...errors] };
}

function emptyTotals() {
  return {
    starts: 0,
    estimated_starts: 0,
    process_ok: 0,
    process_statuses: {},
    executor_starts: 0,
    executor_graded: 0,
    executor_ungraded: 0,
    executor_grades: Object.fromEntries(GRADES.map((grade) => [grade, 0])),
    open_starts: 0,
    unplaced_starts: 0,
  };
}

function emptyModelRow(model) {
  return {
    model,
    agents: new Set(),
    projects: new Set(),
    ticket_types: new Set(),
    starts: 0,
    estimated_starts: 0,
    process_ok: 0,
    process_statuses: {},
    executor_starts: 0,
    executor_graded: 0,
    executor_ungraded: 0,
    executor_grades: Object.fromEntries(GRADES.map((grade) => [grade, 0])),
    open_starts: 0,
  };
}

function addMapCounts(target, source) {
  for (const [key, count] of Object.entries(source || {})) {
    const total = (Object.hasOwn(target, key) ? target[key] : 0) + count;
    Object.defineProperty(target, key, { value: total, enumerable: true, configurable: true, writable: true });
  }
}

function addTotals(target, source) {
  for (const field of ['starts', 'estimated_starts', 'process_ok', 'executor_starts', 'executor_graded', 'executor_ungraded', 'open_starts', 'unplaced_starts']) {
    target[field] += source[field] || 0;
  }
  addMapCounts(target.process_statuses, source.process_statuses);
  addMapCounts(target.executor_grades, source.executor_grades);
}

function addModelRow(target, source) {
  for (const field of ['agents', 'projects', 'ticket_types']) {
    for (const value of source[field] || []) target[field].add(value);
  }
  for (const field of ['starts', 'estimated_starts', 'process_ok', 'executor_starts', 'executor_graded', 'executor_ungraded', 'open_starts']) {
    target[field] += source[field] || 0;
  }
  addMapCounts(target.process_statuses, source.process_statuses);
  addMapCounts(target.executor_grades, source.executor_grades);
}

function totalsForRows(rows, unplacedStarts = 0) {
  const totals = emptyTotals();
  totals.unplaced_starts = unplacedStarts;
  for (const row of rows) {
    for (const field of ['starts', 'estimated_starts', 'process_ok', 'executor_starts', 'executor_graded', 'executor_ungraded', 'open_starts']) {
      totals[field] += row[field] || 0;
    }
    addMapCounts(totals.process_statuses, row.process_statuses);
    addMapCounts(totals.executor_grades, row.executor_grades);
  }
  return totals;
}

function sortModelRows(rows) {
  return rows.sort((a, b) => {
    if (a.model !== b.model) {
      if (a.model === null) return 1;
      if (b.model === null) return -1;
      return a.model.localeCompare(b.model);
    }
    return 0;
  }).map((row) => ({
    ...row,
    agents: [...row.agents].sort(),
    projects: [...row.projects].sort(),
    ticket_types: [...row.ticket_types].sort(),
  }));
}

async function processProjectRuns(project, range) {
  const issues = [];
  let openRun = null;
  try {
    // Read the open marker first: if the agent closes while the journal is being read,
    // either this snapshot contains the open run or the following journal read contains
    // its closed event. runStatsTable deduplicates the overlap by run_key.
    openRun = readOpenRun(project.path);
  } catch (err) {
    issues.push({ code: 'OPEN_RUN_UNREADABLE', message: err.message });
  }

  let malformedLines = 0;
  let events;
  try {
    events = readRunEvents(project.path, { onMalformedLine: () => { malformedLines += 1; } });
  } catch (err) {
    return {
      project: project.name,
      error: { code: 'JOURNAL_UNREADABLE', message: err.message },
      issues,
    };
  }
  if (malformedLines > 0) {
    issues.push({
      code: 'JOURNAL_CORRUPT_LINES',
      line_count: malformedLines,
      message: `${malformedLines} malformed event line(s) were skipped`,
    });
  }
  return {
    project: project.name,
    partial: runStatsTable(events, {
      fromMs: range.fromMs,
      toMs: range.toExclusiveMs,
      openRun,
      project: project.name,
    }),
    issues,
  };
}

/**
 * Date-window report over model launches from all discovered workflow project journals.
 * Dates are inclusive in the supplied fixed offset; the returned UTC interval is half-open.
 * Process exit statuses cover all stages; executor grades cover execute-task launches only.
 */
export async function get_agent_run_stats({
  date_from, date_to, utc_offset = '+00:00', projects, model, limit = 100, offset = 0,
} = {}) {
  const range = reportRange(date_from, date_to, utc_offset);
  if (range.error) return { error: 'INVALID_DATE_RANGE', message: range.error };
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { error: 'BAD_INPUT', message: 'limit must be an integer from 1 to 1000' };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { error: 'BAD_INPUT', message: 'offset must be a non-negative integer' };
  }

  const cwd = mcpCwd();
  let selection;
  try {
    selection = selectProjects(projects, cwd);
  } catch (err) {
    return { error: 'DISCOVERY_FAILED', message: err.message };
  }
  const projectResults = [];
  for (let i = 0; i < selection.projects.length; i += PROJECT_CONCURRENCY) {
    const batch = selection.projects.slice(i, i + PROJECT_CONCURRENCY);
    projectResults.push(...await Promise.all(batch.map((project) => processProjectRuns(project, range))));
  }

  const errors = [...selection.errors];
  const rowsByModel = new Map();
  const unplacedByModel = new Map();
  const totals = emptyTotals();
  for (const result of projectResults) {
    if (result.error) errors.push({ project: result.project, ...result.error });
    for (const issue of result.issues || []) errors.push({ project: result.project, ...issue });
    if (!result.partial) continue;
    addTotals(totals, result.partial.totals);
    totals.unplaced_starts += result.partial.unplaced_starts || 0;
    for (const item of result.partial.unplaced_starts_by_model || []) {
      unplacedByModel.set(item.model, (unplacedByModel.get(item.model) || 0) + item.starts);
    }
    for (const row of result.partial.rows) {
      const key = JSON.stringify(row.model);
      if (!rowsByModel.has(key)) rowsByModel.set(key, emptyModelRow(row.model));
      addModelRow(rowsByModel.get(key), row);
    }
  }

  let rows = sortModelRows([...rowsByModel.values()]);
  if (model !== undefined) rows = rows.filter((row) => row.model === model);
  const selectedUnplacedStarts = model === undefined ? totals.unplaced_starts : (unplacedByModel.get(model) || 0);
  const reportTotals = totalsForRows(rows, selectedUnplacedStarts);
  const unplacedStartsByModel = [...unplacedByModel]
    .map(([unplacedModel, starts]) => ({ model: unplacedModel, starts }))
    .sort((a, b) => {
      if (a.model === b.model) return 0;
      if (a.model === null) return 1;
      if (b.model === null) return -1;
      return a.model.localeCompare(b.model);
    });
  const totalRows = rows.length;
  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + page.length < totalRows ? offset + page.length : null;
  return {
    date_from,
    date_to,
    utc_offset,
    utc_interval: range.utc,
    projects: projectResults.map((result) => result.project),
    complete: errors.length === 0 && reportTotals.unplaced_starts === 0,
    errors,
    diagnostics: { unplaced_starts_by_model: unplacedStartsByModel },
    totals: reportTotals,
    total_rows: totalRows,
    limit,
    offset,
    next_offset: nextOffset,
    rows: page,
  };
}

export const get_agent_run_stats_tool = {
  name: 'get_agent_run_stats',
  description: 'Aggregate recorded model starts for an inclusive date range. Returns raw process status counts for every stage and separate executor grades (accepted, crashed, refused, stopped, throttled, empty, artifacts_failed, review_failed, pending) across discovered projects. Date offset defaults to UTC; incomplete project reads are reported.',
  inputSchema: z.object({
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive start calendar date, YYYY-MM-DD'),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive end calendar date, YYYY-MM-DD'),
    utc_offset: z.string().optional().describe('Fixed offset for date boundaries, such as +05:00 (default: +00:00)'),
    projects: z.array(z.string()).optional().describe('Project names or paths from the discovered workspace (default: all discovered projects)'),
    model: z.string().optional().describe('Only this exact model key; null/unknown models are included when omitted'),
    limit: z.number().int().min(1).max(1000).optional().describe('Maximum model rows to return (default: 100)'),
    offset: z.number().int().min(0).optional().describe('Model-row offset for pagination (default: 0)'),
  }),
  async execute(args) {
    return get_agent_run_stats(args);
  },
};

export const get_model_stats_tool = {
  name: 'get_model_stats',
  description: 'Agent model quality from the project agent runs journal: executor runs per model and ticket type by grade, artifact-check and review success rates, active permanent and temporary bans with evidence',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    model: z.string().optional().describe('Only this model (as in the rows, e.g. the key without provider for kilo agents)'),
    ticket_type: z.string().optional().describe('Only this ticket type (e.g. impl)'),
  }),
  async execute(args) {
    return get_model_stats(args);
  },
};

export const unban_model_tool = {
  name: 'unban_model',
  description: 'Lift a model ban by appending an unban event to the agent runs journal: with ticket_type — the permanent ban of the model for that ticket type, without it — the temporary bans of the model: for a crash and for a series of "model unavailable" failures (the series is counted anew from this unban). No such ban — NO_BAN, nothing is written',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    model: z.string().describe('Banned model, as in get_model_stats'),
    ticket_type: z.string().min(1).optional().describe('Ticket type of the permanent ban; omit for the temporary bans of the model (crash, "model unavailable")'),
    reason: z.string().describe('Why the ban is lifted (kept in the journal); empty — BAD_INPUT'),
  }),
  async execute(args) {
    return unban_model(args);
  },
};
