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
      // parent_plan — путь от каталога .workflow/ (`plans/current/PLAN-001.md`, так
      // пишут декомпозиция и createTicket) или от корня проекта (`.workflow/plans/…`).
      const ref = String(ticketFrontmatter.parent_plan);
      const fromRoot = path.join(projectRoot, ref);
      const planPath = fs.existsSync(fromRoot) ? fromRoot : path.join(projectRoot, '.workflow', ref);
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

// Те же заголовки, что у verify-artifacts workflow-ai: первая такая секция — результат тикета.
// [ \t] вместо \s: иначе совпадение захватывает перевод строки, и секция начинается строкой ниже.
const RESULT_HEADING = /^##[ \t]*(Результат выполнения|Результат|Result)[ \t]*$/m;
const DOD_HEADING = /^##[ \t]*(?:Критерии готовности|Definition of Done)(?:[ \t]*\([^)]*\))?[ \t]*$/m;

function sectionBounds(body, heading) {
  const match = heading.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextH2 = body.indexOf('\n## ', start);
  return { start, end: nextH2 === -1 ? body.length : nextH2 };
}

/** result_body с собственным заголовком результата — без него, иначе секция в секции. */
function stripResultHeading(resultBody) {
  return resultBody.trim().replace(/^##[ \t]*(Результат выполнения|Результат|Result)[ \t]*\n+/, '');
}

/** Заменяет содержимое секции результата; нет секции — добавляет её в конец. */
function fillResultSection(body, content) {
  const bounds = sectionBounds(body, RESULT_HEADING);
  if (!bounds) return `${body.trimEnd()}\n\n## Результат выполнения\n\n${content}`;
  return `${body.slice(0, bounds.start)}\n\n${content}${body.slice(bounds.end)}`;
}

// Пункт DoD — строка списка с чекбоксом: «- [ ]», «* [ ]», «+ [ ]», «1. [ ]», «1) [ ]».
// verify-artifacts считает любой «[ ]» и «[x]» секции; `[ ]` в середине текста пункта
// (например, пример разметки в обратных кавычках) пунктом здесь не считается.
const DOD_ITEM = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gm;
// Строки-заголовки DoD внутри текста результата: см. demoteDoDHeading.
const DOD_HEADING_LINES = new RegExp(DOD_HEADING.source, 'gm');

/**
 * Допустимые переходы между колонками — копия VALID_TRANSITIONS из workflow-ai
 * (src/lib/operations/tickets.mjs): оттуда она не экспортируется. Расхождение ловит тест
 * «transition table»: он прогоняет все пары через настоящий moveTicket.
 */
export const TICKET_TRANSITIONS = {
  backlog: ['ready', 'blocked', 'done'],
  ready: ['in-progress', 'review', 'backlog'],
  'in-progress': ['done', 'blocked', 'review'],
  blocked: ['ready'],
  review: ['done', 'ready', 'in-progress', 'blocked'],
  done: ['ready', 'blocked', 'archive'],
  archive: ['backlog']
};

/**
 * Статус для тикета человека, сданного не до конца, вместо review/done: достижимый из
 * текущего. in-progress не предлагаем: pick-next-task не различает типы, и человеческий
 * тикет там пайплайн отдаёт исполнителю-агенту (или в move-to-review, минуя DoD).
 */
function parkingStatuses(currentStatus) {
  return (TICKET_TRANSITIONS[currentStatus] ?? []).filter(status => status !== 'review' && status !== 'done' && status !== 'in-progress');
}

/**
 * Переход проверяем до lock'а: недопустимый move_ticket отказал бы уже после захвата
 * и отката файла. Сообщение начинается так же, как у move_ticket.
 */
function assertTransition(ticketId, from, to) {
  const allowed = TICKET_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return;
  const err = new Error(
    `Invalid transition for ${ticketId}: ${from} → ${to}. From ${from} the ticket can move to: ${allowed.join(', ')}`
    + (allowed.includes('in-progress') ? ' (not in-progress: the pipeline takes a human ticket there for agent work)' : '')
  );
  err.code = 'INVALID_TRANSITION';
  throw err;
}

/**
 * Заголовок DoD внутри текста результата (decision или result_body) — в H3. verify-artifacts и
 * confirmDoDItems берут первую секцию DoD тикета; секция результата стоит в шаблоне ниже DoD,
 * но не во всех тикетах, и вставленный выше настоящего заголовок перехватывал бы и отметки, и
 * проверку: пункты из результата вместо пунктов DoD.
 */
function demoteDoDHeading(text) {
  return text.replace(DOD_HEADING_LINES, line => `#${line}`);
}

/** Сжать текст для сравнения пункта DoD со ссылкой: регистр и пробелы не различаем. */
function normalizeDoDText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Пункты-чекбоксы секции DoD в порядке появления; null — в тикете нет секции DoD. */
function listDoDItems(body) {
  const bounds = sectionBounds(body, DOD_HEADING);
  if (!bounds) return null;
  const section = body.slice(bounds.start, bounds.end);
  const items = [];
  for (const match of section.matchAll(DOD_ITEM)) {
    const textStart = match.index + match[0].length;
    const lineEnd = section.indexOf('\n', textStart);
    items.push({
      // позиция символа внутри скобок — туда ставится «x»
      markAt: bounds.start + match.index + match[1].length + 1,
      checked: match[2] !== ' ',
      text: section.slice(textStart, lineEnd === -1 ? undefined : lineEnd).trim()
    });
  }
  return items;
}

function describeDoDItems(items) {
  return items
    .map((item, i) => `${i + 1}) ${summarizeDecision(item.text, 80)}`)
    .join('; ');
}

/**
 * Пункт DoD по ссылке: число (или строка из цифр) — номер пункта от 1, иначе текст —
 * точный либо единственное вхождение подстроки. Не нашёл или не единственный — ошибка:
 * молча пропущенная ссылка оставила бы пункт неотмеченным, а человека — в уверенности,
 * что он отмечен.
 */
function findDoDItem(ref, items, ticketId) {
  const list = `DoD items of ${ticketId}: ${describeDoDItems(items)}`;
  const asNumber = typeof ref === 'number' ? ref : (/^\s*\d+\s*$/.test(ref) ? Number(ref) : null);
  if (asNumber !== null) {
    if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > items.length) {
      throw new Error(`DOD_ITEM_NOT_FOUND: no DoD item number ${ref}. ${items.length ? list : `${ticketId} has no DoD items`}`);
    }
    return asNumber - 1;
  }
  const wanted = normalizeDoDText(String(ref));
  const exact = items.flatMap((item, i) => (normalizeDoDText(item.text) === wanted ? [i] : []));
  const found = exact.length > 0 ? exact : items.flatMap((item, i) => (normalizeDoDText(item.text).includes(wanted) ? [i] : []));
  if (found.length === 0) {
    throw new Error(`DOD_ITEM_NOT_FOUND: no DoD item matches "${ref}". ${items.length ? list : `${ticketId} has no DoD items`}`);
  }
  if (found.length > 1) {
    throw new Error(`DOD_ITEM_AMBIGUOUS: "${ref}" matches ${found.length} DoD items (${found.map(i => i + 1).join(', ')}) — pass item numbers. ${list}`);
  }
  return found[0];
}

/**
 * Отмечает пункты DoD при сдаче тикета человека.
 *
 * Без `dod_confirmed` — прежнее поведение: при review/done отмечаются все пункты, при
 * остальных статусах ничего. Так продолжают работать вызовы, не знающие о параметре.
 *
 * С `dod_confirmed` отмечаются только перечисленные пункты, в любом статусе. Безусловная
 * отметка закрыла ListeningGlass HUMAN-002 (2026-09-30) с обоими пунктами «записан результат
 * по каждому сайту и сценарию» отмеченными, хотя в решении сказано «youtube-nocookie и
 * 70-минутный сценарий не проверены» (кто поставил те отметки, код или вручную до вызова,
 * не установлено). При review/done каждый пункт должен быть отмечен или подтверждён:
 * иначе — `DOD_NOT_CONFIRMED`, тикет остаётся на месте. Недоделанное сдают другим статусом
 * из достижимых (parkingStatuses: из ready — backlog, blocked оттуда недоступен):
 * подтверждённые пункты отмечаются и там, остальные остаются
 * неотмеченными. `[]` — «ничего не подтверждено»: для review/done это тоже отказ.
 *
 * @param {string} body
 * @param {Array<number|string>|undefined} confirmed
 * @param {string} nextStatus
 * @param {string} ticketId
 * @param {string} currentStatus - колонка тикета сейчас: из неё выбираются статусы для подсказки
 * @returns {{body: string, unticked: string[]} | null} null — в тикете нет DoD;
 *   `unticked` — неотмеченные пункты после вызова, только при заданном `dod_confirmed`
 */
function confirmDoDItems(body, confirmed, nextStatus, ticketId, currentStatus) {
  if (confirmed === null) confirmed = undefined;
  if (confirmed !== undefined && !Array.isArray(confirmed)) {
    throw new Error('DOD_CONFIRMED_INVALID: dod_confirmed must be an array of DoD item numbers or texts');
  }
  // Пустая ссылка после нормализации — подстрока любого пункта: подтвердила бы единственный
  // пункт DoD, ничего не назвав.
  if (confirmed !== undefined && confirmed.some(ref => !(typeof ref === 'number' || (typeof ref === 'string' && normalizeDoDText(ref) !== '')))) {
    throw new Error('DOD_CONFIRMED_INVALID: every dod_confirmed entry must be a DoD item number or non-empty item text');
  }
  const items = listDoDItems(body);
  if (!items) {
    if (confirmed && confirmed.length > 0) {
      throw new Error(`DOD_ITEM_NOT_FOUND: ${ticketId} has no DoD section, but dod_confirmed lists ${confirmed.length} item(s)`);
    }
    return null;
  }

  const finishing = nextStatus === 'review' || nextStatus === 'done';
  let toTick;
  if (confirmed === undefined) {
    toTick = new Set(finishing ? items.keys() : []);
  } else {
    toTick = new Set(confirmed.map(ref => findDoDItem(ref, items, ticketId)));
    const left = items.filter((item, i) => !item.checked && !toTick.has(i));
    if (finishing && left.length > 0) {
      throw new Error(
        `DOD_NOT_CONFIRMED: moving ${ticketId} to ${nextStatus} needs every DoD item ticked, but ${left.length} item(s) are neither ticked nor in dod_confirmed. `
        + 'Pass them in dod_confirmed if the human confirmed them (numbers from 1 or item text); '
        + `if the work is not finished, use another next_status reachable from ${currentStatus} (${parkingStatuses(currentStatus).join(', ')}) and say what is left in result_body. `
        + `Unconfirmed: ${left.map(item => `"${summarizeDecision(item.text, 80)}"`).join('; ')}. `
        + `DoD items: ${describeDoDItems(items)}`
      );
    }
  }

  let newBody = body;
  for (const i of [...toTick].filter(i => !items[i].checked).sort((a, b) => b - a)) {
    newBody = `${newBody.slice(0, items[i].markAt)}x${newBody.slice(items[i].markAt + 1)}`;
  }
  return {
    body: newBody,
    unticked: confirmed === undefined
      ? []
      : items.filter((item, i) => !item.checked && !toTick.has(i)).map(item => item.text)
  };
}

const DECISION_SUMMARY_MAX = 100;

/**
 * Краткая запись решения для review_log: не длиннее `max` символов вместе с «…», обрыв —
 * на границе слова и по кодовым точкам, не по единицам UTF-16. `substring(0, 100)` резал
 * «динамически» и «останав» посреди слова (ListeningGlass HUMAN-001 и HUMAN-002, 2026-09-30),
 * а на эмодзи на границе оставил бы половину суррогатной пары. Полный текст лежит в секции
 * результата тикета.
 */
function summarizeDecision(decision, max = DECISION_SUMMARY_MAX) {
  const chars = Array.from(decision.trim());
  if (chars.length <= max) return chars.join('');
  const room = max - 1; // место под «…»
  let cut = room;
  // Окно кончается на границе слова, если следом пробел; иначе отступаем к последнему
  // пробелу. Одно слово длиннее окна режем по кодовой точке.
  if (!/\s/.test(chars[room])) {
    let space = room - 1;
    while (space > 0 && !/\s/.test(chars[space])) space--;
    if (space > 0) cut = space;
  }
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}

/**
 * Resolve a human ticket by filling its result section and moving it to next status
 * @param {Object} params - Parameters
 * @param {string} params.project - Project path or name
 * @param {string} params.ticket_id - Ticket ID to resolve
 * @param {Object} params.decision - Decision information
 * @param {string} params.result_body - Result body content
 * @param {string} [params.next_status] - Next status (defaults to 'done')
 * @param {boolean} [params.strict] - Enable strict validation (overrides config)
 * @param {Array<number|string>} [params.dod_confirmed] - DoD items the human confirmed (numbers from 1 or item text).
 *   Omitted — previous behavior: review/done ticks all items. Given — only they are ticked, and review/done
 *   with an item left neither ticked nor listed is refused (DOD_NOT_CONFIRMED)
 * @returns {Promise<{id: string, new_status: string, path: string, dod_unticked?: string[]}>} `dod_unticked` — only with dod_confirmed
 */
export async function resolve_human_ticket({ project, ticket_id, decision, result_body, next_status = 'done', strict, dod_confirmed }) {
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

  // Подтверждение DoD проверяем до захвата lock'а: отказ не должен выдёргивать тикет из каталога.
  confirmDoDItems(ticketBody, dod_confirmed, next_status, ticket_id, currentStatus);

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
  
  // Недопустимый переход — отказ до lock'а, а не откат после него.
  assertTransition(ticket_id, currentStatus, next_status);

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

    // Результат — в штатную секцию шаблона, а не новой секцией в конце: verify-artifacts
    // читает первую «## Результат выполнения», и пустой шаблон перед дописанной секцией
    // давал result_filled=false и 0% DoD (ListeningGlass HUMAN-001, 2026-09-30).
    const isoDate = new Date().toISOString();
    const resultContent = demoteDoDHeading(`**Решение:** ${decision}\n**Дата:** ${isoDate}\n**Исполнитель:** human\n\n${stripResultHeading(result_body)}\n`);
    // DoD — по телу под lock'ом: оно могло измениться между поиском тикета и захватом. Пункты
    // ищем до вставки результата, как и проверка выше, — в одном и том же теле тикета.
    // Отмечаются только подтверждённые пункты (см. confirmDoDItems).
    const dod = confirmDoDItems(body, dod_confirmed, next_status, ticket_id, currentStatus);
    const newBody = fillResultSection(dod ? dod.body : body, resultContent);

    // Update frontmatter with review_log entry
    if (!frontmatter.review_log) {
      frontmatter.review_log = [];
    }
    frontmatter.review_log.push({
      date: isoDate,
      action: 'resolved',
      decision: summarizeDecision(decision) // краткая запись; полный текст — в секции результата
    });

    // Serialize the updated content
    const newContent = serializeFrontmatter(frontmatter) + newBody;

    // Write the updated ticket back to original path (from lock)
    fs.writeFileSync(ticketPath, newContent);
    
    // Move the ticket to next status
    const moved = await move_ticket({ project, ticket_id, target: next_status });

    // Clean up lock file
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }

    return {
      id: ticket_id,
      new_status: next_status,
      path: moved?.path ?? ticketPath,
      // Неотмеченные пункты видны в ответе: человек не должен узнавать о них из verify-artifacts.
      ...(dod && dod.unticked.length > 0 && { dod_unticked: dod.unticked })
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
  description: 'Get extended context for a HUMAN ticket: the ticket itself, its parent plan, dependencies, related reports and pipeline steps. '
    + 'A product-code change found while working a human ticket goes into a separate agent ticket (create_ticket), not into the human one: the human ticket keeps only the human result',
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
  description: 'Resolve a HUMAN ticket: fill its result section, tick its DoD items, and move the ticket to the next status. '
    + 'Without dod_confirmed, moving to review or done ticks every DoD item. '
    + 'Pass dod_confirmed to tick only what the human actually confirmed: then review or done is refused (DOD_NOT_CONFIRMED) while an item is neither ticked nor listed, so for work not finished or not checked use another next_status that the current status allows (the error lists them: from ready only backlog, blocked is not reachable) and say what is left in result_body. '
    + 'A product-code change found while working a human ticket goes into a separate agent ticket (create_ticket), not into this one: keep only the human result here.',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    ticket_id: z.string().describe('Ticket ID (e.g. HUMAN-12)'),
    decision: z.string().describe('Decision recorded in the result section'),
    result_body: z.string().describe('Result body written into the ticket result section'),
    dod_confirmed: z.array(z.union([z.number().int().positive(), z.string().trim().min(1)])).optional().describe(
      'DoD items the human confirmed as done: 1-based item numbers in the ticket DoD section and/or item text (exact, or a substring matching one item). '
      + 'Items are the checkbox lines of that section ("- [ ]", "* [ ]", "+ [ ]", "1. [ ]"); a [ ] inside an item\'s text is not an item. '
      + 'Omit to keep the previous behavior: moving to review or done ticks all items. '
      + 'When passed, only these are ticked (in any next_status), and moving to review or done while an item is neither ticked nor listed fails with DOD_NOT_CONFIRMED; [] ticks none'
    ),
    next_status: z.enum(STATUS_DIRS).optional().describe('Target status (default: done)'),
    strict: z.boolean().optional().describe('Enable strict validation of the result, overriding human_ticket config')
  }),
  async execute(args) {
    return resolve_human_ticket(args);
  }
};
