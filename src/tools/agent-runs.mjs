import { z } from 'zod';
import {
  RUNS_LOG, readRunEvents, statsTable, activeBans, recordUnban,
} from 'workflow-ai/lib/agent-runs.mjs';
import { resolveProjectRoot } from '../lib/project-root.mjs';

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
 * постоянный запрет пары «модель + тип тикета», без него — временный запрет модели.
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
 * @param {string} [params.ticket_type] - Тип тикета постоянного запрета
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
  description: 'Lift a model ban by appending an unban event to the agent runs journal: with ticket_type — the permanent ban of the model for that ticket type, without it — the temporary crash ban of the model. No such ban — NO_BAN, nothing is written',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    model: z.string().describe('Banned model, as in get_model_stats'),
    ticket_type: z.string().min(1).optional().describe('Ticket type of the permanent ban; omit for the temporary crash ban'),
    reason: z.string().describe('Why the ban is lifted (kept in the journal); empty — BAD_INPUT'),
  }),
  async execute(args) {
    return unban_model(args);
  },
};
