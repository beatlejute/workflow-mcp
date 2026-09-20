/**
 * Переиспользованный номер останавливает любой путь с сигналом.
 *
 * Раннер, убитый без снятия lock'а, оставляет номер, который система отдаёт
 * другому процессу. Дальше всё равно, что именно мы собирались послать: `kill`,
 * `SIGSTOP` или мягкий `SIGINT` с эскалацией — адресат посторонний.
 *
 * Проверка сделана отдельной от сверки владения и идёт раньше неё. Внутри
 * `validateRunOwnership` признаки чужого запуска проверяются раньше времени
 * старта (и правильно: для живого чужого раннера совет «удалите lock» был бы
 * вредным), а `WORKFLOW_MCP_FORCE_FOREIGN=1` обрывает её в самом начале —
 * поэтому ни причина отказа, ни аварийный ключ о переиспользовании номера
 * ничего не знают.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import {
  stopPipelineImpl,
  pausePipelineImpl,
  resumePipelineImpl,
  abortPipelineImpl
} from '../../src/tools/pipeline.mjs';
import { writeRunnerLock } from '../helpers/pipeline-lock.mjs';
import { clearProcessAliveCache } from '../../src/health/pid-check.mjs';

const ANCIENT = '2020-01-01T00:00:00.000Z';

let workspace;
let projectRoot;
let savedCwd;
let savedKey;
let victim;

/** Живой посторонний процесс в роли занявшего номер. */
async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return child;
}

function stalelock(pid, extra = {}) {
  writeRunnerLock(projectRoot, pid, { started_at: ANCIENT, timestamp: ANCIENT, ...extra });
}

beforeEach(async () => {
  // Память живости общая на весь процесс, а Windows охотно переиспользует
  // номера: ответ про жертву прошлого теста иначе достаётся следующей.
  clearProcessAliveCache();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pid-reuse-')));
  projectRoot = path.join(workspace, 'proj');
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'state'), { recursive: true });
  savedCwd = process.env.MCP_CWD;
  savedKey = process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  process.env.MCP_CWD = workspace;
  victim = await spawnVictim();
});

afterEach(() => {
  try { victim.kill(); } catch { /* мог завершиться */ }
  if (savedCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = savedCwd;
  if (savedKey === undefined) delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  else process.env.WORKFLOW_MCP_FORCE_FOREIGN = savedKey;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('свой lock с переиспользованным номером', () => {
  it.each([
    ['pause_pipeline', () => pausePipelineImpl('proj')],
    ['resume_pipeline', () => resumePipelineImpl('proj')],
    ['abort_pipeline', () => abortPipelineImpl('proj', { grace_sec: 0 })],
    ['stop_pipeline', () => stopPipelineImpl('proj')]
  ])('%s отвечает STALE_PIPELINE_LOCK, а не «пайплайн чужой»', { timeout: 30000 }, async (_name, call) => {
    stalelock(victim.pid);

    const result = await call();

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STALE_PIPELINE_LOCK');
    expect(result.reason).toBe('PID_REUSED');
    expect(result.hint).toMatch(/\.pipeline\.lock/);
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  });
});

describe('чужой lock с переиспользованным номером', () => {
  it.each([
    ['pause_pipeline', () => pausePipelineImpl('proj')],
    ['abort_pipeline', () => abortPipelineImpl('proj', { grace_sec: 0 })]
  ])('%s говорит про протухший lock, а не про чужой пайплайн', { timeout: 30000 }, async (_name, call) => {
    // Подсказка «пайплайн чужой, позовите с force» тут вредна дважды: чужого
    // пайплайна нет, а force привёл бы к сигналу постороннему процессу.
    stalelock(victim.pid, { started_by: 'cli', started_by_id: null });

    const result = await call();

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STALE_PIPELINE_LOCK');
    expect(result.reason).toBe('PID_REUSED');
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  });
});

describe('аварийный ключ', () => {
  it.each([
    ['stop_pipeline', () => stopPipelineImpl('proj', { force: true })],
    ['abort_pipeline', () => abortPipelineImpl('proj', { grace_sec: 0 })],
    ['pause_pipeline', () => pausePipelineImpl('proj')]
  ])('WORKFLOW_MCP_FORCE_FOREIGN=1 не отменяет отказ у %s', { timeout: 30000 }, async (_name, call) => {
    process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';
    stalelock(victim.pid, { started_by: 'cli', started_by_id: null });

    const result = await call();

    expect(result.ok).toBe(false);
    // Код важен не меньше причины: без него тест проходил бы и в случае,
    // когда мягкий сигнал уже ушёл постороннему процессу, а отказ пришёл
    // позже — от проверки внутри grace-окна.
    expect(result.code).toBe('STALE_PIPELINE_LOCK');
    expect(result.reason).toBe('PID_REUSED');
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  });
});

describe('сверка владения после проверки номера', () => {
  it('resume_pipeline отказывает на чужом lock с живым раннером', { timeout: 30000 }, async () => {
    // Проверка переиспользования идёт первой, но сверку владения она не
    // заменяет: у живого чужого раннера номер настоящий, а пайплайн не наш.
    writeRunnerLock(projectRoot, victim.pid, { started_by: 'cli', started_by_id: null });
    fs.writeFileSync(
      path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json'),
      JSON.stringify({ pid: victim.pid, paused_at: new Date().toISOString() })
    );

    const result = await resumePipelineImpl('proj');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('OWNERSHIP_VALIDATION_FAILED');
    expect(result.reason).toBe('STARTED_BY_MISMATCH');
  });

  it('resume_pipeline отказывает на метке чужого экземпляра', { timeout: 30000 }, async () => {
    writeRunnerLock(projectRoot, victim.pid, { started_by_id: 'workflow-mcp@foreign12345' });
    fs.writeFileSync(
      path.join(projectRoot, '.workflow', 'state', 'pipeline-pause.json'),
      JSON.stringify({ pid: victim.pid, paused_at: new Date().toISOString() })
    );

    const result = await resumePipelineImpl('proj');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('OWNERSHIP_VALIDATION_FAILED');
    expect(result.reason).toBe('INSTANCE_MISMATCH');
  });
});

describe('живой раннер не страдает', () => {
  it('lock, записанный после старта процесса, проверку проходит', { timeout: 30000 }, async () => {
    // Обратная сторона: защита не должна мешать управлять настоящим прогоном.
    writeRunnerLock(projectRoot, victim.pid);

    const result = await pausePipelineImpl('proj');

    // Сама пауза на Windows может быть недоступна — важно лишь то, что отказа
    // по владению или по протухшему lock'у нет.
    expect(['STALE_PIPELINE_LOCK', 'OWNERSHIP_VALIDATION_FAILED']).not.toContain(result.code);
  });
});
