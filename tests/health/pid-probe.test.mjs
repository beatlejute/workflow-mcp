/**
 * Сбой утилиты — не смерть процесса.
 *
 * `probeProcess` отвечает тремя словами, а не двумя. Разница между `dead` и
 * `unknown` дорогая: по `dead` сервер снимает `.workflow/logs/.pipeline.lock`
 * и разрешает новый запуск. Пока Windows-ветка читала любой отказ `tasklist`
 * как «процесса нет», достаточно было занятой машины или пустого `PATH` у
 * хоста MCP, чтобы `start_pipeline` снял lock живого раннера и поставил второй
 * пайплайн поверх первого.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';

import {
  probeProcess,
  isProcessAlive,
  clearProcessAliveCache
} from '../../src/health/pid-check.mjs';

const DEAD_PID = 999999999;

let victim = null;
let savedPath;

beforeEach(() => {
  clearProcessAliveCache();
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (victim) {
    try { victim.kill(); } catch { /* уже мёртв */ }
    victim = null;
  }
  clearProcessAliveCache();
});

async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return child;
}

describe('probeProcess', () => {
  it('живой процесс — alive', async () => {
    victim = await spawnVictim();

    expect(probeProcess(victim.pid)).toBe('alive');
  });

  it('свободный номер — dead', () => {
    expect(probeProcess(DEAD_PID)).toBe('dead');
  });

  it.each([[0], [-1], [3.14], ['123'], [null]])('бессмысленный номер (%s) — dead', (pid) => {
    expect(probeProcess(pid)).toBe('dead');
  });
});

describe('утилита недоступна', () => {
  it.runIf(process.platform === 'win32')('живой процесс не объявляется мёртвым без tasklist', async () => {
    // Пустой PATH — самый дешёвый способ воспроизвести отказ утилиты. Так же
    // выглядят таймаут под нагрузкой и урезанное окружение хоста MCP.
    victim = await spawnVictim();
    process.env.PATH = '';
    clearProcessAliveCache();

    // Второе мнение — `kill(pid, 0)`: про свой процесс оно отвечает точно.
    expect(probeProcess(victim.pid)).toBe('alive');
    expect(isProcessAlive(victim.pid)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('свободный номер без tasklist — unknown, а не dead', () => {
    process.env.PATH = '';
    clearProcessAliveCache();

    // Без ответа утилиты сказать «мёртв» нельзя: по этому слову снимается lock.
    expect(probeProcess(DEAD_PID)).toBe('unknown');
    expect(isProcessAlive(DEAD_PID)).toBe(true);
  });
});

describe('ответы ядра различаются между собой', () => {
  // Мимо `tasklist`: на Windows утилита отключается пустым PATH, и проверка
  // уходит в ту же ветку `kill(pid, 0)`, что и на POSIX.
  function withoutTasklist() {
    if (process.platform === 'win32') process.env.PATH = '';
    clearProcessAliveCache();
  }

  it('EPERM — процесс есть, просто не наш', () => {
    const pid = 424242;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    });
    try {
      withoutTasklist();

      expect(probeProcess(pid)).toBe('alive');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ESRCH — процесса нет', () => {
    const pid = 424243;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    try {
      withoutTasklist();

      // На Windows это ответ запасной ветки при отказавшей утилите: сказать
      // «мёртв» по одному запасному мнению нельзя, по нему снимают lock.
      expect(probeProcess(pid)).toBe(process.platform === 'win32' ? 'unknown' : 'dead');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('прочая ошибка — unknown, а не приговор', () => {
    const pid = 424244;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    });
    try {
      withoutTasklist();

      expect(probeProcess(pid)).toBe('unknown');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('isProcessAlive поверх probeProcess', () => {
  it('всё, что не доказано мёртвым, считается живым', async () => {
    victim = await spawnVictim();

    expect(isProcessAlive(victim.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});
