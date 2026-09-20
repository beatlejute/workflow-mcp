/**
 * `workflow://pipeline-state` обязан показывать текущее состояние, а не первое.
 *
 * Снимок лежал в кеше процесса, а инвалидировали его только наблюдатели за
 * файлами. Наблюдатели встают лишь при подписке, и лог прогона их намеренно не
 * будит. Клиент без подписки получал первый снимок до конца жизни сервера:
 * живьём ресурс отдавал `killed` от прошлого прогона, пока
 * `list_running_pipelines` в ту же секунду отвечал `running`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  get_workflow_pipeline_state,
  cancelPipelineStateNotification
} from '../../src/resources/index.mjs';
import { writeRunnerLock, removeRunnerLock } from '../helpers/pipeline-lock.mjs';

let workspace;
let prevMcpCwd;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fresh-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
  cancelPipelineStateNotification();
});

afterEach(() => {
  cancelPipelineStateNotification();
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeProject(name) {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
  return root;
}

async function readState() {
  const resource = await get_workflow_pipeline_state();
  return JSON.parse(resource.text);
}

describe('свежесть ресурса workflow://pipeline-state', () => {
  it('пайплайн, запущенный после первого чтения, виден без подписки', async () => {
    const root = makeProject('proj');

    expect(await readState()).toEqual([]);

    writeRunnerLock(root, process.pid);

    const after = await readState();
    expect(after).toHaveLength(1);
    expect(after[0].project).toBe('proj');
    expect(after[0].state).toBe('running');
  });

  it('снятый lock исчезает из ресурса', async () => {
    const root = makeProject('proj');
    writeRunnerLock(root, process.pid);
    expect(await readState()).toHaveLength(1);

    removeRunnerLock(root);

    expect(await readState()).toEqual([]);
  });

  it('смена состояния прогона доходит до ресурса', async () => {
    const root = makeProject('proj');
    writeRunnerLock(root, process.pid);
    expect((await readState())[0].state).toBe('running');

    // pid, которого нет: раннер убит, lock остался — ровно тот случай, ради
    // которого состояние `stale` и заведено.
    writeRunnerLock(root, 0x7ffffff0);

    expect((await readState())[0].state).toBe('stale');
  });

  it('новый проект в рабочей области попадает в ресурс', async () => {
    makeProject('first');
    expect(await readState()).toEqual([]);

    const second = makeProject('second');
    writeRunnerLock(second, process.pid);

    const state = await readState();
    expect(state.map((entry) => entry.project)).toEqual(['second']);
  });

  it('ресурс и снимок для list_running_pipelines совпадают', async () => {
    const root = makeProject('proj');
    writeRunnerLock(root, process.pid);

    const { get_workflow_pipeline_state: snapshot } = await import('../../src/resources/pipeline-state.mjs');
    expect(await readState()).toEqual(snapshot(path.resolve(workspace)));
  });
});
