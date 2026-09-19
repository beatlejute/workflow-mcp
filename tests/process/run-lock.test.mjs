/**
 * `src/process/run-lock.mjs` — чтение lock'а раннера и проверка владения.
 *
 * Модуль реализует контракт FIX-002 и служит единственной защитой от двух
 * дорогих ошибок: послать сигнал чужому пайплайну и послать сигнал постороннему
 * процессу, занявшему переиспользованный номер. Собственного теста у него не
 * было — поведение проверялось только косвенно, через интеграционные сценарии,
 * где перепутать причину отказа с её следствием очень легко.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readPipelineLock, safeReadMarker, validateRunOwnership } from '../../src/process/run-lock.mjs';

const INSTANCE = 'workflow-mcp@0123456789ab';
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

function writeMarker(payload) {
  fs.writeFileSync(
    path.join(logsDir(), '.mcp-started-by'),
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  );
}

/** Валидный маркер нашего экземпляра. */
function ownMarker(pid, extra = {}) {
  return {
    version: 1,
    mcp_instance_id: INSTANCE,
    started_at: new Date().toISOString(),
    pid,
    ...extra
  };
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-'));
  fs.mkdirSync(logsDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
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
      run_id: 'pipeline_2026-09-20_10-00-00',
      pipeline_log: '.workflow/logs/pipeline_2026-09-20_10-00-00.log'
    });

    expect(readPipelineLock(projectRoot)).toEqual({
      pid: 4242,
      timestamp: '2026-09-20T10:00:00.000Z',
      started_at: '2026-09-20T10:00:00.000Z',
      started_by: 'mcp',
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

  it('пустые строки не выдаются за значения', () => {
    writeLock({ pid: 4242, timestamp: '', started_by: '', run_id: '' });

    const lock = readPipelineLock(projectRoot);

    expect(lock.timestamp).toBeNull();
    expect(lock.started_by).toBeNull();
    expect(lock.run_id).toBeNull();
  });
});

describe('safeReadMarker', () => {
  it('битый маркер не роняет вызывающего', () => {
    writeMarker('{ сломано');
    expect(safeReadMarker(projectRoot)).toBeNull();
  });

  it('отсутствующий маркер — null', () => {
    expect(safeReadMarker(projectRoot)).toBeNull();
  });

  it('валидный маркер читается', () => {
    writeMarker(ownMarker(4242));
    expect(safeReadMarker(projectRoot).pid).toBe(4242);
  });
});

describe('validateRunOwnership', () => {
  it('без маркера владение не подтверждается', () => {
    const result = validateRunOwnership(projectRoot, 4242, null, INSTANCE);
    expect(result.valid).toBe(false);
  });

  it('свой маркер без lock подтверждает владение', () => {
    writeMarker(ownMarker(4242));
    expect(validateRunOwnership(projectRoot, 4242, null, INSTANCE).valid).toBe(true);
  });

  it('чужой идентификатор экземпляра владение не даёт', () => {
    writeMarker(ownMarker(4242, { mcp_instance_id: OTHER_INSTANCE }));
    expect(validateRunOwnership(projectRoot, 4242, null, INSTANCE).valid).toBe(false);
  });

  it('маркер с другим pid владение не даёт', () => {
    writeMarker(ownMarker(4242));
    expect(validateRunOwnership(projectRoot, 9999, null, INSTANCE).valid).toBe(false);
  });

  describe('признаки чужого запуска в lock', () => {
    beforeEach(() => writeMarker(ownMarker(4242)));

    it.each([['cli'], ['extension']])('started_by=%s даёт STARTED_BY_MISMATCH', (startedBy) => {
      const lock = { pid: 4242, started_at: null, started_by: startedBy, run_id: null };

      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE)).toEqual({
        valid: false,
        reason: 'STARTED_BY_MISMATCH'
      });
    });

    it('started_by=mcp владению не мешает', () => {
      const lock = { pid: 4242, started_at: null, started_by: 'mcp', run_id: null };
      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE).valid).toBe(true);
    });

    it('отсутствие started_by владению не мешает', () => {
      const lock = { pid: 4242, started_at: null, started_by: null, run_id: null };
      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE).valid).toBe(true);
    });
  });

  describe('сверка запуска по run_id', () => {
    it('разные run_id дают RUN_MISMATCH', () => {
      writeMarker(ownMarker(4242, { run_id: 'pipeline_2026-09-20_09-00-00' }));
      const lock = {
        pid: 4242,
        started_at: null,
        started_by: 'mcp',
        run_id: 'pipeline_2026-09-20_10-00-00'
      };

      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE)).toEqual({
        valid: false,
        reason: 'RUN_MISMATCH'
      });
    });

    it('совпадающие run_id владение подтверждают', () => {
      const runId = 'pipeline_2026-09-20_10-00-00';
      writeMarker(ownMarker(4242, { run_id: runId }));
      const lock = { pid: 4242, started_at: null, started_by: 'mcp', run_id: runId };

      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE).valid).toBe(true);
    });

    it('run_id только с одной стороны сверку не включает', () => {
      writeMarker(ownMarker(4242));
      const lock = { pid: 4242, started_at: null, started_by: 'mcp', run_id: 'pipeline_X' };

      expect(validateRunOwnership(projectRoot, 4242, lock, INSTANCE).valid).toBe(true);
    });
  });

  describe('проверка времени старта процесса', () => {
    it('по умолчанию не выполняется — это дорогой внешний вызов', () => {
      // Свой процесс стартовал заведомо позже древнего lock'а, но без
      // явного флага владение подтверждается: список пайплайнов не должен
      // ради каждого проекта спрашивать ОС.
      writeMarker(ownMarker(process.pid));
      const lock = {
        pid: process.pid,
        started_at: '2020-01-01T00:00:00.000Z',
        started_by: 'mcp',
        run_id: null
      };

      expect(validateRunOwnership(projectRoot, process.pid, lock, INSTANCE).valid).toBe(true);
    });

    it('с флагом переиспользованный pid даёт PID_REUSED', () => {
      writeMarker(ownMarker(process.pid));
      const lock = {
        pid: process.pid,
        started_at: '2020-01-01T00:00:00.000Z',
        started_by: 'mcp',
        run_id: null
      };

      expect(
        validateRunOwnership(projectRoot, process.pid, lock, INSTANCE, { verifyProcessStart: true })
      ).toEqual({ valid: false, reason: 'PID_REUSED' });
    });

    it('свежий lock проверку проходит', () => {
      writeMarker(ownMarker(process.pid));
      const lock = {
        pid: process.pid,
        started_at: new Date().toISOString(),
        started_by: 'mcp',
        run_id: null
      };

      expect(
        validateRunOwnership(projectRoot, process.pid, lock, INSTANCE, { verifyProcessStart: true }).valid
      ).toBe(true);
    });

    it('без lock проверка идёт по времени из маркера', () => {
      // Эта ветка — единственная защита, когда lock уже снят: иначе всё
      // свелось бы к равенству pid.
      writeMarker(ownMarker(process.pid, { started_at: '2020-01-01T00:00:00.000Z' }));

      expect(
        validateRunOwnership(projectRoot, process.pid, null, INSTANCE, { verifyProcessStart: true })
      ).toEqual({ valid: false, reason: 'PID_REUSED' });
    });

    it('если время старта узнать нельзя, отказа не происходит', () => {
      // Осознанный fail-open: запрет управлять своим пайплайном из-за
      // недоступной системной утилиты хуже остаточного риска.
      writeMarker(ownMarker(DEAD_PID));
      const lock = {
        pid: DEAD_PID,
        started_at: '2020-01-01T00:00:00.000Z',
        started_by: 'mcp',
        run_id: null
      };

      expect(
        validateRunOwnership(projectRoot, DEAD_PID, lock, INSTANCE, { verifyProcessStart: true }).valid
      ).toBe(true);
    });
  });

  it('порядок проверок: чужой запуск важнее переиспользованного pid', () => {
    // Оба признака сразу. Сообщать надо про чужой запуск: подсказка
    // «удалите lock» для чужого пайплайна была бы вредным советом.
    writeMarker(ownMarker(process.pid));
    const lock = {
      pid: process.pid,
      started_at: '2020-01-01T00:00:00.000Z',
      started_by: 'cli',
      run_id: null
    };

    expect(
      validateRunOwnership(projectRoot, process.pid, lock, INSTANCE, { verifyProcessStart: true }).reason
    ).toBe('STARTED_BY_MISMATCH');
  });
});
