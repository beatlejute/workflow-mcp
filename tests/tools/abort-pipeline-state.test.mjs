/**
 * Состояние `aborting` на всём пути: `abort_pipeline` → снимок состояния.
 *
 * Модульные тесты проверяют флаг и читателя по отдельности; здесь проверяется
 * стык, ради которого всё затевалось. Прежде снимок искал `.workflow/logs/
 * .aborting` — файл, которого не пишет никто, — и пайплайн, которому уже
 * послали сигнал, до последнего выглядел обычным `running`.
 *
 * Настоящий сигнал не посылается: остановка процесса на Windows и POSIX
 * устроена по-разному и по-разному быстра, а проверяется здесь не она, а то,
 * что видно снаружи, пока идёт grace-окно.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { abortPipelineImpl, list_running_pipelines } from '../../src/tools/pipeline.mjs';
import * as control from '../../src/process/control.mjs';
import { mcpInstanceId } from '../../src/lib/project-root.mjs';
import { isAbortInProgress } from '../../src/process/abort-state.mjs';

let workspace;
let projectRoot;
let prevMcpCwd;
let victim;

const RUN_ID = 'pipeline_2026-09-20_10-00-00';

function pipelineLog() {
  return [
    '[2026-09-20 10:00:00] [INFO] [PipelineRunner] Step 3',
    '[2026-09-20 10:00:02] [INFO] START stage="execute-task" agent="claude-sonnet"'
  ].join('\n');
}

/** Проект с живым «раннером»: lock, свой маркер владения и лог. */
async function makeRunningProject() {
  const root = path.join(workspace, 'proj');
  const logsDir = path.join(root, '.workflow', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'state'), { recursive: true });

  victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(logsDir, '.pipeline.lock'),
    JSON.stringify({ pid: victim.pid, timestamp: now, started_at: now, started_by: 'mcp', run_id: RUN_ID })
  );
  fs.writeFileSync(
    path.join(logsDir, '.mcp-started-by'),
    JSON.stringify({
      version: 1,
      mcp_instance_id: mcpInstanceId(workspace),
      started_at: now,
      pid: victim.pid,
      run_id: RUN_ID
    })
  );
  fs.writeFileSync(path.join(logsDir, `${RUN_ID}.log`), pipelineLog());
  return root;
}

async function currentState() {
  const all = await list_running_pipelines.execute({});
  expect(all).toHaveLength(1);
  return all[0].state;
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-state-view-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
  projectRoot = await makeRunningProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (victim) {
    try {
      victim.kill();
    } catch {
      // мог завершиться сам
    }
    victim = undefined;
  }
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('aborting виден снаружи, пока идёт abort_pipeline', () => {
  it('до вызова пайплайн обычный running', async () => {
    expect(await currentState()).toBe('running');
  });

  it('внутри grace-окна состояние aborting, после — снова running', async () => {
    let stateDuringAbort = null;

    // Подменяется только сама остановка процесса: сигналы к проверяемому
    // здесь отношения не имеют, а их поведение зависит от платформы.
    vi.spyOn(control, 'abort').mockImplementation(async () => {
      stateDuringAbort = await currentState();
      return { ok: true, duration_ms: 5, escalated: false };
    });

    const result = await abortPipelineImpl('proj', { grace_sec: 1 });

    expect(result.ok).toBe(true);
    expect(stateDuringAbort, 'снимок не увидел идущую остановку').toBe('aborting');

    // Флаг снят, и процесс всё ещё жив — состояние возвращается к обычному.
    expect(isAbortInProgress(projectRoot)).toBe(false);
    expect(await currentState()).toBe('running');
  });

  it('флаг снимается и когда остановка не удалась', async () => {
    vi.spyOn(control, 'abort').mockResolvedValue({ ok: false, code: 'ABORT_FAILED' });

    const result = await abortPipelineImpl('proj', { grace_sec: 1 });

    expect(result.ok).toBe(false);
    // Иначе один неудачный abort оставлял бы проект в `aborting` до конца TTL.
    expect(isAbortInProgress(projectRoot)).toBe(false);
    expect(await currentState()).toBe('running');
  });

  it('параллельный abort отклоняется, пока идёт первый', async () => {
    let parallel = null;

    vi.spyOn(control, 'abort').mockImplementation(async () => {
      parallel = await abortPipelineImpl('proj', { grace_sec: 1 });
      return { ok: true, duration_ms: 5, escalated: false };
    });

    await abortPipelineImpl('proj', { grace_sec: 1 });

    expect(parallel).not.toBeNull();
    expect(parallel.ok).toBe(false);
    expect(parallel.code).toBe('ALREADY_ABORTING');
  });
});
