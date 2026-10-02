/**
 * start_pipeline: реальный запуск раннера workflow-ai detached-процессом.
 *
 * Синглтон держит сам раннер через .pipeline.lock (workflow-ai PLAN-011),
 * поэтому здесь проверяем контракт tool'а: валидацию проекта, отказ при живом
 * запуске, снятие протухшего lock и формат ответа.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { start_pipeline } from '../../src/tools/pipeline.mjs';
import { mcpInstanceId } from '../../src/lib/project-root.mjs';
import * as pidCheck from '../../src/health/pid-check.mjs';
import { clearProcessAliveCache } from '../../src/health/pid-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** PID, которого заведомо нет в системе. */
const DEAD_PID = 999999999;

const LOCK_REL = ['.workflow', 'logs', '.pipeline.lock'];

function createProject(workspaceDir, name = 'start-project') {
  const projectPath = path.join(workspaceDir, name);
  fs.mkdirSync(path.join(projectPath, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.workflow', 'config'), { recursive: true });
  return projectPath;
}

function writeLock(projectPath, pid, startedAt = new Date().toISOString()) {
  fs.writeFileSync(
    path.join(projectPath, ...LOCK_REL),
    JSON.stringify({ pid, timestamp: startedAt, started_at: startedAt }, null, 2)
  );
}

/**
 * Подставной «раннер»: пишет `.pipeline.lock` и лог `pipeline_<ts>.log`, как
 * настоящий, и держится несколько секунд. Позволяет проверить контракт
 * start_pipeline, не гоняя настоящий пайплайн.
 *
 * Lock несёт то, чем представился запускающий (`WORKFLOW_STARTED_BY` и
 * `WORKFLOW_STARTED_BY_ID`): с 3.0.0 это единственный файл владения.
 *
 * @param {string} dir каталог для bin
 * @param {Object} [options]
 * @param {boolean} [options.recordInstanceId] писать ли метку экземпляра
 *   (false — раннер до workflow-ai 1.7.0)
 * @param {string} [options.stderrEarly] строка в stderr сразу после старта, до лога
 * @param {string} [options.stderrLate] строка в stderr через 1.2 с — когда start_pipeline
 *   уже вернул управление и переименовал файл stderr
 * @param {string} [options.crashWith] упасть на старте: текст в stderr, код 1, лога нет
 */
function writeFakeRunner(dir, { recordInstanceId = true, stderrEarly = null, stderrLate = null, crashWith = null } = {}) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'workflow.mjs');
  fs.writeFileSync(bin, [
    "import fs from 'fs';",
    "import path from 'path';",
    crashWith
      ? `process.stderr.write(${JSON.stringify(crashWith + '\n')}); process.exit(1);`
      : "// штатный запуск",
    "const argv = process.argv.slice(2);",
    "const projectRoot = argv[argv.indexOf('--project') + 1];",
    "const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);",
    "const logsDir = path.join(projectRoot, '.workflow', 'logs');",
    "fs.mkdirSync(logsDir, { recursive: true });",
    "const now = new Date().toISOString();",
    "const lock = {",
    "  pid: process.pid,",
    "  timestamp: now,",
    "  started_at: now,",
    "  started_by: process.env.WORKFLOW_STARTED_BY || 'cli',",
    "  run_id: `pipeline_${ts}`",
    "};",
    recordInstanceId
      ? "if (process.env.WORKFLOW_STARTED_BY_ID) { lock.started_by_id = process.env.WORKFLOW_STARTED_BY_ID; }"
      : "// раннер до 1.7.0 метку экземпляра не пишет",
    "fs.writeFileSync(path.join(logsDir, '.pipeline.lock'), JSON.stringify(lock, null, 2));",
    stderrEarly ? `process.stderr.write(${JSON.stringify(stderrEarly + '\n')});` : "// stderr молчит",
    "fs.writeFileSync(path.join(logsDir, `pipeline_${ts}.log`), '[start] pipeline\\n');",
    stderrLate
      ? `setTimeout(() => process.stderr.write(${JSON.stringify(stderrLate + '\n')}), 1200);`
      : "// позже тоже молчит",
    // Настоящий раннер живёт часами; подставной держится, пока вызывающий
    // читает lock, иначе pid успевает освободиться.
    "setTimeout(() => {}, 5000);",
  ].join('\n'));
  return bin;
}

describe('start_pipeline', () => {
  let workspaceDir;
  let projectPath;
  let originalCwd;
  let originalBin;

  beforeEach(() => {
    // Память живости общая на весь процесс, а Windows охотно переиспользует
    // номера: ответ про жертву прошлого теста иначе достаётся следующей.
    clearProcessAliveCache();
    originalCwd = process.cwd();
    originalBin = process.env.WORKFLOW_AI_BIN;
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-pipeline-'));
    projectPath = createProject(workspaceDir);
    process.env.MCP_CWD = workspaceDir;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    delete process.env.MCP_CWD;
    if (originalBin === undefined) delete process.env.WORKFLOW_AI_BIN;
    else process.env.WORKFLOW_AI_BIN = originalBin;
    try {
      process.chdir(originalCwd);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('отказывает для каталога без .workflow', async () => {
    const result = await start_pipeline.execute({ project: 'no-such-project' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_PROJECT');
  });

  it('не стартует поверх живого пайплайна', async () => {
    writeLock(projectPath, process.pid);

    const result = await start_pipeline.execute({ project: 'start-project' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ALREADY_RUNNING');
    expect(result.pid).toBe(process.pid);
  });

  it('живой процесс с нечитаемым временем старта сохраняет lock', async () => {
    // Живость определяет общий модуль (`health/pid-check.mjs`): на POSIX там
    // `EPERM` считается «жив» — процесс есть, просто не наш. Своя копия здесь
    // читала это как «номер свободен», и lock живого раннера снимался.
    //
    // Время старта у такого процесса ОС не отдаёт, поэтому проверка
    // переиспользования пропускается (fail-open). Ответ об этом говорит прямо,
    // а не утверждает «пайплайн идёт».
    const unreadablePid = 424242;
    vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation((pid) => pid === unreadablePid);

    try {
      writeLock(projectPath, unreadablePid);

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('ALREADY_RUNNING');
      expect(result.start_time_unknown).toBe(true);
      expect(result.hint).toMatch(/did not report its start time/);
      expect(fs.existsSync(path.join(projectPath, ...LOCK_REL))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('снимает протухший lock и запускается', async () => {
    writeLock(projectPath, DEAD_PID);
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

    const result = await start_pipeline.execute({ project: 'start-project' });

    expect(result.ok).toBe(true);
    expect(result.run_id).toMatch(/^pipeline_/);
    expect(result.pid).toBeGreaterThan(0);
    expect(fs.existsSync(result.log_path)).toBe(true);
  });

  it('возвращает run_id, pid, started_at и log_path', async () => {
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

    const result = await start_pipeline.execute({ project: 'start-project' });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      run_id: expect.stringMatching(/^pipeline_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/),
      pid: expect.any(Number),
      started_at: expect.any(String),
      log_path: expect.any(String)
    }));
  });

  it('помечает запуск своим: раннер кладёт метку экземпляра в lock', async () => {
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

    const result = await start_pipeline.execute({ project: 'start-project' });

    const lock = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.workflow', 'logs', '.pipeline.lock'),
      'utf8'
    ));

    // Единственный файл владения — сам lock. Своего файла сервер не пишет:
    // пара файлов про один запуск умела разойтись.
    expect(lock.started_by).toBe('mcp');
    expect(lock.started_by_id).toBe(mcpInstanceId(workspaceDir));
    expect(result.warning).toBeUndefined();
    expect(fs.existsSync(path.join(projectPath, '.workflow', 'logs', '.mcp-started-by'))).toBe(false);
  });

  it('раннер без метки экземпляра — предупреждение в ответе', async () => {
    // workflow-ai до 1.7.0. Такой запуск читается как чужой, и остановить его
    // получится только с force. Молчать нельзя: клиент узнал бы о потере
    // управления лишь в момент остановки.
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir, { recordInstanceId: false });

    const result = await start_pipeline.execute({ project: 'start-project' });

    expect(result.ok).toBe(true);
    expect(result.warning).toBe('RUNNER_WITHOUT_INSTANCE_ID');
    expect(result.hint).toMatch(/workflow-ai/);
  });

  it('отказывает, но не сносит lock с живым чужим pid', { timeout: 30000 }, async () => {
    // pid жив, но процесс стартовал позже записи lock'а — значит это не раннер,
    // а посторонний процесс, занявший номер. Сносить lock автоматически нельзя:
    // ошибёмся — поверх живого раннера встанет второй пайплайн.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeLock(projectPath, victim.pid, '2020-01-01T00:00:00.000Z');
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('STALE_PIPELINE_LOCK');
      expect(result.hint).toMatch(/\.pipeline\.lock/);
      // lock на месте: решение за человеком.
      expect(fs.existsSync(path.join(projectPath, ...LOCK_REL))).toBe(true);
    } finally {
      try { victim.kill(); } catch { /* мог завершиться */ }
    }
  });

  it('отказывает по ALREADY_RUNNING, когда lock свежий и pid жив', { timeout: 30000 }, async () => {
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      // lock записан ПОСЛЕ старта процесса — так делает настоящий раннер.
      writeLock(projectPath, victim.pid);
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('ALREADY_RUNNING');
      expect(result.pid).toBe(victim.pid);
    } finally {
      try { victim.kill(); } catch { /* мог завершиться */ }
    }
  });

  // Раннер, оборвавшийся 2026-09-30 (PulseProxy 18-55-50, ListeningGlass 18-53-24 и
  // 08-25-19), не оставил в логе ни строки о смерти, а его stderr уходил в 'ignore':
  // упавший раннер и жёстко снятый выглядели одинаково.
  describe('stderr раннера', () => {
    const logsOf = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('pipeline_') && n.endsWith('.log'));

    async function waitFor(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return predicate();
    }

    it('пишется в <run_id>.stderr рядом с логом, в том числе после возврата start_pipeline', { timeout: 30000 }, async () => {
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir, {
        stderrEarly: 'early: runner started',
        stderrLate: 'late: something went wrong'
      });

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(true);
      const logsDir = path.join(projectPath, '.workflow', 'logs');
      const expected = path.join(logsDir, `${result.run_id}.stderr`);
      expect(result.stderr_path).toBe(expected);

      // Поздняя запись идёт уже после переименования — в тот же файл.
      await waitFor(() => fs.existsSync(expected) && fs.readFileSync(expected, 'utf8').includes('late:'));
      const text = fs.readFileSync(expected, 'utf8');
      expect(text).toContain('early: runner started');
      expect(text).toContain('late: something went wrong');

      // Файл не должен сойти за лог запуска: по \`pipeline_*.log\` последний лог ищут
      // pipeline-state, детекторы health, get_pipeline_log и расширение VS Code.
      expect(logsOf(logsDir)).toEqual([`${result.run_id}.log`]);
      expect(fs.readdirSync(logsDir).filter((n) => n.startsWith('runner_'))).toEqual([]);
    });

    it('при падении раннера на старте отдаёт хвост stderr в ответе', { timeout: 30000 }, async () => {
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir, { crashWith: 'Error: bad pipeline.yaml at line 3' });

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('RUNNER_NO_LOG');
      expect(result.stderr_tail).toContain('Error: bad pipeline.yaml at line 3');
      expect(result.hint).toMatch(/stderr_tail/);
      expect(fs.readFileSync(result.stderr_path, 'utf8')).toContain('bad pipeline.yaml');
      expect(path.dirname(result.stderr_path)).toBe(path.join(projectPath, '.workflow', 'logs'));
    });

    it('перед новым запуском убирает пустые файлы stderr прошлых запусков, непустые оставляет', { timeout: 30000 }, async () => {
      const logsDir = path.join(projectPath, '.workflow', 'logs');
      fs.writeFileSync(path.join(logsDir, 'pipeline_2020-01-01_00-00-00.stderr'), '');
      fs.writeFileSync(path.join(logsDir, 'pipeline_2020-01-02_00-00-00.stderr'), 'Error: crashed\n');
      fs.writeFileSync(path.join(logsDir, 'pipeline_2020-01-01_00-00-00.log'), 'старый лог, пустой stderr не про него\n');
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

      const result = await start_pipeline.execute({ project: 'start-project' });

      expect(result.ok).toBe(true);
      const names = fs.readdirSync(logsDir);
      expect(names).not.toContain('pipeline_2020-01-01_00-00-00.stderr');
      expect(names).toContain('pipeline_2020-01-02_00-00-00.stderr');
      // Пустой stderr прошлого запуска убирают, а логи не трогают.
      expect(names).toContain('pipeline_2020-01-01_00-00-00.log');
    });

    it('не отказывает в запуске, если файл stderr завести нельзя', { timeout: 30000 }, async () => {
      process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);
      // Первый openSync в start_pipeline — файл stderr; пусть он откажет.
      vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });

      try {
        const result = await start_pipeline.execute({ project: 'start-project' });

        expect(result.ok).toBe(true);
        expect(result.stderr_path).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it('сообщает RUNNER_NOT_FOUND, если CLI не найден', async () => {
    process.env.WORKFLOW_AI_BIN = path.join(workspaceDir, 'missing', 'workflow.mjs');

    const result = await start_pipeline.execute({ project: 'start-project' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('RUNNER_NOT_FOUND');
  });

  it('принимает абсолютный путь проекта', async () => {
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

    const result = await start_pipeline.execute({ project: projectPath });

    expect(result.ok).toBe(true);
  });
});
