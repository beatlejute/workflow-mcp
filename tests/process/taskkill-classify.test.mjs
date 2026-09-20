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

/** Свободный номер с запасом: на Linux `pid_max` бывает 4 194 304. */
const DEAD_PID = 999999999;

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
    // бывает. Оно тут нарочно: с `probeLiveness` обратный порядок доводов дал
    // бы `PERMISSION_DENIED`, и этот тест его ловит.
    victim = await spawnVictim();

    expect(classifyTaskkillFailure({ exitCode: 128 }, victim.pid, { probeLiveness: true }))
      .toBe('NO_SUCH_PROCESS');
  });

  it('код 128 не требует похода в ОС', () => {
    expect(classifyTaskkillFailure({ exitCode: 128 }, DEAD_PID, { probeLiveness: true }))
      .toBe('NO_SUCH_PROCESS');
  });

  it('утилита не запустилась — про процесс это не говорит ничего', async () => {
    // `spawn taskkill ENOENT`: пустой `PATH` у хоста MCP, урезанное окружение.
    // Прежде такой отказ доходил до опроса живости, и живой процесс объявлялся
    // «нет прав» — диагноз не про то.
    victim = await spawnVictim();

    expect(classifyTaskkillFailure(
      { code: 'SPAWN_FAILED', hint: 'spawn taskkill ENOENT' },
      victim.pid,
      { probeLiveness: true }
    )).toBeNull();
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

describe('живость важнее текста и спрашивается только на принудительном пути', () => {
  it('английский «отказано в доступе» не перебивает факт', () => {
    // Исход не должен зависеть от языка системы: на русской этот же отказ
    // разбирался по живости, на английской — по тексту, и ответы расходились.
    expect(classifyTaskkillFailure(
      { exitCode: 1, stderr: 'ERROR: Access is denied.' },
      DEAD_PID,
      { probeLiveness: true }
    )).toBe('NO_SUCH_PROCESS');
  });

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

    // Память ещё держит «жив» — а `checkProcess` зовут сразу после сигнала,
    // поэтому он обязан переспросить.
    expect(probeProcess(victim.pid)).toBe('alive');
    expect(checkProcess(victim.pid)).toEqual({ exists: false, code: 'NO_SUCH_PROCESS' });
  });

  it('живой процесс существует', async () => {
    victim = await spawnVictim();

    expect(checkProcess(victim.pid)).toEqual({ exists: true });
  });

  it.each([
    ['EPERM', 'EPERM'],
    ['прочая ошибка ядра', 'EINVAL']
  ])('ошибка «%s» не выдаётся за отсутствие процесса', (_label, code) => {
    // Прежняя собственная реализация `EPERM` читала верно, а всё остальное —
    // как `{exists: false, code: 'UNKNOWN_ERROR'}`. По отрицанию вызывающие
    // снимают lock и шлют сигналы, поэтому «не знаю» обязано звучать как
    // «процесс есть».
    const savedPath = process.env.PATH;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error(code);
      err.code = code;
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
