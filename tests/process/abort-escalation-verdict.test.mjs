/**
 * Ответ `abort` на отказ от эскалации — на настоящем `control.abort`.
 *
 * Отображение вердикта `can_escalate` в ответ жило без теста: инструментальные
 * наборы мокают `control.abort` целиком, и форму ответа в них «доказывал» сам
 * мок. Из-за этого в README попало неверное описание: будто при
 * переиспользованном номере приходит `escalated: false`, тогда как ответ был
 * `OWNERSHIP_LOST`.
 *
 * Здесь `abort` настоящий, сигнал уходит живому постороннему процессу (он его
 * переживает: мягкий `taskkill` без `/F` консольному процессу ничего не делает,
 * `SIGINT` node-процессу без обработчика — тоже не мгновенная смерть, поэтому
 * проверяется только ответ).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';

import { abort } from '../../src/process/control.mjs';
import { clearProcessAliveCache } from '../../src/health/pid-check.mjs';

let victim = null;

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
  if (victim) {
    try { victim.kill('SIGKILL'); } catch { /* уже мёртв */ }
    victim = null;
  }
});

describe('отказ жёсткого сигнала разбирается по существу', () => {
  it.runIf(process.platform === 'win32')(
    'процесс исчез за grace-окно — NO_SUCH_PROCESS, а не сырой отказ утилиты',
    { timeout: 30000 },
    async () => {
      // Мягкий `taskkill` консольному процессу штатно не проходит, дальше идёт
      // grace-окно. Раннер за это время выходит сам, и жёсткий сигнал получает
      // код 128. Прежде наружу уходил `EXTERNAL_COMMAND_FAILED` с
      // локализованным текстом, по которому клиенту нечего решать.
      victim = await spawnVictim();
      clearProcessAliveCache();
      const doomed = victim;
      setTimeout(() => {
        try { doomed.kill('SIGKILL'); } catch { /* уже мёртв */ }
      }, 300);

      const result = await abort(victim.pid, { grace_sec: 1, can_escalate: () => true });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_SUCH_PROCESS');
    }
  );
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
