/**
 * Ответ `abort` на отказ от эскалации — на настоящем `control.abort`.
 *
 * Отображение вердикта `can_escalate` в ответ жило без теста: инструментальные
 * наборы мокают `control.abort` целиком, и форму ответа в них «доказывал» сам
 * мок. Из-за этого в README попало неверное описание: будто при
 * переиспользованном номере приходит `escalated: false`, тогда как ответ был
 * `OWNERSHIP_LOST`.
 *
 * Большинство случаев проверяет настоящий `abort` на отдельном дочернем
 * процессе. Для `IDENTITY_UNKNOWN` транспорт подменён, чтобы проверить POSIX и
 * Windows без ожидания запуска процесса и без отправки реальных сигналов.
 * Процессный контроль здесь изолирован от pipeline state.
 *
 * Разбор отказа самой утилиты — в `abort-force-path.test.mjs`: там подменяется
 * запуск, потому что исход `taskkill` зависит от локали системы и прав.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import process from 'node:process';

import { abort, setExternalRunnerForTests } from '../../src/process/control.mjs';

let victim = null;
let signalSpy = null;

async function spawnVictim() {
  // Процесс с обработчиком сигналов: мягкую остановку переживает, и ответ
  // `abort` зависит только от вердикта, а не от того, кто быстрее.
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000)"],
    { stdio: 'ignore' }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  return child;
}

afterEach(() => {
  signalSpy?.mockRestore();
  signalSpy = null;
  setExternalRunnerForTests(null);
  if (victim) {
    try { victim.kill('SIGKILL'); } catch { /* уже мёртв */ }
    victim = null;
  }
});

describe('вердикт can_escalate превращается в ответ', () => {
  it('PID_REUSED — тот же отказ, что у остальных операций', { timeout: 30000 }, async () => {
    victim = await spawnVictim();

    const result = await abort(victim.pid, {
      grace_sec: 0,
      can_escalate: () => ({ escalate: false, reason: 'PID_REUSED' })
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STALE_PIPELINE_LOCK');
    expect(result.reason).toBe('PID_REUSED');
    expect(result.hint).toMatch(/\.pipeline\.lock/);
    expect(result.hint).toMatch(/do not retry with force/);
  });

  it('IDENTITY_UNKNOWN блокирует эскалацию после мягкого сигнала', async () => {
    const pid = 987654321;
    signalSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const externalCalls = [];
    setExternalRunnerForTests(async (command, args) => {
      externalCalls.push({ command, args });
      return { ok: true };
    });

    const result = await abort(pid, {
      grace_sec: 0,
      can_escalate: () => ({ escalate: false, reason: 'IDENTITY_UNKNOWN' })
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROCESS_IDENTITY_UNKNOWN');
    expect(result.reason).toBe('IDENTITY_UNKNOWN');
    if (process.platform === 'win32') {
      expect(externalCalls).toEqual([{ command: 'taskkill', args: ['/PID', String(pid)] }]);
      expect(signalSpy).not.toHaveBeenCalled();
    } else {
      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(signalSpy).toHaveBeenCalledWith(pid, 'SIGINT');
      expect(externalCalls).toEqual([]);
    }
  });

  it('RUNNER_GONE — штатный исход, а не отказ', { timeout: 30000 }, async () => {
    victim = await spawnVictim();

    const result = await abort(victim.pid, {
      grace_sec: 0,
      can_escalate: () => ({ escalate: false, reason: 'RUNNER_GONE' })
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('aborted');
    expect(result.escalated).toBe(false);
  });

  it('прочие причины — OWNERSHIP_LOST', { timeout: 30000 }, async () => {
    victim = await spawnVictim();

    const result = await abort(victim.pid, {
      grace_sec: 0,
      can_escalate: () => ({ escalate: false, reason: 'STARTED_BY_MISMATCH' })
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('OWNERSHIP_LOST');
    expect(result.reason).toBe('STARTED_BY_MISMATCH');
  });

  it('голый false — тоже OWNERSHIP_LOST', { timeout: 30000 }, async () => {
    victim = await spawnVictim();

    const result = await abort(victim.pid, { grace_sec: 0, can_escalate: () => false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('OWNERSHIP_LOST');
    expect(result.reason).toBe('OWNERSHIP_LOST');
  });
});
