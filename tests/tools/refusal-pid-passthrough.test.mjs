/**
 * Номер процесса доходит до клиента, а не теряется на границе инструмента.
 *
 * `src/process/control.mjs` кладёт `pid` в любой отказ, но `pause_pipeline` и
 * `resume_pipeline` пересобирали ответ как `{ ok, code, hint }` — и номер
 * пропадал ровно у тех двух операций, ради которых его добавляли. `abort` и
 * `kill` отдают ответ как есть, поэтому у них он доходил и раньше.
 *
 * Здесь подменён весь `control.mjs`: проверяется не то, что ответила ОС, а то,
 * что инструмент донёс наружу.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Что вернёт подменённый `control.mjs` на ближайший вызов. */
let pauseAnswer;
let resumeAnswer;

vi.mock('../../src/process/control.mjs', () => ({
  kill: async () => ({ ok: true }),
  pause: async () => pauseAnswer,
  resume: async () => resumeAnswer,
  abort: async () => ({ ok: true, duration_ms: 1, escalated: false })
}));

const { pausePipelineImpl, resumePipelineImpl } = await import('../../src/tools/pipeline.mjs');
const { mcpInstanceId } = await import('../../src/lib/project-root.mjs');

const RUNNER_PID = 999999999;

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
  pauseAnswer = { ok: true, pid: RUNNER_PID, state: 'paused' };
  resumeAnswer = { ok: true, pid: RUNNER_PID, state: 'running' };
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-pid-')));
  projectRoot = path.join(workspace, 'proj');
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.workflow', 'logs', 'pipeline_2026-09-20_10-00-00.log'),
    '[2026-09-20 10:00:00] [INFO] [PipelineRunner] Step 1\n'
  );
  writeLock(RUNNER_PID);
  savedCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  if (savedCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = savedCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function pauseState() {
  fs.writeFileSync(
    path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json'),
    JSON.stringify({ pid: RUNNER_PID, paused_at: new Date().toISOString() })
  );
}

describe('pause_pipeline', () => {
  it('PAUSE_UNSUPPORTED доходит с pid', async () => {
    pauseAnswer = {
      ok: false,
      code: 'PAUSE_UNSUPPORTED',
      pid: RUNNER_PID,
      hint: 'pssuspend.exe not found.'
    };

    const result = await pausePipelineImpl('proj');

    expect(result).toMatchObject({ ok: false, code: 'PAUSE_UNSUPPORTED', pid: RUNNER_PID });
  });

  it('прочий отказ доходит с pid', async () => {
    pauseAnswer = {
      ok: false,
      code: 'PERMISSION_DENIED',
      pid: RUNNER_PID,
      hint: `Permission denied to signal PID ${RUNNER_PID}`
    };

    const result = await pausePipelineImpl('proj');

    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED', pid: RUNNER_PID });
  });
});

describe('resume_pipeline', () => {
  it('RESUME_UNSUPPORTED доходит с pid', async () => {
    pauseState();
    resumeAnswer = {
      ok: false,
      code: 'RESUME_UNSUPPORTED',
      pid: RUNNER_PID,
      hint: 'pssuspend.exe not found.'
    };

    const result = await resumePipelineImpl('proj');

    expect(result).toMatchObject({ ok: false, code: 'RESUME_UNSUPPORTED', pid: RUNNER_PID });
  });

  it('прочий отказ доходит с pid', async () => {
    pauseState();
    resumeAnswer = {
      ok: false,
      code: 'PERMISSION_DENIED',
      pid: RUNNER_PID,
      hint: `Permission denied to signal PID ${RUNNER_PID}`
    };

    const result = await resumePipelineImpl('proj');

    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED', pid: RUNNER_PID });
  });
});
