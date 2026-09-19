/**
 * Подписка на `workflow://pipeline-state` должна замечать появление пайплайна.
 *
 * Наблюдатель подписывался на `<project>/.runner-pids` — файл, которого не
 * пишет никто. `fs.watch` по несуществующему пути молча ничего не даёт (а
 * вызов обёрнут в `try {} catch {}`), поэтому уведомлений об изменении
 * состояния пайплайна клиент не получал вовсе: ресурс читался только по
 * явному запросу. Тестов у этого места не было.
 *
 * Теперь наблюдение идёт за каталогом `.workflow/logs`, где раннер создаёт
 * `.pipeline.lock`. Каталог существует к моменту подписки, а файл — нет.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  subscribe_workflow_pipeline_state,
  clearPipelineStateCache
} from '../../src/resources/index.mjs';
import { writeRunnerLock } from '../helpers/pipeline-lock.mjs';

let workspace;
let prevMcpCwd;
let unsubscribe;

/** Ждёт вызова подписчика или отдаёт false по истечении времени. */
function waitForNotification(calls, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (calls.length > 0) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-watcher-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
  clearPipelineStateCache();
});

afterEach(() => {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      // уже отписаны
    }
    unsubscribe = undefined;
  }
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeProject(name) {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
  return root;
}

describe('наблюдатель за состоянием пайплайна', () => {
  it('появление lock-файла доходит до подписчика', async () => {
    const root = makeProject('proj');

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    // Файла ещё нет — ровно та ситуация, в которой подписка ставится в жизни.
    writeRunnerLock(root, process.pid);

    expect(await waitForNotification(calls), 'подписчик не был вызван').toBe(true);
  });

  it('изменение lock-файла тоже доходит', async () => {
    const root = makeProject('proj');
    writeRunnerLock(root, process.pid);

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    writeRunnerLock(root, process.pid, { run_id: 'pipeline_2026-09-20_12-00-00' });

    expect(await waitForNotification(calls)).toBe(true);
  });

  it('отписка снимает наблюдение', async () => {
    const root = makeProject('proj');

    const calls = [];
    const stop = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));
    stop();
    unsubscribe = undefined;

    writeRunnerLock(root, process.pid);

    // Ждём заведомо дольше окна склейки: вызовов быть не должно.
    expect(await waitForNotification(calls, 1200)).toBe(false);
  });
});
