/**
 * Владение пайплайном привязано к запуску, а не к процессу сервера.
 *
 * Было две разные поломки. Сначала `start_pipeline` писал в маркер
 * `.mcp-started-by` pid порождённого раннера, а `pause`/`resume`/`abort`/`stop`
 * сверяли это поле с `process.pid` самого сервера — совпасть нельзя никогда,
 * и управление своим же пайплайном всегда отвечало `PID_MISMATCH`. Затем pid
 * для сигналов брался только из `.runner-pids`, которого не пишет никто, — и
 * отказ просто переехал в `NO_RUNNER_PIDS`.
 *
 * Сейчас в маркере лежит pid раннера, а сверяется он с живым pid из
 * `.pipeline.lock`. Из этого следуют три свойства, каждое проверено ниже:
 * свой пайплайн управляется; он остаётся своим после рестарта сервера;
 * протухший маркер не даёт власти над чужим пайплайном.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  start_pipeline,
  pause_pipeline,
  resume_pipeline,
  stop_pipeline,
  list_running_pipelines,
  abortPipelineImpl
} from '../../src/tools/pipeline.mjs';
import { readMarker } from '../../src/process/marker.mjs';
import { mcpInstanceId } from '../../src/lib/project-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(path.dirname(__dirname));

// Entry-стадия manual-gate паркует раннер в опросе: процесс живёт, и маркер
// можно проверить на идущем пайплайне.
const PIPELINE_YAML = `pipeline:
  name: marker-ownership-test
  version: "1.0"
  entry: gate
  context: {}
  agents: {}
  stages:
    gate:
      type: manual-gate
      timeout_seconds: 300
      poll_interval_ms: 1000
      goto:
        approved: gate
        rejected: gate
`;

/** Отказ из-за владения, а не из-за отсутствия средств управления процессом. */
const OWNERSHIP_FAILURES = [
  'MARKER_VALIDATION_FAILED',
  'FOREIGN_PIPELINE',
  'STALE_PIPELINE_LOCK',
  'NO_RUNNER_PIDS'
];

function makeProject(root, name) {
  const project = path.join(root, name);
  fs.mkdirSync(path.join(project, '.workflow', 'config'), { recursive: true });
  fs.mkdirSync(path.join(project, '.workflow', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(project, '.workflow', 'config', 'pipeline.yaml'), PIPELINE_YAML);
  return project;
}

describe('владение пайплайном, запущенным через MCP', () => {
  let root;
  let project;
  let savedMcpCwd;
  let started;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marker-own-')));
    project = makeProject(root, 'projA');
    savedMcpCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = root;
  });

  afterAll(() => {
    if (started?.pid) {
      try {
        process.kill(started.pid);
      } catch {
        // процесс мог уже завершиться
      }
    }
    if (savedMcpCwd === undefined) {
      delete process.env.MCP_CWD;
    } else {
      process.env.MCP_CWD = savedMcpCwd;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // раннер мог ещё держать лог-файл
    }
  });

  it('pause и resume признают свой пайплайн', { timeout: 60000 }, async () => {
    started = await start_pipeline.execute({ project: 'projA' });
    expect(started.ok, `start_pipeline: ${started.code ?? ''} ${started.hint ?? ''}`).toBe(true);

    // Сама пауза может быть недоступна (на Windows нужен pssuspend) — это
    // происходит уже после проверки владения. Отказать по владению или из-за
    // ненайденного pid она больше не должна.
    const paused = await pause_pipeline.execute({ project: 'projA' });
    expect(OWNERSHIP_FAILURES, `pause: ${JSON.stringify(paused)}`).not.toContain(paused.code);

    const resumed = await resume_pipeline.execute({ project: 'projA' });
    expect(OWNERSHIP_FAILURES, `resume: ${JSON.stringify(resumed)}`).not.toContain(resumed.code);

    // В маркере — pid раннера; он же лежит в lock'е, по нему и сверяются.
    const marker = readMarker(project);
    expect(marker.pid).toBe(started.pid);
  });

  it('пайплайн остаётся своим после рестарта сервера', { timeout: 60000 }, async () => {
    // Отдельный процесс — это и есть перезапущенный сервер: тот же MCP_CWD,
    // другой process.pid. Пока владение было привязано к процессу, свой
    // пайплайн после каждого рестарта становился чужим навсегда.
    expect(started?.ok, 'предыдущий тест не поднял пайплайн').toBe(true);

    const script = `
      import { pause_pipeline } from ${JSON.stringify(pathToFileURL(path.join(rootDir, 'src/tools/pipeline.mjs')).href)};
      const result = await pause_pipeline.execute({ project: 'projA' });
      process.stdout.write(JSON.stringify({ pid: process.pid, result }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MCP_CWD: root },
      encoding: 'utf8'
    });

    expect(child.status, `stderr: ${child.stderr}`).toBe(0);
    const { pid: childPid, result } = JSON.parse(child.stdout);
    expect(childPid).not.toBe(process.pid);
    expect(OWNERSHIP_FAILURES, `pause из другого процесса: ${JSON.stringify(result)}`).not.toContain(result.code);
  });

  /**
   * Проект с готовой парой lock + маркер. По умолчанию они согласованы и
   * описывают наш запуск; каждый тест портит ровно одну составляющую.
   */
  function makeRun(name, { lock = {}, marker = {} } = {}) {
    const dir = makeProject(root, name);
    const logsDir = path.join(dir, '.workflow', 'logs');
    // Заведомо мёртвый pid: если защита сломается, убивать нечего.
    const pid = 999999;
    const runId = 'pipeline_2026-01-01_00-00-00';
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(logsDir, '.pipeline.lock'), JSON.stringify({
      pid,
      timestamp: now,
      started_at: now,
      started_by: 'mcp',
      run_id: runId,
      ...lock
    }));
    fs.writeFileSync(path.join(logsDir, '.mcp-started-by'), JSON.stringify({
      version: 1,
      mcp_instance_id: mcpInstanceId(),
      started_at: now,
      pid,
      run_id: runId,
      ...marker
    }));
    return { dir, pid, runId };
  }

  it('протухший маркер от прошлого запуска не даёт власти над текущим', async () => {
    // Самый неприятный случай: pid совпадает, идентификатор совпадает, а запуск
    // другой — маркер остался от предыдущего (`removeMarker` зовут только stop и
    // abort). Проверка по одному pid здесь сказала бы «свой».
    makeRun('projB', { marker: { run_id: 'pipeline_2025-12-31_23-59-59' } });

    const stopped = await stop_pipeline.execute({ project: 'projB' });
    expect(stopped.ok).toBe(false);
    expect(stopped.code).toBe('FOREIGN_PIPELINE');
    expect(stopped.reason).toBe('RUN_MISMATCH');
  });

  it('запущенный из CLI не становится своим из-за рядом лежащего маркера', async () => {
    makeRun('projD', { lock: { started_by: 'cli' } });

    const stopped = await stop_pipeline.execute({ project: 'projD' });
    expect(stopped.ok).toBe(false);
    expect(stopped.code).toBe('FOREIGN_PIPELINE');
    expect(stopped.reason).toBe('STARTED_BY_MISMATCH');
  });

  it('переиспользованный системой pid не считается нашим раннером', { timeout: 30000 }, async () => {
    // Раннер убит без снятия lock'а (kill -9, taskkill /F, перезагрузка), а номер
    // достался другому процессу. Нужен живой посторонний pid, и именно посторонний:
    // если защита сломается, `stop_pipeline` этот процесс убьёт — подставлять сюда
    // `process.pid` значит убить сам прогон.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(victim.pid).toBeGreaterThan(0);

      // lock датирован далёким прошлым: процесс с этим pid стартовал позже,
      // значит он не может быть тем раннером, который lock записал.
      const ancient = '2020-01-01T00:00:00.000Z';
      makeRun('projE', {
        lock: { pid: victim.pid, started_at: ancient, timestamp: ancient },
        marker: { pid: victim.pid, started_at: ancient }
      });

      const stopped = await stop_pipeline.execute({ project: 'projE' });
      expect(stopped.ok).toBe(false);
      // Это не «чужой пайплайн», а протухший lock без пайплайна вовсе,
      // и советовать здесь force значит советовать убить посторонний процесс.
      expect(stopped.code).toBe('STALE_PIPELINE_LOCK');
      expect(stopped.reason).toBe('PID_REUSED');
      expect(stopped.hint).not.toMatch(/use force=true/i);
      expect(stopped.hint).toMatch(/\.pipeline\.lock/);
      // `exitCode` обновляется событием и отстаёт; спрашиваем у ОС напрямую.
      expect(() => process.kill(victim.pid, 0), 'посторонний процесс убит').not.toThrow();
    } finally {
      try {
        victim.kill();
      } catch {
        // мог уже завершиться
      }
    }
  });

  /**
   * Живой посторонний процесс в роли раннера — чтобы проверять эскалацию
   * на чём-то, что действительно живо и не является самим прогоном.
   */
  async function spawnVictim() {
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return victim;
  }

  it('abort не добивает, если раннер сам вышел за grace-окно', { timeout: 30000 }, async () => {
    // Штатно завершаясь, раннер снимает lock. Если продолжить эскалацию,
    // жёсткий сигнал уйдёт по pid, который система могла уже отдать другому.
    const victim = await spawnVictim();
    try {
      const { dir } = makeRun('projF', { lock: { pid: victim.pid }, marker: { pid: victim.pid } });
      const lockPath = path.join(dir, '.workflow', 'logs', '.pipeline.lock');

      // Раннер «вышел» посреди grace-окна.
      setTimeout(() => {
        try { fs.unlinkSync(lockPath); } catch { /* уже снят */ }
      }, 300);

      const aborted = await abortPipelineImpl('projF', { grace_sec: 2 });

      expect(aborted.ok, JSON.stringify(aborted)).toBe(true);
      expect(aborted.escalated).toBe(false);
      expect(() => process.kill(victim.pid, 0), 'посторонний процесс добит').not.toThrow();
    } finally {
      try { victim.kill(); } catch { /* мог завершиться */ }
    }
  });

  it('abort не эскалирует, если владение потеряно за grace-окно', { timeout: 30000 }, async () => {
    const victim = await spawnVictim();
    try {
      const { dir } = makeRun('projG', { lock: { pid: victim.pid }, marker: { pid: victim.pid } });
      const lockPath = path.join(dir, '.workflow', 'logs', '.pipeline.lock');

      // На месте нашего запуска оказался другой — запущенный из CLI.
      setTimeout(() => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: victim.pid,
          timestamp: new Date().toISOString(),
          started_at: new Date().toISOString(),
          started_by: 'cli',
          run_id: 'pipeline_2026-02-02_00-00-00'
        }));
      }, 300);

      const aborted = await abortPipelineImpl('projG', { grace_sec: 2 });

      expect(aborted.ok, JSON.stringify(aborted)).toBe(false);
      expect(aborted.code).toBe('OWNERSHIP_LOST');
      expect(() => process.kill(victim.pid, 0), 'посторонний процесс добит').not.toThrow();
    } finally {
      try { victim.kill(); } catch { /* мог завершиться */ }
    }
  });

  it('без lock\'а переиспользование ловится по времени из маркера', { timeout: 30000 }, async () => {
    // pid приходит из `.runner-pids`, lock'а нет. Раньше в этой ветке вся защита
    // сводилась к равенству pid — то есть к тому, что признано недостаточным.
    const victim = await spawnVictim();
    try {
      const dir = makeProject(root, 'projH');
      const ancient = '2020-01-01T00:00:00.000Z';
      fs.writeFileSync(path.join(dir, '.runner-pids'), String(victim.pid));
      fs.writeFileSync(path.join(dir, '.workflow', 'logs', '.mcp-started-by'), JSON.stringify({
        version: 1,
        mcp_instance_id: mcpInstanceId(),
        started_at: ancient,
        pid: victim.pid
      }));

      const stopped = await stop_pipeline.execute({ project: 'projH' });

      expect(stopped.ok).toBe(false);
      expect(stopped.code).toBe('STALE_PIPELINE_LOCK');
      expect(stopped.reason).toBe('PID_REUSED');
      expect(() => process.kill(victim.pid, 0), 'посторонний процесс убит').not.toThrow();
    } finally {
      try { victim.kill(); } catch { /* мог завершиться */ }
    }
  });

  it('list_running_pipelines помечает чужие пайплайны и не помечает свой', async () => {
    // Признак `foreign` был инвертирован и не покрыт ничем: два теста на него в
    // `list-running-pipelines.test.mjs` — заглушки с комментарием «Would test».
    expect(started?.ok, 'первый тест не поднял пайплайн').toBe(true);

    // Запущенный из CLI: lock есть, маркера нет вовсе. Именно этот случай
    // старое выражение считало своим: причина отказа MISSING, а не PID_MISMATCH.
    const cli = makeProject(root, 'projC');
    fs.writeFileSync(
      path.join(cli, '.workflow', 'logs', '.pipeline.lock'),
      JSON.stringify({ pid: 999998, timestamp: new Date().toISOString(), started_by: 'cli' })
    );

    const pipelines = await list_running_pipelines.execute({});
    const byName = Object.fromEntries(pipelines.map((entry) => [entry.project, entry]));

    expect(byName.projA, `свой пайплайн не попал в список: ${JSON.stringify(pipelines)}`).toBeDefined();
    expect(byName.projA.foreign).toBeUndefined();
    expect(byName.projA.marker_valid).toBe(true);

    // Протухший маркер от прошлого запуска (создан выше).
    expect(byName.projB?.foreign).toBe(true);
    // Запущенный из CLI — тоже чужой.
    expect(byName.projC, 'пайплайн из CLI не попал в список').toBeDefined();
    expect(byName.projC.marker_reason).toBe('MISSING');
    expect(byName.projC.foreign).toBe(true);
  });
});
