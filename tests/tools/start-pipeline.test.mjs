/**
 * start_pipeline: реальный запуск раннера workflow-ai detached-процессом.
 *
 * Синглтон держит сам раннер через .pipeline.lock (workflow-ai PLAN-011),
 * поэтому здесь проверяем контракт tool'а: валидацию проекта, отказ при живом
 * запуске, снятие протухшего lock и формат ответа.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { start_pipeline } from '../../src/tools/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** PID, которого заведомо нет в системе. */
const DEAD_PID = 999999;

const LOCK_REL = ['.workflow', 'logs', '.pipeline.lock'];

function createProject(workspaceDir, name = 'start-project') {
  const projectPath = path.join(workspaceDir, name);
  fs.mkdirSync(path.join(projectPath, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.workflow', 'config'), { recursive: true });
  return projectPath;
}

function writeLock(projectPath, pid) {
  fs.writeFileSync(
    path.join(projectPath, ...LOCK_REL),
    JSON.stringify({ pid, timestamp: new Date().toISOString() }, null, 2)
  );
}

/**
 * Подставной «раннер»: пишет лог в формате pipeline_<ts>.log и завершается.
 * Позволяет проверить контракт start_pipeline, не гоняя настоящий пайплайн.
 */
function writeFakeRunner(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'workflow.mjs');
  fs.writeFileSync(bin, [
    "import fs from 'fs';",
    "import path from 'path';",
    "const argv = process.argv.slice(2);",
    "const projectRoot = argv[argv.indexOf('--project') + 1];",
    "const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);",
    "const logsDir = path.join(projectRoot, '.workflow', 'logs');",
    "fs.mkdirSync(logsDir, { recursive: true });",
    "fs.writeFileSync(path.join(logsDir, `pipeline_${ts}.log`), '[start] pipeline\\n');",
  ].join('\n'));
  return bin;
}

describe('start_pipeline', () => {
  let workspaceDir;
  let projectPath;
  let originalCwd;
  let originalBin;

  beforeEach(() => {
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

  it('помечает запуск своим маркером владения', async () => {
    process.env.WORKFLOW_AI_BIN = writeFakeRunner(workspaceDir);

    const result = await start_pipeline.execute({ project: 'start-project' });

    const marker = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.workflow', 'logs', '.mcp-started-by'),
      'utf8'
    ));

    expect(marker.pid).toBe(result.pid);
    expect(marker.run_id).toBe(result.run_id);
    expect(marker.version).toBe(1);
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
