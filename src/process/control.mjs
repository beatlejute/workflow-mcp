import { spawn } from 'child_process';
import process from 'process';
import os from 'os';
import { probeProcess } from '../health/pid-check.mjs';

/**
 * Cross-platform process control module.
 * Provides pause, resume, abort, and kill operations for managing child processes.
 */

/**
 * Sends a signal to a process (POSIX-only).
 * @param {number} pid - Process ID to signal
 * @param {string} signal - Signal to send (e.g., 'SIGSTOP', 'SIGCONT', 'SIGINT', 'SIGTERM', 'SIGKILL')
 * @returns {{ok: true}} | {{ok: false, code: string, pid: number, hint?: string}}
 */
function sendSignal(pid, signal) {
  // `pid` есть и в отказе: форма ответа одна у всех операций и обеих платформ.
  // Прежде отказы POSIX-ветки шли без номера, и потребителю приходилось
  // помнить, какой номер он отправлял. На Windows номер несли отказы `abort`
  // (`STALE_PIPELINE_LOCK`, `OWNERSHIP_LOST`) и разобранные отказы утилиты.
  const target = Math.abs(pid);
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { ok: false, code: 'NO_SUCH_PROCESS', pid: target, hint: `No process with PID ${target}` };
    }
    if (err.code === 'EPERM') {
      return { ok: false, code: 'PERMISSION_DENIED', pid: target, hint: `Permission denied to signal PID ${target}` };
    }
    return { ok: false, code: 'UNKNOWN_ERROR', pid: target, hint: err.message };
  }
}

/**
 * Подменяемый запуск внешней утилиты.
 *
 * Шов для тестов. Исход `taskkill` иначе не воспроизвести: его код возврата и
 * текст зависят от локали системы, прав и того, есть ли у процесса окно.
 * Прежние редакции теста силового пути опирались то на гонку, то на русский
 * вывод утилиты — и были зелёными только на этой машине.
 *
 * @type {(command: string, args: string[]) => Promise<Object>}
 */
let externalRunner = null;

/**
 * Подменить запуск внешних утилит. Только для тестов; `null` возвращает
 * настоящий запуск.
 *
 * @param {((command: string, args: string[]) => Promise<Object>)|null} runner
 */
export function setExternalRunnerForTests(runner) {
  externalRunner = runner;
}

function runExternal(command, args) {
  return externalRunner ? externalRunner(command, args) : callExternal(command, args);
}

/**
 * Calls an external command via spawn (Windows helper).
 *
 * `pid` в отказ не кладётся: здесь известна только команда. Номер процесса
 * добавляют вызывающие — `pause`, `resume`, `abort` и `kill`.
 *
 * У `SPAWN_FAILED` рядом идёт `spawn_code` — errno из ошибки `spawn`.
 * `ENOENT` («утилиты нет в `PATH`») повторять незачем, а `EAGAIN` или
 * `EMFILE` — ресурсы кончились сейчас, через grace-окно попытка может пройти.
 *
 * @param {string} command - Command to execute
 * @param {string[]} args - Arguments
 * @returns {{ok: true, stdout?: string, stderr?: string} | {ok: false, code: string, hint?: string}}
 *
 * Экспортируется ради тестов: сбой запуска утилиты иначе не получить — имя
 * команды внутри жёсткое, а подменённый раннер до настоящего `spawn` не
 * доходит.
 */
export function callExternal(command, args) {
  try {
    const child = spawn(command, args, {
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
    });

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, stdout, stderr });
        } else {
          resolve({
            ok: false,
            code: 'EXTERNAL_COMMAND_FAILED',
            exitCode: code,
            stderr,
            hint: `${command} exited with code ${code}: ${stderr}`,
          });
        }
      });

      child.on('error', (err) => {
        resolve({ ok: false, code: 'SPAWN_FAILED', spawn_code: err.code, hint: err.message });
      });
    });
  } catch (err) {
    return { ok: false, code: 'SPAWN_FAILED', spawn_code: err.code, hint: err.message };
  }
}

/**
 * Почему не сработал `taskkill`.
 *
 * Прежде ответ искался подстроками `'not found'` и `'denied'` в stderr. Текст
 * этих сообщений локализован: на русской Windows не совпадает ни одна, и
 * мёртвый номер уезжал в grace-ожидание, а оттуда — в принудительную ветку.
 *
 * Теперь решают две вещи, от языка не зависящие:
 *
 * - код возврата: `taskkill` отдаёт 128, когда процесса с таким номером нет —
 *   это документированное значение;
 * - живость: если после отказа процесс мёртв, дело было в нём, а если жив —
 *   нам не хватило прав его тронуть.
 *
 * Подстроки остались последним доводом — для пути, где живость не
 * спрашивается. Раньше они стояли перед ней, и на английской системе исход
 * отличался от русской: текст побеждал факт.
 *
 * Сбой запуска самой утилиты (`SPAWN_FAILED`: нет `taskkill` в `PATH`) сюда не
 * относится вовсе — это про окружение, а не про процесс. Прежде такой отказ
 * доходил до опроса живости и живой процесс объявлялся «нет прав».
 *
 * Живость спрашивается только после принудительной остановки. Мягкий
 * `taskkill` без `/F` штатно не проходит для процесса без окна — консольный
 * раннер как раз такой, — и живой процесс здесь значит «мягко нельзя», а не
 * «не хватило прав»: дальше идёт grace-окно и жёсткий сигнал.
 *
 * @param {{exitCode?: number, stderr?: string, hint?: string}} failure
 * @param {number} pid
 * @param {Object} [options]
 * @param {boolean} [options.probeLiveness] спросить ОС, жив ли процесс, если
 *   код возврата ничего не сказал. Живость идёт раньше текста: текст локализован,
 *   факт — нет
 * Экспортируется ради тестов: воспроизвести отказ `taskkill` с нужным кодом
 * возврата на живом процессе иначе нечем, а правило здесь — чистая функция от
 * ответа утилиты и номера процесса.
 *
 * @returns {'NO_SUCH_PROCESS'|'PERMISSION_DENIED'|null} null — причина неясна
 */
export function classifyTaskkillFailure(failure, pid, { probeLiveness = false } = {}) {
  // Утилита не запустилась — про сам процесс это не говорит ничего.
  if (typeof failure.exitCode !== 'number') {
    return null;
  }

  if (failure.exitCode === 128) {
    return 'NO_SUCH_PROCESS';
  }

  if (probeLiveness) {
    const state = probeProcess(pid, { fresh: true });
    if (state === 'dead') {
      return 'NO_SUCH_PROCESS';
    }
    if (state === 'alive') {
      // Принудительная остановка не прошла, а процесс на месте — это про права.
      return 'PERMISSION_DENIED';
    }
    // Спросить не удалось — остаётся текст.
  }

  const text = `${failure.stderr ?? ''} ${failure.hint ?? ''}`.toLowerCase();
  if (text.includes('not found')) {
    return 'NO_SUCH_PROCESS';
  }
  if (text.includes('denied')) {
    return 'PERMISSION_DENIED';
  }

  return null;
}

/**
 * Pause a process (suspend execution).
 * - POSIX: Sends SIGSTOP
 * - Windows: Uses pssuspend.exe (Sysinternals), falls back to PAUSE_UNSUPPORTED
 * @param {number} pid - Process ID to pause
 * @returns {Promise<{ok: true, pid: number, state: 'paused'} | {ok: false, code: string, pid: number, hint?: string}>}
 */
export async function pause(pid) {
  if (process.platform === 'win32') {
    // On Windows, we need pssuspend.exe from Sysinternals.
    // The result is cached in state-dir/process-tools.json by the caller (marker module).
    // Here we attempt to use pssuspend directly.
    const result = await runExternal('pssuspend.exe', [pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'paused' };
    }
    // If pssuspend is not available, return PAUSE_UNSUPPORTED
    return {
      ok: false,
      code: 'PAUSE_UNSUPPORTED',
      pid,
      hint:
        'pssuspend.exe not found. Install Sysinternals PsTools or set up node-windows-suspend. '
        + 'Alternatively, use abort_pipeline for graceful shutdown.',
    };
  }

  // POSIX: SIGSTOP
  return sendSignal(pid, 'SIGSTOP');
}

/**
 * Resume a paused process.
 * - POSIX: Sends SIGCONT
 * - Windows: Uses pssuspend.exe -r (resume flag)
 * @param {number} pid - Process ID to resume
 * @returns {Promise<{ok: true, pid: number, state: 'running'} | {ok: false, code: string, pid: number, hint?: string}>}
 */
export async function resume(pid) {
  if (process.platform === 'win32') {
    // pssuspend.exe -r <pid> resumes the process
    const result = await runExternal('pssuspend.exe', ['-r', pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'running' };
    }
    return {
      ok: false,
      code: 'RESUME_UNSUPPORTED',
      pid,
      hint:
        'pssuspend.exe not found. Install Sysinternals PsTools to resume processes.',
    };
  }

  // POSIX: SIGCONT
  return sendSignal(pid, 'SIGCONT');
}

/**
 * Gracefully abort a process with an optional grace period.
 * - POSIX: SIGINT → wait grace_sec → SIGTERM
 * - Windows: taskkill /PID <pid> (without /F) → wait → taskkill /F
 * @param {number} pid - Process ID to abort
 * @param {{grace_sec?: number}} [options] - Options object
 * @param {number} [options.grace_sec=10] - Grace period in seconds before force termination
 * @returns {Promise<{ok: true, pid: number, state: 'aborted', duration_ms: number, escalated: boolean} | {ok: false, code: string, pid?: number, hint?: string}>}
 */
export async function abort(pid, options = {}) {
  const graceSec = options.grace_sec !== undefined ? options.grace_sec : 10;
  const clampedGraceSec = Math.max(0, Math.min(60, graceSec));
  // Между мягким сигналом и жёстким проходит до минуты. За это время раннер
  // может завершиться сам, а его pid — достаться чужому процессу. Вызывающий даёт
  // проверку, которая повторяется перед эскалацией и различает два исхода:
  // раннер уже вышел (цель достигнута, добивать некого) и владение потеряно.
  const rawCanEscalate = typeof options.can_escalate === 'function' ? options.can_escalate : () => true;
  const checkEscalation = () => {
    const verdict = rawCanEscalate();
    if (verdict === true || verdict === undefined) return { escalate: true };
    if (verdict === false) return { escalate: false, reason: 'OWNERSHIP_LOST' };
    return { escalate: verdict.escalate !== false, reason: verdict.reason };
  };
  const escalationRefused = (verdict) => {
    // Раннер вышел сам за grace-окно — штатный исход.
    if (verdict.reason === 'RUNNER_GONE') {
      return { ok: true, pid, state: 'aborted', duration_ms: clampedGraceSec * 1000, escalated: false };
    }
    // Номер занял посторонний процесс. Тот же код и та же подсказка, что у
    // остальных операций: «удалите lock, не повторяйте с force». Прежде здесь
    // отвечал общий `OWNERSHIP_LOST` — «пайплайн больше не ваш», — и совет
    // расходился с тем, что говорят `stop`, `pause` и `resume` про ровно это
    // же положение дел.
    if (verdict.reason === 'PID_REUSED') {
      return {
        ok: false,
        code: 'STALE_PIPELINE_LOCK',
        pid,
        reason: verdict.reason,
        hint: 'The recorded runner is gone and its pid now belongs to another process. '
          + 'Remove .workflow/logs/.pipeline.lock; do not retry with force — that would kill the unrelated process.'
      };
    }
    return {
      ok: false,
      code: 'OWNERSHIP_LOST',
      pid,
      reason: verdict.reason,
      hint: `Process ${pid} is no longer the pipeline runner; not escalating to a forced kill`
    };
  };

  if (process.platform === 'win32') {
    // First attempt: graceful taskkill (without /F)
    const gracefulResult = await runExternal('taskkill', ['/PID', pid.toString()]);
    if (!gracefulResult.ok) {
      const reason = classifyTaskkillFailure(gracefulResult, pid);
      if (reason) {
        return { ok: false, code: reason, pid, hint: gracefulResult.hint };
      }
      // Утилиты нет в `PATH` — принудительная попытка позовёт ту же утилиту
      // и получит тот же отказ. Ждать ради этого grace-окно (по умолчанию
      // 10 с, до 60 с) нечего: ответ уже известен. Прочие сбои запуска
      // (`EAGAIN`, `EMFILE`) говорят о нехватке ресурсов сейчас — там ожидание
      // как раз может помочь, и путь остаётся прежним.
      if (gracefulResult.code === 'SPAWN_FAILED' && gracefulResult.spawn_code === 'ENOENT') {
        return { ...gracefulResult, pid };
      }
      // Причина неясна — идём дальше по обычному пути: grace-окно и, если
      // владение подтвердится, принудительная остановка.
    }

    // Wait for grace period
    if (clampedGraceSec > 0) {
      await new Promise((resolve) => setTimeout(resolve, clampedGraceSec * 1000));
    }

    const winVerdict = checkEscalation();
    if (!winVerdict.escalate) {
      return escalationRefused(winVerdict);
    }

    // Force termination
    const forceResult = await runExternal('taskkill', ['/F', '/PID', pid.toString()]);
    const escalated = !gracefulResult.ok || (gracefulResult.ok && forceResult.ok);

    if (forceResult.ok || gracefulResult.ok) {
      return {
        ok: true,
        pid,
        state: 'aborted',
        duration_ms: clampedGraceSec * 1000,
        escalated,
      };
    }

    // Жёсткий сигнал не прошёл. Причина разбирается так же, как в `kill`:
    // иначе наружу уходил сырой `EXTERNAL_COMMAND_FAILED` с локализованным
    // текстом, по которому клиенту нечего решать.
    const forceReason = classifyTaskkillFailure(forceResult, pid, { probeLiveness: true });
    return forceReason
      ? { ok: false, code: forceReason, pid, hint: forceResult.hint }
      : { ...forceResult, pid };
  }

  // POSIX: SIGINT first
  const sigintResult = sendSignal(pid, 'SIGINT');
  if (!sigintResult.ok) {
    // If process doesn't exist, return early
    if (sigintResult.code === 'NO_SUCH_PROCESS') {
      return sigintResult;
    }
    // If permission denied, return early
    if (sigintResult.code === 'PERMISSION_DENIED') {
      return sigintResult;
    }
    // Try SIGTERM directly as fallback
    const sigtermResult = sendSignal(pid, 'SIGTERM');
    return sigtermResult;
  }

  // Wait for grace period
  if (clampedGraceSec > 0) {
    await new Promise((resolve) => setTimeout(resolve, clampedGraceSec * 1000));
  }

  const posixVerdict = checkEscalation();
  if (!posixVerdict.escalate) {
    return escalationRefused(posixVerdict);
  }

  // Send SIGTERM as escalation
  const sigtermResult = sendSignal(pid, 'SIGTERM');
  const escalated = !sigtermResult.ok || (sigtermResult.ok && clampedGraceSec > 0);

  return {
    ok: true,
    pid,
    state: 'aborted',
    duration_ms: clampedGraceSec * 1000,
    escalated,
  };
}

/**
 * Force kill a process.
 * - POSIX: SIGKILL to process group using -pid (requires detached:true on spawn)
 * - Windows: taskkill /F /T /PID (kills process tree)
 * @param {number} pid - Process ID to kill
 * @returns {Promise<{ok: true, pid: number, state: 'killed'} | {ok: false, code: string, pid?: number, hint?: string}>}
 *   `pid` есть и в отказе — форма одна у всех операций и обеих платформ.
 */
export async function kill(pid) {
  if (process.platform === 'win32') {
    // Force kill with taskkill /F /T (includes child processes)
    const result = await runExternal('taskkill', ['/F', '/T', '/PID', pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'killed' };
    }
    const reason = classifyTaskkillFailure(result, pid, { probeLiveness: true });
    return reason ? { ok: false, code: reason, pid, hint: result.hint } : { ...result, pid };
  }

   // POSIX: SIGKILL to process group
   // Using negative PID signals the entire process group.
   // This requires the process was spawned with `detached: true`.
   const pgid = -pid;
   const result = sendSignal(pgid, 'SIGKILL');
   if (!result.ok) {
     // Propagate any error (NO_SUCH_PROCESS, PERMISSION_DENIED, UNKNOWN_ERROR)
     return result;
   }
   return { ok: true, pid, state: 'killed' };
}

/**
 * Существует ли процесс.
 *
 * Обёртка над общей проверкой: здесь была четвёртая по счёту собственная
 * реализация живости. `EPERM` она читала верно, а вот прочие ошибки ядра —
 * как «процесса нет», и Windows-ветки через `tasklist` у неё не было: на
 * Windows ответ строился на `kill(pid, 0)`, который про чужие процессы даёт
 * `EPERM`, а про процессы других сессий — не всегда правду.
 *
 * Ответ берётся свежим: зовут это сразу после сигнала, а память держит прежний
 * ответ секунду.
 *
 * `unknown` («спросить не удалось») считается существованием: по отрицанию
 * вызывающие снимают lock и шлют сигналы.
 *
 * @param {number} pid - Process ID to check
 * @returns {{exists: true} | {exists: false, code: string}}
 */
export function checkProcess(pid) {
  return probeProcess(pid, { fresh: true }) === 'dead'
    ? { exists: false, code: 'NO_SUCH_PROCESS' }
    : { exists: true };
}
