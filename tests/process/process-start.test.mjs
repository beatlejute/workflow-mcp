/**
 * Время старта процесса и вывод из него «тот ли это раннер».
 *
 * Проверка держится на внешней утилите (PowerShell на Windows, `ps` на POSIX),
 * поэтому важно, как именно она ведёт себя, когда ответа нет: осознанно
 * fail-open — запрет управлять своим же пайплайном из-за недоступной утилиты
 * хуже остающегося риска переиспользования pid.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

import { processStartedAt, pidCouldBeFromRun } from '../../src/process/process-start.mjs';

/** Заведомо свободный номер: столько процессов в системе не бывает. */
const DEAD_PID = 999999;

describe('processStartedAt', () => {
  it('отдаёт время старта своего процесса', () => {
    const startedAt = processStartedAt(process.pid);

    expect(startedAt).toBeInstanceOf(Date);
    // Сверяем с независимой оценкой: now − uptime.
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs(startedAt.getTime() - expected)).toBeLessThan(5000);
  });

  it('отдаёт null для несуществующего процесса', () => {
    expect(processStartedAt(DEAD_PID)).toBeNull();
  });

  it('отдаёт null на бессмысленном pid, не бросая', () => {
    expect(processStartedAt(0)).toBeNull();
    expect(processStartedAt(-1)).toBeNull();
    expect(processStartedAt(undefined)).toBeNull();
  });
});

describe('pidCouldBeFromRun', () => {
  it('процесс, стартовавший до записи lock, считается тем самым', () => {
    // Свой процесс стартовал раньше, чем «сейчас».
    expect(pidCouldBeFromRun(process.pid, new Date().toISOString())).toBe(true);
  });

  it('процесс, стартовавший заметно позже lock, считается чужим', () => {
    expect(pidCouldBeFromRun(process.pid, '2020-01-01T00:00:00.000Z')).toBe(false);
  });

  it('допуск покрывает округление до секунды, но не больше', () => {
    const startedAt = processStartedAt(process.pid);
    expect(startedAt).toBeInstanceOf(Date);

    // lock якобы записан за 4 секунды ДО старта процесса — внутри допуска.
    const almost = new Date(startedAt.getTime() - 4000).toISOString();
    expect(pidCouldBeFromRun(process.pid, almost)).toBe(true);

    // За 10 секунд до старта — уже вне допуска.
    const tooEarly = new Date(startedAt.getTime() - 10000).toISOString();
    expect(pidCouldBeFromRun(process.pid, tooEarly)).toBe(false);
  });

  it('без времени записи lock проверка пропускается', () => {
    expect(pidCouldBeFromRun(process.pid, null)).toBe(true);
    expect(pidCouldBeFromRun(process.pid, undefined)).toBe(true);
    expect(pidCouldBeFromRun(process.pid, 'не дата')).toBe(true);
  });

  it('если время старта узнать нельзя, процесс считается подходящим', () => {
    // Мёртвый pid: время старта не получить — fail-open.
    expect(pidCouldBeFromRun(DEAD_PID, '2020-01-01T00:00:00.000Z')).toBe(true);
  });

  it('свежепорождённый процесс не выдаётся за раннер из древнего lock', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pidCouldBeFromRun(child.pid, '2020-01-01T00:00:00.000Z')).toBe(false);
      expect(pidCouldBeFromRun(child.pid, new Date().toISOString())).toBe(true);
    } finally {
      try {
        child.kill();
      } catch {
        // мог завершиться сам
      }
    }
  });
});
