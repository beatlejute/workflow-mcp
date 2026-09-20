/**
 * `src/process/run-lock.mjs` — чтение lock'а раннера и проверка владения.
 *
 * Модуль служит единственной защитой от двух дорогих ошибок: послать сигнал
 * чужому пайплайну и послать сигнал постороннему процессу, занявшему
 * переиспользованный номер.
 *
 * С 3.0.0 источник владения один — сам lock. Прежде рядом лежал второй файл
 * (`.mcp-started-by`), и проверка сверяла два файла про один запуск; отсюда
 * росли `RUN_MISMATCH` на остатках прошлого прогона и расхождение
 * идентификаторов между писателем и читателем. Теперь сервер представляется
 * раннеру через `WORKFLOW_STARTED_BY_ID`, а раннер кладёт метку в lock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readPipelineLock, validateRunOwnership } from '../../src/process/run-lock.mjs';
import { clearProcessStartCache } from '../../src/process/process-start.mjs';

const INSTANCE = 'workflow-mcp@0123456789ab';
const LEGACY_INSTANCE = 'workflow-mcp@cafecafecafe';
const OTHER_INSTANCE = 'workflow-mcp@ffffffffffff';
/** Заведомо свободный номер: время старта у него не спросить. */
const DEAD_PID = 999999;

let projectRoot;

function logsDir() {
  return path.join(projectRoot, '.workflow', 'logs');
}

function writeLock(payload) {
  fs.writeFileSync(
    path.join(logsDir(), '.pipeline.lock'),
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  );
}

/** Lock нашего запуска. */
function ownLock(pid, extra = {}) {
  return {
    pid,
    started_at: new Date().toISOString(),
    started_by: 'mcp',
    started_by_id: INSTANCE,
    run_id: 'pipeline_2026-09-20_10-00-00',
    ...extra
  };
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-'));
  fs.mkdirSync(logsDir(), { recursive: true });
  clearProcessStartCache();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
});

describe('readPipelineLock', () => {
  it('отсутствие файла — это null, а не исключение', () => {
    expect(readPipelineLock(projectRoot)).toBeNull();
  });

  it('битый JSON — это null', () => {
    writeLock('{ это не json');
    expect(readPipelineLock(projectRoot)).toBeNull();
  });

  it('разбирает полный payload раннера', () => {
    writeLock({
      pid: 4242,
      timestamp: '2026-09-20T10:00:00.000Z',
      started_at: '2026-09-20T10:00:00.000Z',
      started_by: 'mcp',
      started_by_id: INSTANCE,
      run_id: 'pipeline_2026-09-20_10-00-00',
      pipeline_log: '.workflow/logs/pipeline_2026-09-20_10-00-00.log'
    });

    expect(readPipelineLock(projectRoot)).toEqual({
      pid: 4242,
      timestamp: '2026-09-20T10:00:00.000Z',
      started_at: '2026-09-20T10:00:00.000Z',
      started_by: 'mcp',
      started_by_id: INSTANCE,
      run_id: 'pipeline_2026-09-20_10-00-00'
    });
  });

  it('pid строкой приводится к числу', () => {
    writeLock({ pid: '777', timestamp: '2026-09-20T10:00:00.000Z' });
    expect(readPipelineLock(projectRoot).pid).toBe(777);
  });

  it.each([[0], [-1], ['не число'], [null]])('бессмысленный pid (%s) даёт null', (pid) => {
    writeLock({ pid, timestamp: '2026-09-20T10:00:00.000Z' });
    expect(readPipelineLock(projectRoot)).toBeNull();
  });

  it('старый lock без started_at подставляет timestamp', () => {
    // Раннер до 1.6.0 писал только `{pid, timestamp}`.
    writeLock({ pid: 4242, timestamp: '2026-09-20T10:00:00.000Z' });

    const lock = readPipelineLock(projectRoot);

    expect(lock.started_at).toBe('2026-09-20T10:00:00.000Z');
    expect(lock.started_by).toBeNull();
    expect(lock.run_id).toBeNull();
  });

  it('lock без полей времени берёт время записи самого файла', async () => {
    // Раннер до 1.5.2 времени не писал вовсе. Без запасного источника такой
    // lock проходил проверку переиспользованного номера молча: сверять не с
    // чем — значит не сверяем.
    const before = new Date();
    writeLock({ pid: 4242 });

    const lock = readPipelineLock(projectRoot);

    expect(lock.timestamp).toBeNull();
    expect(lock.started_at).not.toBeNull();
    const startedAt = new Date(lock.started_at).getTime();
    expect(startedAt).toBeGreaterThanOrEqual(before.getTime() - 2000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('время из файла работает и в проверке переиспользования', () => {
    // Процесс теста стартовал заведомо раньше, чем создан файл, — значит по
    // одному лишь времени он проверку проходит; важно, что она вообще идёт.
    writeLock({ pid: process.pid, started_by: 'mcp', started_by_id: INSTANCE });
    const lock = readPipelineLock(projectRoot);

    expect(validateRunOwnership(lock, process.pid, INSTANCE, { verifyProcessStart: true }).valid).toBe(true);

    // А теперь наоборот: файл «записан» задолго до старта процесса.
    fs.utimesSync(
      path.join(logsDir(), '.pipeline.lock'),
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z')
    );
    const ancient = readPipelineLock(projectRoot);

    expect(validateRunOwnership(ancient, process.pid, INSTANCE, { verifyProcessStart: true })).toEqual({
      valid: false,
      reason: 'PID_REUSED'
    });
  });

  it('lock раннера до 1.7.0 отдаёт started_by_id как null', () => {
    writeLock({ pid: 4242, timestamp: '2026-09-20T10:00:00.000Z', started_by: 'mcp' });
    expect(readPipelineLock(projectRoot).started_by_id).toBeNull();
  });

  it('пустые строки не выдаются за значения', () => {
    writeLock({ pid: 4242, timestamp: '', started_by: '', started_by_id: '', run_id: '' });

    const lock = readPipelineLock(projectRoot);

    expect(lock.timestamp).toBeNull();
    expect(lock.started_by).toBeNull();
    expect(lock.started_by_id).toBeNull();
    expect(lock.run_id).toBeNull();
  });
});

describe('validateRunOwnership', () => {
  it('без lock владения нет: запуска нет вовсе', () => {
    expect(validateRunOwnership(null, 4242, INSTANCE)).toEqual({
      valid: false,
      reason: 'NO_LOCK'
    });
  });

  it('свой lock подтверждает владение', () => {
    expect(validateRunOwnership(ownLock(4242), 4242, INSTANCE).valid).toBe(true);
  });

  it('lock с другим pid даёт PID_MISMATCH', () => {
    expect(validateRunOwnership(ownLock(4242), 9999, INSTANCE)).toEqual({
      valid: false,
      reason: 'PID_MISMATCH'
    });
  });

  it('аварийный ключ WORKFLOW_MCP_FORCE_FOREIGN снимает проверку целиком', () => {
    process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';
    const foreign = ownLock(4242, { started_by: 'cli', started_by_id: null });

    expect(validateRunOwnership(foreign, 4242, INSTANCE)).toEqual({ valid: true, override: true });
  });

  describe('признаки чужого запуска', () => {
    it.each([['cli'], ['extension']])('started_by=%s даёт STARTED_BY_MISMATCH', (startedBy) => {
      const lock = ownLock(4242, { started_by: startedBy });

      expect(validateRunOwnership(lock, 4242, INSTANCE)).toEqual({
        valid: false,
        reason: 'STARTED_BY_MISMATCH'
      });
    });

    it('отсутствие started_by — тоже чужой запуск', () => {
      // Раньше это считалось нашим: маркер лежал отдельно и «доказывал»
      // владение сам. Теперь единственное доказательство — сам lock, и
      // запуск без источника доказывает ровно ничего.
      const lock = ownLock(4242, { started_by: null });

      expect(validateRunOwnership(lock, 4242, INSTANCE)).toEqual({
        valid: false,
        reason: 'STARTED_BY_MISMATCH'
      });
    });
  });

  describe('метка экземпляра', () => {
    it('чужая метка даёт INSTANCE_MISMATCH', () => {
      const lock = ownLock(4242, { started_by_id: OTHER_INSTANCE });

      expect(validateRunOwnership(lock, 4242, INSTANCE)).toEqual({
        valid: false,
        reason: 'INSTANCE_MISMATCH'
      });
    });

    it('метки нет вовсе — INSTANCE_UNKNOWN, не INSTANCE_MISMATCH', () => {
      // Разные беды: первая чинится обновлением workflow-ai до 1.7.0, вторая
      // не чинится вовсе. Один код на оба случая увёл бы в неверную починку.
      const lock = ownLock(4242, { started_by_id: null });

      expect(validateRunOwnership(lock, 4242, INSTANCE)).toEqual({
        valid: false,
        reason: 'INSTANCE_UNKNOWN'
      });
    });

    it('принимается любая метка из списка: обновление посреди прогона', () => {
      const lock = ownLock(4242, { started_by_id: LEGACY_INSTANCE });

      expect(validateRunOwnership(lock, 4242, [INSTANCE, LEGACY_INSTANCE]).valid).toBe(true);
    });

    it('метка вне списка остаётся чужой', () => {
      const lock = ownLock(4242, { started_by_id: OTHER_INSTANCE });

      expect(validateRunOwnership(lock, 4242, [INSTANCE, LEGACY_INSTANCE]).valid).toBe(false);
    });
  });

  describe('проверка времени старта процесса', () => {
    it('по умолчанию не выполняется — это дорогой внешний вызов', () => {
      // Свой процесс стартовал заведомо позже древнего lock'а, но без явного
      // флага владение подтверждается.
      const lock = ownLock(process.pid, { started_at: '2020-01-01T00:00:00.000Z' });

      expect(validateRunOwnership(lock, process.pid, INSTANCE).valid).toBe(true);
    });

    it('с флагом переиспользованный pid даёт PID_REUSED', () => {
      const lock = ownLock(process.pid, { started_at: '2020-01-01T00:00:00.000Z' });

      expect(
        validateRunOwnership(lock, process.pid, INSTANCE, { verifyProcessStart: true })
      ).toEqual({ valid: false, reason: 'PID_REUSED' });
    });

    it('свежий lock проверку проходит', () => {
      const lock = ownLock(process.pid);

      expect(
        validateRunOwnership(lock, process.pid, INSTANCE, { verifyProcessStart: true }).valid
      ).toBe(true);
    });

    it('если время старта узнать нельзя, отказа не происходит', () => {
      // Осознанный fail-open: запрет управлять своим пайплайном из-за
      // недоступной системной утилиты хуже остаточного риска.
      const lock = ownLock(DEAD_PID, { started_at: '2020-01-01T00:00:00.000Z' });

      expect(
        validateRunOwnership(lock, DEAD_PID, INSTANCE, { verifyProcessStart: true }).valid
      ).toBe(true);
    });
  });

  it('порядок проверок: чужой запуск важнее переиспользованного pid', () => {
    // Оба признака сразу. Сообщать надо про чужой запуск: подсказка
    // «удалите lock» для чужого пайплайна была бы вредным советом.
    const lock = ownLock(process.pid, {
      started_at: '2020-01-01T00:00:00.000Z',
      started_by: 'cli'
    });

    expect(
      validateRunOwnership(lock, process.pid, INSTANCE, { verifyProcessStart: true }).reason
    ).toBe('STARTED_BY_MISMATCH');
  });

  it('порядок проверок: неизвестная метка важнее переиспользованного pid', () => {
    const lock = ownLock(process.pid, {
      started_at: '2020-01-01T00:00:00.000Z',
      started_by_id: null
    });

    expect(
      validateRunOwnership(lock, process.pid, INSTANCE, { verifyProcessStart: true }).reason
    ).toBe('INSTANCE_UNKNOWN');
  });
});
