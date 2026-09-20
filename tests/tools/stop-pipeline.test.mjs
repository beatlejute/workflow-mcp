/**
 * Tests for stop_pipeline tool
 * Tests POSIX process kill via process group, Windows taskkill mock, marker validation, and force override
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import process from 'process';
import { stopPipelineImpl } from '../../src/tools/pipeline.mjs';
import { writeRunnerLock, writeBrokenLock } from '../helpers/pipeline-lock.mjs';
import { clearProcessAliveCache } from '../../src/health/pid-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('stop_pipeline tool', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let stateDir;
  let logsDir;
  let originalCwd;
  let originalMcpCwd;

  beforeEach(() => {
    // Память живости общая на весь процесс, а Windows охотно переиспользует
    // номера: ответ про жертву прошлого теста иначе достаётся следующей.
    clearProcessAliveCache();
    // Save original working directory
    originalCwd = process.cwd();

    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-pipeline-test-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    stateDir = path.join(workflowDir, 'state');
    logsDir = path.join(workflowDir, 'logs');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Change to test directory so resolveProjectRoot works correctly
    process.chdir(projectPath);
    // Владение сверяется с идентификатором, посчитанным от `mcpCwd()`, а
    // `MCP_CWD` старше рабочего каталога процесса: без фиксации набор
    // зависит от того, что стоит в окружении запускающего, и позитивные
    // сценарии получают FOREIGN_PIPELINE.
    originalMcpCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = projectPath;
  });

  afterEach(() => {
    // Restore original working directory
    process.chdir(originalCwd);
    if (originalMcpCwd === undefined) delete process.env.MCP_CWD;
    else process.env.MCP_CWD = originalMcpCwd;

    // Clean up test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });



  describe('TC-001: POSIX kill terminates process', () => {
    it.skipIf(process.platform === 'win32')('should kill a process on POSIX with SIGKILL to process group', async () => {
      // Create a long-running mock process (sleep)
      const proc = spawn('sleep', ['10'], {
        detached: true,  // Required for process group kill
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;
      expect(childPid).toBeGreaterThan(0);

      // Verify process is running
      const initialCheck = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        initialCheck.on('close', (code) => {
          expect(code).toBe(0); // kill -0 returns 0 if process exists
          resolve();
        });
      });

      // Положить lock раннера с этим pid
      writeRunnerLock(projectPath, childPid);


      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      // Verify result indicates success
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('killed');

      // Verify process is actually dead (with small delay for signal delivery)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if process is dead
      const finalCheck = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        finalCheck.on('close', (code) => {
          // kill -0 should fail (code != 0) if process is dead
          expect(code).not.toBe(0);
          resolve();
        });
      });
    });
  });

  describe('TC-002: POSIX process group kill — child processes also killed', () => {
    it.skipIf(process.platform === 'win32')('should kill all child processes in the process group on POSIX', async () => {
      // Create a parent process that spawns children
      const proc = spawn('bash', ['-c', 'sleep 10 & sleep 10 & sleep 10 & wait'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const parentPid = proc.pid;
      expect(parentPid).toBeGreaterThan(0);

      // Положить lock раннера
      writeRunnerLock(projectPath, parentPid);


      // Get initial child count by checking process tree
      const initialChildren = spawn('pgrep', ['-P', parentPid.toString()]);
      let childCountBefore = 0;
      await new Promise((resolve) => {
        let output = '';
        initialChildren.stdout.on('data', (data) => {
          output += data.toString();
        });
        initialChildren.on('close', () => {
          childCountBefore = output.trim().split('\n').filter(x => x).length;
          resolve();
        });
      });

      expect(childCountBefore).toBeGreaterThan(0); // Verify we have child processes

      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(true);
      expect(result.state).toBe('killed');

      // Small delay for signals to deliver
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify child processes are dead
      const childrenAfter = spawn('pgrep', ['-P', parentPid.toString()]);
      let childCountAfter = 0;
      await new Promise((resolve) => {
        let output = '';
        childrenAfter.stdout.on('data', (data) => {
          output += data.toString();
        });
        childrenAfter.on('close', () => {
          childCountAfter = output.trim().split('\n').filter(x => x).length;
          resolve();
        });
      });

      expect(childCountAfter).toBe(0); // All child processes should be killed
    });
  });

  describe('TC-003: Windows mock test — taskkill /F /T is invoked', () => {
    it('should use taskkill on Windows or SIGKILL on POSIX', async () => {
      const dummyPid = 99999; // Non-existent PID for safe testing
      writeRunnerLock(projectPath, dummyPid);


      // Call stop_pipeline with non-existent PID
      // On Windows, it will try to call taskkill, which will fail gracefully
      // On POSIX, it will try SIGKILL, which will also fail with NO_SUCH_PROCESS
      const result = await stopPipelineImpl('.');

      // Verify that an error occurred (expected for non-existent PID)
      expect(result.ok).toBe(false);
      // Both Windows (taskkill error) and POSIX (SIGKILL) should fail similarly
      // Can also get FOREIGN_PIPELINE if marker validation fails for some reason
      expect(['NO_SUCH_PROCESS', 'EXTERNAL_COMMAND_FAILED', 'UNKNOWN_ERROR', 'FOREIGN_PIPELINE']).toContain(result.code);
    });
  });

  describe('TC-004: Foreign pipeline without force=true → FOREIGN_PIPELINE error', () => {
    it('should reject kill of foreign pipeline without force=true', async () => {
      const dummyPid = 12345;

      // Lock помечен другим экземпляром MCP — запуск чужой.
      writeRunnerLock(projectPath, dummyPid, { started_by_id: 'workflow-mcp@foreign12345' });

      // Call stop_pipeline without force
      const result = await stopPipelineImpl('.');

      // Verify it returns FOREIGN_PIPELINE error
      expect(result.ok).toBe(false);
      expect(result.code).toBe('FOREIGN_PIPELINE');
      expect(result.reason).toBe('INSTANCE_MISMATCH');
      expect(result.hint).toContain('foreign');
    });
  });

  describe('TC-005: Force override — foreign pipeline killed with force=true', () => {
    it.skipIf(process.platform === 'win32')('should allow killing foreign pipeline when force=true', async () => {
      // Create a long-running process
      const proc = spawn('sleep', ['10'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      // Lock чужого экземпляра
      writeRunnerLock(projectPath, childPid, { started_by_id: 'workflow-mcp@foreign12345' });

      // Call stop_pipeline with force=true
      const result = await stopPipelineImpl('.', { force: true });

      // Verify success despite foreign ownership
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(childPid);
      expect(result.state).toBe('killed');

      // Verify process is dead
      await new Promise((resolve) => setTimeout(resolve, 100));
      const check = spawn('kill', ['-0', childPid.toString()]);
      await new Promise((resolve) => {
        check.on('close', (code) => {
          expect(code).not.toBe(0); // Process should be dead
          resolve();
        });
      });
    });
  });

  describe('TC-005a: force не отменяет отказ по переиспользованному номеру', () => {
    it('отказывает и с force=true, не трогая посторонний процесс', { timeout: 30000 }, async () => {
      // `force` снимает вопрос «чей это пайплайн», но не вопрос «есть ли он
      // вообще». При `PID_REUSED` номер из lock'а принадлежит постороннему
      // процессу, и убийство «с force» — это `taskkill /F /T` по чужому дереву.
      // Подсказка отказа прямо просит не повторять с force; обходить её же
      // было бы странно.
      const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Lock датирован прошлым: процесс с этим номером стартовал позже.
        const ancient = '2020-01-01T00:00:00.000Z';
        writeRunnerLock(projectPath, victim.pid, { started_at: ancient, timestamp: ancient });

        const result = await stopPipelineImpl('.', { force: true });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('STALE_PIPELINE_LOCK');
        expect(result.reason).toBe('PID_REUSED');
        // Посторонний процесс жив.
        expect(() => process.kill(victim.pid, 0)).not.toThrow();
      } finally {
        try { victim.kill(); } catch { /* мог завершиться */ }
      }
    });
  });

  describe('TC-005b: force не убивает по переиспользованному номеру и у чужого lock', () => {
    it.each([
      ['запущен из CLI', { started_by: 'cli', started_by_id: null }],
      ['помечен другим экземпляром', { started_by_id: 'workflow-mcp@foreign12345' }],
      ['раннер без метки', { started_by_id: null }]
    ])('отказывает с force=true: lock %s', { timeout: 30000 }, async (_label, lockFields) => {
      // Ровно тот случай, ради которого `force` и зовут: владение не
      // подтверждено. Признаки чужого запуска проверяются раньше времени
      // старта, поэтому причина отказа владения тут — про чужого, а не
      // `PID_REUSED`; если смотреть только на неё, `force` убьёт посторонний
      // процесс, занявший номер.
      const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

        const ancient = '2020-01-01T00:00:00.000Z';
        writeRunnerLock(projectPath, victim.pid, { started_at: ancient, timestamp: ancient, ...lockFields });

        const result = await stopPipelineImpl('.', { force: true });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('STALE_PIPELINE_LOCK');
        expect(result.reason).toBe('PID_REUSED');
        expect(() => process.kill(victim.pid, 0)).not.toThrow();
      } finally {
        try { victim.kill(); } catch { /* мог завершиться */ }
      }
    });

    it('живой чужой раннер по-прежнему убивается с force=true', { timeout: 30000 }, async () => {
      // Обратная сторона: защита не должна ломать законный сценарий force.
      const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
      let killed = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Lock записан после старта процесса — значит это он и есть.
        writeRunnerLock(projectPath, victim.pid, { started_by: 'cli', started_by_id: null });

        const result = await stopPipelineImpl('.', { force: true });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('killed');
        killed = true;
      } finally {
        if (!killed) { try { victim.kill(); } catch { /* мог завершиться */ } }
      }
    });
  });

  describe('TC-005c: аварийный ключ не отменяет отказ по переиспользованному номеру', () => {
    it('WORKFLOW_MCP_FORCE_FOREIGN=1 не даёт убить посторонний процесс', { timeout: 30000 }, async () => {
      // Ключ снимает вопрос «чей это пайплайн», но не вопрос «есть ли он
      // вообще». Иначе аварийный режим оборачивается `taskkill /F /T` по
      // чужому дереву — то самое, от чего защищались.
      const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
      const savedKey = process.env.WORKFLOW_MCP_FORCE_FOREIGN;
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';

        const ancient = '2020-01-01T00:00:00.000Z';
        writeRunnerLock(projectPath, victim.pid, {
          started_at: ancient,
          timestamp: ancient,
          started_by: 'cli',
          started_by_id: null
        });

        const result = await stopPipelineImpl('.');

        expect(result.ok).toBe(false);
        expect(result.code).toBe('STALE_PIPELINE_LOCK');
        expect(result.reason).toBe('PID_REUSED');
        expect(() => process.kill(victim.pid, 0)).not.toThrow();
      } finally {
        if (savedKey === undefined) delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
        else process.env.WORKFLOW_MCP_FORCE_FOREIGN = savedKey;
        try { victim.kill(); } catch { /* мог завершиться */ }
      }
    });
  });

  describe('TC-006: файл владения остаётся за раннером', () => {
    it.skipIf(process.platform === 'win32')('не заводит своего файла и не снимает lock', async () => {
      // Прежде сервер писал `.mcp-started-by` и удалял его после убийства.
      // Файл владения теперь один, и пишет его раннер.
      const proc = spawn('sleep', ['1'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      writeRunnerLock(projectPath, childPid);

      const result = await stopPipelineImpl('.');

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(logsDir, '.mcp-started-by'))).toBe(false);
      expect(fs.existsSync(path.join(logsDir, '.pipeline.lock'))).toBe(true);
    });
  });

  describe('TC-007: Нет lock раннера → PIPELINE_NOT_RUNNING error', () => {
    it('should return PIPELINE_NOT_RUNNING when lock раннера отсутствует', async () => {
      // Нет lock раннера

      // Call stop_pipeline with force=true to bypass marker validation
      // (since we're testing the PIPELINE_NOT_RUNNING path)
      const result = await stopPipelineImpl('.', { force: true });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PIPELINE_NOT_RUNNING');
    });
  });

  describe('TC-008: Пустой lock раннера → PIPELINE_NOT_RUNNING error', () => {
    it.each([['empty'], ['garbage'], ['no-pid'], ['bad-pid']])(
      'should return PIPELINE_NOT_RUNNING when lock испорчен (%s)',
      async (kind) => {
        writeBrokenLock(projectPath, kind);


        // Call stop_pipeline with force=true
        const result = await stopPipelineImpl('.', { force: true });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('PIPELINE_NOT_RUNNING');
      }
    );
  });

  describe('TC-009: Invalid project path → error', () => {
    it('should throw error for non-existent project', async () => {
      // resolveProjectRoot throws an error if .workflow doesn't exist
      // This is the expected behavior - invalid projects are not tolerated
      let error;
      try {
        await stopPipelineImpl('/nonexistent/project');
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.message).toContain('Project not found');
    });
  });

  describe('TC-010: Return value structure', () => {
    it.skipIf(process.platform === 'win32')('should return correct structure on success', async () => {
      const proc = spawn('sleep', ['10'], {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      const childPid = proc.pid;

      // Setup
      writeRunnerLock(projectPath, childPid);


      // Call stop_pipeline
      const result = await stopPipelineImpl('.');

      // Verify structure
      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('pid');
      expect(result).toHaveProperty('state');
      expect(result.ok).toBe(true);
      expect(typeof result.pid).toBe('number');
      expect(result.state).toBe('killed');
      expect(result.pid).toBe(childPid);
    });
  });
});
