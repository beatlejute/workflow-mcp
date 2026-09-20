/**
 * Почему не сработал `taskkill` — и почему это нельзя решать по тексту.
 *
 * Прежде ответ искался подстроками `'not found'` и `'denied'` в stderr. Оба
 * сообщения локализованы: на русской Windows не совпадает ни одна, и мёртвый
 * номер ехал в grace-ожидание, а оттуда в принудительную ветку. Здесь
 * закреплены три довода по порядку: код возврата, текст, живость.
 *
 * Живость спрашивается только после принудительной остановки. Мягкий
 * `taskkill` без `/F` штатно не проходит для процесса без окна — консольный
 * раннер как раз такой, — и живой процесс там значит «мягко нельзя», а не «не
 * хватило прав».
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';

import { classifyTaskkillFailure, checkProcess } from '../../src/process/control.mjs';
import { probeProcess, clearProcessAliveCache } from '../../src/health/pid-check.mjs';

/** Отказ утилиты на локализованной системе: по-английски там ничего нет. */
const RUSSIAN_DENIED = {
  exitCode: 1,
  stderr: 'ОШИБКА: не удалось завершить процесс "node.exe" с идентификатором 4242.\nПричина: Отказано в доступе.'
};

const DEAD_PID = 999999;

let victim = null;

async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return child;
}

beforeEach(() => {
  clearProcessAliveCache();
});

afterEach(() => {
  if (victim) {
    try { victim.kill(); } catch { /* уже мёртв */ }
    victim = null;
  }
  clearProcessAliveCache();
});

describe('код возврата — первый довод', () => {
  it('128 значит «нет такого процесса», даже если процесс жив', async () => {
    // Живой номер и код 128 одновременно — противоречие, которого в жизни не
    // бывает; проверяется именно то, что код читается раньше всего.
    victim = await spawnVictim();

    expect(classifyTaskkillFailure({ exitCode: 128 }, victim.pid)).toBe('NO_SUCH_PROCESS');
  });

  it('код 128 не требует похода в tasklist', () => {
    expect(classifyTaskkillFailure({ exitCode: 128 }, DEAD_PID, { probeLiveness: true }))
      .toBe('NO_SUCH_PROCESS');
  });
});

describe('текст — второй довод', () => {
  it('английские сообщения распознаются без опроса ОС', () => {
    expect(classifyTaskkillFailure({ exitCode: 1, stderr: 'ERROR: The process "x" not found.' }, DEAD_PID))
      .toBe('NO_SUCH_PROCESS');
    expect(classifyTaskkillFailure({ exitCode: 1, stderr: 'ERROR: Access is denied.' }, DEAD_PID))
      .toBe('PERMISSION_DENIED');
  });

  it('локализованный текст ничего не говорит', () => {
    // Ровно тот случай, ради которого правило переписано.
    expect(classifyTaskkillFailure(RUSSIAN_DENIED, DEAD_PID)).toBeNull();
  });
});

describe('живость — третий довод, и только на принудительном пути', () => {
  it('мягкая попытка живой процесс за отказ не считает', async () => {
    victim = await spawnVictim();

    // Без `probeLiveness` ответа нет: вызывающий пойдёт в grace-окно и дальше.
    expect(classifyTaskkillFailure(RUSSIAN_DENIED, victim.pid)).toBeNull();
  });

  it('принудительная остановка не прошла, а процесс жив — это про права', async () => {
    victim = await spawnVictim();

    expect(classifyTaskkillFailure(RUSSIAN_DENIED, victim.pid, { probeLiveness: true }))
      .toBe('PERMISSION_DENIED');
  });

  it('принудительная остановка не прошла, процесса нет — дело было в нём', () => {
    expect(classifyTaskkillFailure(RUSSIAN_DENIED, DEAD_PID, { probeLiveness: true }))
      .toBe('NO_SUCH_PROCESS');
  });
});

describe('checkProcess', () => {
  it('отвечает через общую проверку и спрашивает заново', async () => {
    victim = await spawnVictim();

    // Память прогрета живым ответом.
    expect(probeProcess(victim.pid)).toBe('alive');

    victim.kill();
    await new Promise((resolve) => victim.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Память ещё держит «жив» — а `checkProcess` зовут сразу после сигнала,
    // поэтому он обязан переспросить.
    expect(probeProcess(victim.pid)).toBe('alive');
    expect(checkProcess(victim.pid)).toEqual({ exists: false, code: 'NO_SUCH_PROCESS' });
  });

  it('живой процесс существует', async () => {
    victim = await spawnVictim();

    expect(checkProcess(victim.pid)).toEqual({ exists: true });
  });

  it('чужой процесс (EPERM) существует, а не «неизвестная ошибка»', () => {
    // Здесь была четвёртая собственная реализация живости: она читала `EPERM`
    // как `UNKNOWN_ERROR` и отвечала «процесса нет». По этому ответу
    // вызывающие снимают lock и шлют сигналы.
    const savedPath = process.env.PATH;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    });
    try {
      // На Windows общая проверка идёт через `tasklist`; пустой PATH уводит её
      // в ту же ветку `kill(pid, 0)`, что и на POSIX.
      if (process.platform === 'win32') process.env.PATH = '';
      clearProcessAliveCache();

      expect(checkProcess(424242)).toEqual({ exists: true });
    } finally {
      process.env.PATH = savedPath;
      vi.restoreAllMocks();
    }
  });
});
