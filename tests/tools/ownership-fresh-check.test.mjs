/**
 * Перед сигналом время старта процесса спрашивается у ОС заново.
 *
 * Память о времени старта живёт минуту и нужна чтению состояния. На пути к
 * сигналу она опасна: прогретая чтением запись переживает смерть раннера, и
 * если система успела отдать номер другому процессу, `stop_pipeline` получил бы
 * «тот самый раннер» и послал `taskkill /F /T` постороннему дереву. Сверка
 * `pid` и `started_by_id` от этого не спасает — оба поля лежат в том же
 * протухшем lock'е.
 *
 * Здесь подменяется сам модуль опроса: проверяется не то, что ОС ответила, а
 * то, с какими опциями её спросили. Механику памяти проверяет
 * `tests/process/process-start-cache.test.mjs`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const calls = [];

vi.mock('../../src/process/process-start.mjs', () => ({
  pidCouldBeFromRun: (pid, lockWrittenAt, options = {}) => {
    calls.push({ pid, lockWrittenAt, fresh: options.fresh === true });
    return true;
  },
  processStartedAt: () => null,
  processStartedAtCached: () => null,
  clearProcessStartCache: () => {}
}));

vi.mock('../../src/process/control.mjs', () => ({
  kill: async () => ({ ok: true }),
  pause: async () => ({ ok: true, method: 'test' }),
  resume: async () => ({ ok: true }),
  abort: async () => ({ ok: true, duration_ms: 1, escalated: false })
}));

const { stopPipelineImpl, pausePipelineImpl, abortPipelineImpl, list_running_pipelines } =
  await import('../../src/tools/pipeline.mjs');
const { mcpInstanceId } = await import('../../src/lib/project-root.mjs');

let workspace;
let projectRoot;
let savedCwd;

function writeLock(pid) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock'),
    JSON.stringify({
      pid,
      timestamp: now,
      started_at: now,
      started_by: 'mcp',
      started_by_id: mcpInstanceId(workspace),
      run_id: 'pipeline_2026-09-20_10-00-00'
    })
  );
}

beforeEach(() => {
  calls.length = 0;
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-check-')));
  projectRoot = path.join(workspace, 'proj');
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.workflow', 'logs', 'pipeline_2026-09-20_10-00-00.log'),
    '[2026-09-20 10:00:00] [INFO] [PipelineRunner] Step 1\n'
  );
  savedCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  if (savedCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = savedCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('пути с сигналом', () => {
  it('stop_pipeline спрашивает ОС заново', async () => {
    writeLock(999999);

    await stopPipelineImpl('proj');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.fresh)).toBe(true);
  });

  it('pause_pipeline спрашивает ОС заново', async () => {
    writeLock(999999);

    await pausePipelineImpl('proj');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.fresh)).toBe(true);
  });

  it('abort_pipeline спрашивает ОС заново', async () => {
    writeLock(999999);

    await abortPipelineImpl('proj', { grace_sec: 0 });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.fresh)).toBe(true);
  });
});

describe('чтение состояния', () => {
  it('list_running_pipelines довольствуется памятью', async () => {
    // Здесь сигнал никому не уходит, а обход идёт по всем проектам на каждый
    // вызов: платить за опрос ОС каждый раз незачем.
    writeLock(999999);

    await list_running_pipelines.execute({});

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.fresh)).toBe(false);
  });
});
