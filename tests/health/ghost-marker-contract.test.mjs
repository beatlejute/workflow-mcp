/**
 * Контракт маркера призрачного выполнения между workflow-ai и workflow-mcp.
 *
 * Детекторы здесь ищут в логе пайплайна структурный токен `[GHOST-EXECUTION]`.
 * Писать его до сих пор было некому: ни раннер, ни сервер не печатали ни одной
 * такой строки, и оба детектора работали вхолостую с самого рождения —
 * `list_ghost_executions` и health-детектор не дали бы истинного срабатывания
 * ни при каком поведении пайплайна.
 *
 * Теперь строку печатает `verify-artifacts` (workflow-ai), а раннер кладёт
 * stdout стадии в лог блоком `OUTPUT`. Репозитория два, поэтому контракт
 * закреплён с обеих сторон: там — формат печати, здесь — что именно эта строка
 * в этом окружении ловится.
 *
 * Фикстуры ниже воспроизводят лог дословно, вместе с отступом в два пробела,
 * который добавляет логгер раннера внутри блока `OUTPUT`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { detectGhostExecution } from '../../src/health/detectors/ghost-execution.mjs';
import { buildGhostMarkerMatcher } from '../../src/health/ghost-marker.mjs';
import { list_ghost_executions } from '../../src/tools/diagnostics.mjs';

/** Строка ровно того вида, что печатает `verify-artifacts`. */
const GHOST_STDOUT_LINE =
  '[GHOST-EXECUTION] ticket=QA-903 reason=file_unchanged unchanged_files=src/a.mjs,src/b.mjs';

/** Тот же вывод после логгера раннера: префикс уровня и отступ блока OUTPUT. */
function runnerLog(stdoutLine) {
  return [
    '[2026-09-20 19:30:00] [INFO] [PipelineRunner] Step 12',
    '[2026-09-20 19:30:00] [INFO] [verify-artifacts] START stage="verify-artifacts" agent="script-verify-artifacts"',
    '[2026-09-20 19:30:01] [INFO] [verify-artifacts] OUTPUT ↓',
    `[2026-09-20 19:30:01] [INFO] [verify-artifacts]   ${stdoutLine}`,
    '[2026-09-20 19:30:01] [INFO] [verify-artifacts] OUTPUT ↑',
    '[2026-09-20 19:30:01] [INFO] [verify-artifacts] COMPLETE stage="verify-artifacts" status="failed" exitCode=0'
  ].join('\n');
}

let workspace;
let projectRoot;
let savedCwd;

function writeLog(content, name = 'pipeline_2026-09-20_19-30-00.log') {
  fs.writeFileSync(path.join(projectRoot, '.workflow', 'logs', name), content);
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-contract-')));
  projectRoot = path.join(workspace, 'proj');
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'logs'), { recursive: true });
  savedCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  if (savedCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = savedCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('строка verify-artifacts ловится матчером', () => {
  it('сырой stdout распознаётся', () => {
    expect(buildGhostMarkerMatcher().test(GHOST_STDOUT_LINE)).toBe(true);
  });

  it('та же строка внутри лог-записи раннера распознаётся', () => {
    const logged = `[2026-09-20 19:30:01] [INFO] [verify-artifacts]   ${GHOST_STDOUT_LINE}`;
    expect(buildGhostMarkerMatcher().test(logged)).toBe(true);
  });

  it('вариант с assertion_failed распознаётся', () => {
    const line = '[GHOST-EXECUTION] ticket=IMPL-993 reason=assertion_failed assertions_failed=1';
    expect(buildGhostMarkerMatcher().test(line)).toBe(true);
  });

  it('пересказ строки внутри текста маркером не считается', () => {
    // В блок `OUTPUT` попадает и вывод AI-агентов: они цитируют лог и тикеты.
    // Токен посреди фразы — рассказ о событии, а не само событие.
    const matcher = buildGhostMarkerMatcher();

    expect(matcher.test('verify-artifacts напечатал [GHOST-EXECUTION] ticket=QA-903 — разберись')).toBe(false);
    expect(matcher.test('[2026-09-20 19:51:00] [INFO] [claude] в логе вижу [GHOST-EXECUTION] ticket=X')).toBe(false);
  });
});

describe('детектор здоровья', () => {
  it('поднимает алерт на логе с маркером', () => {
    writeLog(runnerLog(GHOST_STDOUT_LINE));

    const alert = detectGhostExecution(projectRoot);

    expect(alert).not.toBeNull();
    expect(alert.type).toBe('ghost_execution');
    expect(alert.severity).toBe('critical');
    expect(alert.project).toBe('proj');
    expect(alert.run_id).toBe('2026-09-20_19-30-00');
    // Тикет назван в самой строке — искать его в логе руками не нужно.
    expect(alert.ticket_id).toBe('QA-903');
  });

  it('молчит на логе честного прогона', () => {
    writeLog(runnerLog('---RESULT---'));

    expect(detectGhostExecution(projectRoot)).toBeNull();
  });

  it('молчит, когда агент пересказывает строку в своём выводе', () => {
    writeLog(runnerLog(`агент сообщает: ${GHOST_STDOUT_LINE}`));

    expect(detectGhostExecution(projectRoot)).toBeNull();
  });

  it('молчит на прозаическом упоминании', () => {
    // Ровно тот случай, ради которого маркер сделали структурным: 12 ложных
    // срабатываний на тегах тикетов и commit message (FIX-001).
    writeLog(runnerLog('добавлен e2e-гейт против ghost-execution в review-result'));

    expect(detectGhostExecution(projectRoot)).toBeNull();
  });
});

describe('list_ghost_executions', () => {
  it('находит запись и относит её к шагу пайплайна', async () => {
    writeLog(runnerLog(GHOST_STDOUT_LINE));

    const result = await list_ghost_executions.execute({});

    expect(result.count).toBe(1);
    const entry = result.executions[0];
    expect(entry.project).toBe('proj');
    expect(entry.step_number).toBe(12);
    expect(entry.log_excerpt).toContain('[GHOST-EXECUTION]');
    expect(entry.ticket_id).toBe('QA-903');
    // Время берётся из самой строки лога, а не из момента запроса.
    expect(entry.detected_at.startsWith('2026-09-20')).toBe(true);
  });

  it('не считает призраком прозу о нём', async () => {
    writeLog(runnerLog('тег тикета: ghost-execution'));

    const result = await list_ghost_executions.execute({});

    expect(result.count).toBe(0);
  });
});
