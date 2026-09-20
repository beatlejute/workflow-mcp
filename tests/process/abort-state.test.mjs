/**
 * Флаг идущего abort'а.
 *
 * Жил внутри `tools/pipeline.mjs` и только ради защиты от параллельного
 * abort'а. Снимок состояния тем временем искал `.workflow/logs/.aborting` —
 * файл, которого не пишет никто, — поэтому состояние `aborting` не возникало
 * никогда. Теперь у флага один дом и два читателя, и он обязан различать
 * остановку текущего прогона и файл, забытый прошлым.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeAbortState,
  readAbortState,
  clearAbortState,
  isAbortInProgress,
  abortStatePath,
  ABORT_STATE_TTL_MS
} from '../../src/process/abort-state.mjs';

let projectRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-state-'));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** Кладёт файл с произвольным содержимым, минуя запись. */
function writeRaw(body) {
  const file = abortStatePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('флаг идущего abort', () => {
  it('записанный флаг читается со всеми полями', () => {
    writeAbortState(projectRoot, {
      runnerPid: 4242,
      runId: 'pipeline_2026-09-20_10-00-00',
      mcpInstanceId: 'inst-1'
    });

    const state = readAbortState(projectRoot);

    expect(state).not.toBeNull();
    expect(state.runner_pid).toBe(4242);
    expect(state.run_id).toBe('pipeline_2026-09-20_10-00-00');
    expect(state.mcp_instance_id).toBe('inst-1');
    // Pid сервера тоже сохраняется: по нему видно, кто затеял остановку.
    expect(state.pid).toBe(process.pid);
    expect(new Date(state.started_at).toISOString()).toBe(state.started_at);
    expect(isAbortInProgress(projectRoot)).toBe(true);
  });

  it('каталог состояния создаётся при записи', () => {
    // `workflow init` каталог `state` не создаёт, а abort может быть первым,
    // кому он понадобился.
    expect(fs.existsSync(path.join(projectRoot, '.workflow', 'state'))).toBe(false);

    expect(writeAbortState(projectRoot, { runnerPid: 1 })).toBe(true);
    expect(fs.existsSync(abortStatePath(projectRoot))).toBe(true);
  });

  it('без файла флага нет', () => {
    expect(readAbortState(projectRoot)).toBeNull();
    expect(isAbortInProgress(projectRoot)).toBe(false);
  });

  it('снятие флага идемпотентно', () => {
    writeAbortState(projectRoot, { runnerPid: 1 });
    clearAbortState(projectRoot);
    expect(readAbortState(projectRoot)).toBeNull();

    expect(() => clearAbortState(projectRoot)).not.toThrow();
  });

  it.each([
    ['пустой файл', ''],
    ['не JSON', '{ это не json'],
    ['без started_at', JSON.stringify({ runner_pid: 1 })],
    ['нечитаемая дата', JSON.stringify({ started_at: 'позавчера', runner_pid: 1 })]
  ])('испорченный флаг (%s) читается как отсутствующий', (_label, body) => {
    // Сервер может умереть посреди записи. Битый файл не повод объявить
    // остановку — и не повод уронить снимок состояния.
    writeRaw(body);

    expect(readAbortState(projectRoot)).toBeNull();
    expect(isAbortInProgress(projectRoot)).toBe(false);
  });

  it('флаг старше TTL не действует', () => {
    // `grace_sec` ограничен минутой: файл возрастом в десять минут остался от
    // сервера, который не дожил до снятия флага.
    writeRaw(JSON.stringify({
      started_at: new Date(Date.now() - ABORT_STATE_TTL_MS - 1000).toISOString(),
      runner_pid: 1
    }));

    expect(readAbortState(projectRoot)).toBeNull();
  });

  it('флаг моложе TTL действует', () => {
    writeRaw(JSON.stringify({
      started_at: new Date(Date.now() - ABORT_STATE_TTL_MS + 5000).toISOString(),
      runner_pid: 1
    }));

    expect(readAbortState(projectRoot)).not.toBeNull();
  });

  it('флаг без runner_pid читается, но pid не выдумывается', () => {
    // Формат пережил смену полей: старый файл без `runner_pid` не должен
    // выглядеть остановкой конкретного прогона.
    writeRaw(JSON.stringify({ started_at: new Date().toISOString(), pid: 123 }));

    const state = readAbortState(projectRoot);
    expect(state).not.toBeNull();
    expect(state.runner_pid).toBeNull();
  });
});
