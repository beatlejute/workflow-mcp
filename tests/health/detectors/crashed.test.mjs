/**
 * Детектор упавшего пайплайна.
 *
 * Фикстуры переведены с `.runner-pids` на `.workflow/logs/.pipeline.lock`.
 * Прежние воспроизводили контракт, которого нет: `.runner-pids` не пишет ни
 * раннер, ни сервер, ни расширение, поэтому детектор не срабатывал ни разу,
 * а тесты были зелёными. Прогон всегда один — lock держит синглтон, — поэтому
 * случаи «несколько pid, часть мертва» исчезли вместе с файлом.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectCrashed } from '../../../src/health/detectors/crashed.mjs';
import * as pidCheck from '../../../src/health/pid-check.mjs';
import { writeRunnerLock, writeBrokenLock } from '../../helpers/pipeline-lock.mjs';

describe('detectCrashed (tests/health/detectors/crashed.test.mjs)', () => {
  const DEAD_PID = 999999999;

  let testDir;
  let projectPath;
  let logsDir;

  /** Помечает pid мёртвым, остальные — живыми. */
  function killPid(pid = DEAD_PID) {
    vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(p => p !== pid);
  }

  /** Лог прогона с заданным возрастом в секундах. */
  function writeLog(name, ageSec = 0) {
    const logPath = path.join(logsDir, name);
    fs.writeFileSync(logPath, 'test log', 'utf8');
    if (ageSec > 0) {
      const when = (Date.now() - ageSec * 1000) / 1000;
      fs.utimesSync(logPath, when, when);
    }
    return logPath;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashed-detector-test-'));
    projectPath = testDir;
    logsDir = path.join(projectPath, '.workflow', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe('Basic functionality', () => {
    it('should return null when lock раннера отсутствует', () => {
      writeLog('pipeline_test-run-1.log');
      expect(detectCrashed(projectPath, {})).toBeNull();
    });

    it.each([['empty'], ['garbage'], ['no-pid'], ['bad-pid']])(
      'should return null when lock испорчен (%s)',
      (kind) => {
        // По мусору нельзя утверждать, что процесс умер: pid неизвестен.
        writeBrokenLock(projectPath, kind);
        writeLog('pipeline_test-run-1.log');
        killPid();

        expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 })).toBeNull();
      }
    );

    it('should return null when pid раннера жив', () => {
      writeRunnerLock(projectPath, process.pid);
      writeLog('pipeline_test-run-1.log');

      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 })).toBeNull();
    });
  });

  describe('Dead PID detection', () => {
    it('should return alert for dead PID with fresh log', () => {
      writeRunnerLock(projectPath, DEAD_PID, { run_id: 'test-run-1' });
      writeLog('pipeline_test-run-1.log');
      killPid();

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result).not.toBeNull();
      expect(result.type).toBe('crashed');
      expect(result.severity).toBe('critical');
      expect(result.pid).toBe(DEAD_PID);
      expect(result.run_id).toBe('test-run-1');
      expect(result.fingerprint).toContain('crashed');
      expect(result.fingerprint).toContain(String(DEAD_PID));
      expect(result.message).toContain(String(DEAD_PID));
      expect(result.suggested_actions).toEqual(['get_pipeline_log', 'restart_pipeline']);
    });

    it('should return null for dead PID with stale log (old mtime)', () => {
      // Lock переживает конец прогона на доли секунды. Без проверки свежести
      // каждый нормально завершившийся пайплайн выглядел бы крахом.
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log', 120);
      killPid();

      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 })).toBeNull();
    });

    it('should return null when no pipeline logs exist', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      killPid();

      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 })).toBeNull();
    });

    // Случая «каталог логов не читается» здесь нет намеренно: lock лежит в том
    // же каталоге, поэтому его исчезновение означает исчезновение lock'а, и
    // детектор выходит раньше — на `!lock`. Прежний вариант этого теста
    // выглядел проверкой `catch` вокруг `readdirSync`, а на деле не доходил
    // до него ни разу.
  });

  describe('Configuration handling', () => {
    it('should use default freshness (60 sec) when not specified', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log', 30);
      killPid();

      expect(detectCrashed(projectPath, {})).not.toBeNull();
    });

    it('should treat log older than default freshness as stale', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log', 90);
      killPid();

      expect(detectCrashed(projectPath, {})).toBeNull();
    });

    it('should respect custom crash_mtime_freshness_sec configuration', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log', 90);
      killPid();

      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 300 })).not.toBeNull();
      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 30 })).toBeNull();
    });
  });

  describe('Log file handling', () => {
    it('should find most recent log when multiple exist', () => {
      // Свежесть считается по самому новому логу: старые прогоны проекта не
      // должны глушить алерт по текущему.
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_old-run.log', 600);
      writeLog('pipeline_new-run.log');
      killPid();

      expect(detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 })).not.toBeNull();
    });

    it('should take run_id from the newest log when lock не содержит его', () => {
      writeRunnerLock(projectPath, DEAD_PID, { run_id: null });
      writeLog('pipeline_old-run.log', 600);
      writeLog('pipeline_new-run.log');
      killPid();

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result.run_id).toBe('new-run');
    });

    it('should prefer run_id from lock over log file name', () => {
      // Лог может остаться от прошлого прогона: имя файла — запасной источник.
      writeRunnerLock(projectPath, DEAD_PID, { run_id: 'run-from-lock' });
      writeLog('pipeline_run-from-file.log');
      killPid();

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result.run_id).toBe('run-from-lock');
    });
  });

  describe('Alert object properties', () => {
    it('should include detected_at timestamp in alert', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log');
      killPid();

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result.detected_at).toBeDefined();
      expect(new Date(result.detected_at).toISOString()).toBe(result.detected_at);
    });

    it('should include project name in fingerprint and alert', () => {
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log');
      killPid();

      const projectName = path.basename(projectPath);
      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });

      expect(result.project).toBe(projectName);
      expect(result.fingerprint).toBe(`crashed:${projectName}:${DEAD_PID}`);
    });
  });

  describe('Windows platform support', () => {
    it('should work with Windows-specific isProcessAlive behavior (mocked)', () => {
      // На Windows проверка pid уходит в `tasklist`; детектор про это не знает
      // и обязан верить ответу `isProcessAlive`.
      writeRunnerLock(projectPath, DEAD_PID);
      writeLog('pipeline_test-run-1.log');
      vi.spyOn(pidCheck, 'isProcessAlive').mockReturnValue(false);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result).not.toBeNull();
      expect(result.pid).toBe(DEAD_PID);
    });
  });

  describe('Edge cases', () => {
    it('should handle very large PID numbers', () => {
      const bigPid = 4294967295;
      writeRunnerLock(projectPath, bigPid);
      writeLog('pipeline_test-run-1.log');
      killPid(bigPid);

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result.pid).toBe(bigPid);
    });

    it('should accept pid записанный строкой', () => {
      // Раннер пишет число, но формат lock'а общий с другими реализациями:
      // `readPipelineLock` приводит строку к числу, детектор получает число.
      writeRunnerLock(projectPath, String(DEAD_PID));
      writeLog('pipeline_test-run-1.log');
      killPid();

      const result = detectCrashed(projectPath, { crash_mtime_freshness_sec: 60 });
      expect(result.pid).toBe(DEAD_PID);
    });
  });
});
