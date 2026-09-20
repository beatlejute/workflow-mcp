/**
 * Память о времени старта процесса и её обход.
 *
 * Память нужна чтению состояния: опрос ОС стоит сотни миллисекунд, а ответ для
 * живого процесса неизменен. Но она же опасна перед отправкой сигнала: запись,
 * прогретая чтением, переживает смерть раннера, и если система успела отдать
 * номер другому процессу, проверка «это тот самый раннер» пропустит чужого.
 * Поэтому сигнальные пути зовут с `fresh: true`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';

import {
  processStartedAt,
  processStartedAtCached,
  pidCouldBeFromRun,
  clearProcessStartCache,
  cacheEntryUsable
} from '../../src/process/process-start.mjs';

/** Живой процесс, который можно убить посреди теста. */
async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return child;
}

async function waitForExit(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

let victim = null;

beforeEach(() => {
  clearProcessStartCache();
});

afterEach(async () => {
  if (victim) {
    try { victim.kill(); } catch { /* уже мёртв */ }
    victim = null;
  }
  clearProcessStartCache();
});

describe('processStartedAtCached', () => {
  it('помнит ответ и не спрашивает ОС повторно', async () => {
    victim = await spawnVictim();

    const first = processStartedAtCached(victim.pid);
    expect(first).toBeInstanceOf(Date);

    // Процесса уже нет, а память отвечает тем же.
    victim.kill();
    await waitForExit(victim);

    expect(processStartedAt(victim.pid)).toBeNull();
    expect(processStartedAtCached(victim.pid)?.getTime()).toBe(first.getTime());
  });

  it('fresh спрашивает ОС, минуя память', async () => {
    victim = await spawnVictim();

    expect(processStartedAtCached(victim.pid)).toBeInstanceOf(Date);

    victim.kill();
    await waitForExit(victim);

    // Ровно это и защищает от убийства постороннего дерева: перед сигналом
    // ответ берётся у ОС, а не из записи, прогретой чтением состояния.
    expect(processStartedAtCached(victim.pid, { fresh: true })).toBeNull();
  });

  it('после fresh память хранит уже новый ответ', async () => {
    victim = await spawnVictim();

    processStartedAtCached(victim.pid);
    victim.kill();
    await waitForExit(victim);

    processStartedAtCached(victim.pid, { fresh: true });

    expect(processStartedAtCached(victim.pid)).toBeNull();
  });

  it('запись протухает через минуту и ответ переспрашивается', async () => {
    // Срок жизни проверяется через сам `processStartedAtCached`, а не только
    // через правило: подменяются часы, а опрос ОС остаётся настоящим.
    victim = await spawnVictim();

    expect(processStartedAtCached(victim.pid)).toBeInstanceOf(Date);

    victim.kill();
    await waitForExit(victim);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 61_000));
      expect(processStartedAtCached(victim.pid)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('память об одном pid не отвечает за другой', async () => {
    const DEAD_PID = 999999999;
    expect(processStartedAtCached(DEAD_PID)).toBeNull();

    victim = await spawnVictim();
    expect(processStartedAtCached(victim.pid)).toBeInstanceOf(Date);
  });
});

describe('срок жизни записи', () => {
  // Два вида ответа живут по-разному: известное время старта — минуту, отказ
  // опроса — пять секунд. `null` означает «процесса нет или не спросить» и
  // ведёт к fail-open, поэтому застревать в нём на минуту опаснее, чем
  // переспросить. На живых процессах это не проверить: мёртвый pid так и
  // останется мёртвым, сколько его ни спрашивай.
  const now = 1_000_000;

  it('известное время старта живёт минуту', () => {
    const entry = { at: now - 59_000, value: new Date() };
    expect(cacheEntryUsable(entry, now)).toBe(true);
  });

  it('и перестаёт годиться после неё', () => {
    const entry = { at: now - 61_000, value: new Date() };
    expect(cacheEntryUsable(entry, now)).toBe(false);
  });

  it('отказ опроса годится только первые секунды', () => {
    expect(cacheEntryUsable({ at: now - 4_000, value: null }, now)).toBe(true);
  });

  it('и забывается задолго до минуты', () => {
    // Тот самый случай: с общим сроком запись жила бы ещё 54 секунды.
    expect(cacheEntryUsable({ at: now - 6_000, value: null }, now)).toBe(false);
  });

  it('пустой записи нет — значит, спрашиваем', () => {
    expect(cacheEntryUsable(undefined, now)).toBe(false);
  });
});

describe('pidCouldBeFromRun', () => {
  it('пробрасывает fresh в опрос', async () => {
    victim = await spawnVictim();
    const startedAt = processStartedAtCached(victim.pid);
    const lockWrittenAt = new Date(startedAt.getTime() + 1000).toISOString();

    expect(pidCouldBeFromRun(victim.pid, lockWrittenAt)).toBe(true);

    victim.kill();
    await waitForExit(victim);

    // Мёртвый процесс — fail-open в обоих случаях, но ответ уже не из памяти:
    // с fresh его переспросили у ОС.
    expect(pidCouldBeFromRun(victim.pid, lockWrittenAt, { fresh: true })).toBe(true);
    expect(processStartedAtCached(victim.pid)).toBeNull();
  });

  it('запас на округление задаётся тем же объектом опций', () => {
    const startedAt = processStartedAt(process.pid);
    const tooEarly = new Date(startedAt.getTime() - 60_000).toISOString();

    expect(pidCouldBeFromRun(process.pid, tooEarly, { toleranceMs: 5000 })).toBe(false);
    expect(pidCouldBeFromRun(process.pid, tooEarly, { toleranceMs: 120_000 })).toBe(true);
  });
});
