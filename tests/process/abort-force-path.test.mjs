/**
 * Силовой путь `abort` и `kill`: отказ утилиты разбирается, а не уходит сырым.
 *
 * Две прежние редакции этого теста доказывали не то, что заявляли. Первая
 * убивала жертву таймером посреди grace-окна: не успел мягкий `taskkill` — он
 * получал 128, ответ приходил с раннего пути и совпадал с ожидаемым, даже
 * когда разбор силового пути был вырезан. Вторая брала `System` (pid 4) и
 * оказалась зелёной только на локализованной Windows: на en-US мягкая попытка
 * говорит «Access is denied», это распознаётся по тексту, и `abort`
 * возвращается, не дойдя до эскалации.
 *
 * Здесь подменяется сам запуск утилиты (`setExternalRunnerForTests`). Исход
 * `taskkill` зависит от локали, прав и наличия у процесса окна — воспроизвести
 * его иначе нечем. Настоящая утилита при этом не зовётся: ни один процесс в
 * системе не трогается.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';

import { abort, kill, setExternalRunnerForTests } from '../../src/process/control.mjs';
import { clearProcessAliveCache } from '../../src/health/pid-check.mjs';

/** Живой номер: для него проверка живости отвечает `alive`. */
let victim = null;
/** Свободный номер с запасом: на Linux `pid_max` бывает 4 194 304. */
const DEAD_PID = 999999999;

/** Что «ответила утилита». Порядок — как порядок вызовов. */
let replies;
let calls;

function fakeRunner(...answers) {
  replies = [...answers];
  calls = [];
  setExternalRunnerForTests(async (command, args) => {
    calls.push([command, ...args].join(' '));
    return replies.length > 1 ? replies.shift() : replies[0];
  });
}

/** Отказ утилиты с кодом возврата и текстом. */
function failure(exitCode, stderr) {
  return {
    ok: false,
    code: 'EXTERNAL_COMMAND_FAILED',
    exitCode,
    stderr,
    hint: `taskkill exited with code ${exitCode}: ${stderr}`
  };
}

async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return child;
}

beforeEach(() => {
  clearProcessAliveCache();
});

afterEach(() => {
  setExternalRunnerForTests(null);
  if (victim) {
    try { victim.kill('SIGKILL'); } catch { /* уже мёртв */ }
    victim = null;
  }
  clearProcessAliveCache();
});

describe.runIf(process.platform === 'win32')('abort: отказ жёсткого сигнала', () => {
  it('процесс жив, утилита отказала — PERMISSION_DENIED с pid', { timeout: 30000 }, async () => {
    victim = await spawnVictim();
    // Текст без `denied` и без `not found` — так настоящая утилита отвечает на
    // мягкую попытку для процесса без окна. Причина неясна, значит дело доходит
    // до grace-окна и эскалации.
    fakeRunner(failure(1, 'ERROR: the process can only be terminated forcefully'));

    let escalationAsked = false;
    const result = await abort(victim.pid, {
      grace_sec: 0,
      can_escalate: () => {
        escalationAsked = true;
        return true;
      }
    });

    expect(escalationAsked, 'до силового пути не дошли — тест ничего не доказал').toBe(true);
    expect(calls).toEqual([
      `taskkill /PID ${victim.pid}`,
      `taskkill /F /PID ${victim.pid}`
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.pid).toBe(victim.pid);
    // Жертву никто не трогал: настоящий `taskkill` не звался.
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  });

  it('за grace-окно процесс исчез — NO_SUCH_PROCESS', { timeout: 30000 }, async () => {
    // Мягкая попытка непонятна, жёсткая отвечает 128: раннер вышел сам.
    fakeRunner(
      failure(1, 'ERROR: the process can only be terminated forcefully'),
      failure(128, 'ERROR: no such process')
    );

    let escalationAsked = false;
    const result = await abort(DEAD_PID, {
      grace_sec: 0,
      can_escalate: () => {
        escalationAsked = true;
        return true;
      }
    });

    expect(escalationAsked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_SUCH_PROCESS');
    expect(result.pid).toBe(DEAD_PID);
  });

  it('мягкая попытка с «denied» отвечает сразу, не тратя grace-окно', { timeout: 30000 }, async () => {
    victim = await spawnVictim();
    fakeRunner(failure(1, 'ERROR: Access is denied.'));

    let escalationAsked = false;
    const started = Date.now();
    const result = await abort(victim.pid, {
      grace_sec: 5,
      can_escalate: () => {
        escalationAsked = true;
        return true;
      }
    });

    expect(escalationAsked).toBe(false);
    expect(calls).toEqual([`taskkill /PID ${victim.pid}`]);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.pid).toBe(victim.pid);
    expect(Date.now() - started, 'grace-окно не должно отрабатывать впустую').toBeLessThan(5000);
  });

  it('мягкая попытка с кодом 128 — процесса нет, эскалация не нужна', { timeout: 30000 }, async () => {
    fakeRunner(failure(128, 'ERROR: no such process'));

    let escalationAsked = false;
    const result = await abort(DEAD_PID, {
      grace_sec: 5,
      can_escalate: () => {
        escalationAsked = true;
        return true;
      }
    });

    expect(escalationAsked).toBe(false);
    expect(result.code).toBe('NO_SUCH_PROCESS');
  });
});

describe.runIf(process.platform === 'win32')('kill: отказ разбирается так же', () => {
  it('процесс жив — PERMISSION_DENIED с pid', { timeout: 30000 }, async () => {
    victim = await spawnVictim();
    fakeRunner(failure(1, 'ERROR: unreadable localized text'));

    const result = await kill(victim.pid);

    expect(calls).toEqual([`taskkill /F /T /PID ${victim.pid}`]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.pid).toBe(victim.pid);
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  });

  it('процесса нет — NO_SUCH_PROCESS с pid', { timeout: 30000 }, async () => {
    fakeRunner(failure(1, 'ERROR: unreadable localized text'));

    const result = await kill(DEAD_PID);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_SUCH_PROCESS');
    expect(result.pid).toBe(DEAD_PID);
  });

  it('утилита не запустилась — отказ уходит как есть', { timeout: 30000 }, async () => {
    victim = await spawnVictim();
    fakeRunner({ ok: false, code: 'SPAWN_FAILED', hint: 'spawn taskkill ENOENT' });

    const result = await kill(victim.pid);

    expect(result.code).toBe('SPAWN_FAILED');
    expect(result.hint).toMatch(/ENOENT/);
  });
});
