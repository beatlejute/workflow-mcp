import { execSync } from 'node:child_process';
import process from 'node:process';

/**
 * Что известно про процесс с этим номером.
 *
 * Три ответа, а не два. `unknown` — это «спросить не удалось»: на Windows
 * `tasklist` не нашёлся в PATH, упал или не уложился в таймаут; на POSIX
 * `kill(pid, 0)` вернул ошибку, которая не значит «процесса нет».
 *
 * Разница между `dead` и `unknown` дорогая. По `dead` сервер снимает
 * `.pipeline.lock` и разрешает новый запуск: ошибиться тут — значит поставить
 * второй пайплайн поверх живого и отнять у идущего его lock. Поэтому всё, что
 * не доказано мёртвым, считается живым, а `start_pipeline` отдаёт решение
 * человеку.
 *
 * - POSIX: `process.kill(pid, 0)`; `ESRCH` — мёртв, `EPERM` — жив (процесс
 *   есть, просто не наш), остальное — `unknown`.
 * - Windows: `tasklist /FI "PID eq <n>" /NH /FO CSV` с таймаутом 5 секунд;
 *   при сбое утилиты — второе мнение через `kill(pid, 0)`, и только если и оно
 *   не даёт ответа — `unknown`.
 *
 * @param {number} pid
 * @param {Object} [options]
 * @param {boolean} [options.fresh] спросить ОС, минуя память. Нужно тому, кто
 *   только что сам менял положение дел: после сигнала память ещё секунду
 *   отвечала бы прежним.
 * @returns {'alive'|'dead'|'unknown'}
 */
export function probeProcess(pid, { fresh = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'dead';
  }

  const cached = recentChecks.get(pid);
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.state;
  }

  const state = process.platform === 'win32'
    ? probeProcessWindows(pid)
    : probeProcessPosix(pid);

  rememberCheck(pid, state);
  return state;
}

/**
 * Жив ли процесс с этим номером.
 *
 * `unknown` считается живым: см. `probeProcess` — цена ошибки в сторону
 * «мёртв» несимметрично выше.
 *
 * @param {number} pid - Process ID to check
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  return probeProcess(pid) !== 'dead';
}

/**
 * Короткая память ответов.
 *
 * За один тик про один и тот же pid спрашивают дважды: `detectCrashed` и
 * `detectStuck`. На Windows каждый вопрос — запуск `tasklist` с таймаутом в 5
 * секунд, и тик синхронный: сервер на это время не отвечает клиенту. Окно
 * короче периода тика, поэтому состояние процесса между тиками всегда
 * перепроверяется.
 */
const CACHE_TTL_MS = 1000;
const recentChecks = new Map();

function rememberCheck(pid, state) {
  const now = Date.now();
  recentChecks.set(pid, { state, at: now });
  // Карта не должна расти вечно: pid'ы мёртвых прогонов накапливаются.
  if (recentChecks.size > 64) {
    for (const [key, value] of recentChecks) {
      if (now - value.at >= CACHE_TTL_MS) {
        recentChecks.delete(key);
      }
    }
  }
}

/** Забыть ответы. Нужно тестам, которые проверяют настоящую ветку платформы. */
/**
 * Забыть ответ про один номер.
 *
 * Нужно тому, кто сам изменил положение дел: после `taskkill` память ещё
 * секунду отвечала бы «жив», а уведомление о смене состояния уходит клиенту
 * через 200 мс.
 *
 * @param {number} pid
 */
export function forgetProcessAlive(pid) {
  recentChecks.delete(pid);
}

export function clearProcessAliveCache() {
  recentChecks.clear();
}

/**
 * `process.kill(pid, 0)`: сигнал не посылается, проверяется доступность.
 * @param {number} pid - Process ID
 * @returns {'alive'|'dead'|'unknown'}
 */
function probeProcessPosix(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    // ESRCH — процесса нет.
    if (error.code === 'ESRCH') {
      return 'dead';
    }
    // EPERM — процесс есть, просто не наш: чужой пользователь, служба,
    // процесс с большими правами.
    if (error.code === 'EPERM') {
      return 'alive';
    }
    return 'unknown';
  }
}

/**
 * Windows: `tasklist`. Отвечает и про чужие процессы, в отличие от
 * `kill(pid, 0)`, который на них даёт `EPERM`.
 * @param {number} pid - Process ID
 * @returns {'alive'|'dead'|'unknown'}
 */
function probeProcessWindows(pid) {
  try {
    // tasklist /FI "PID eq <n>" /NH /FO CSV
    // Живой процесс: "node.exe","1234","Console","1","12 345 КБ"
    // Мёртвый: одна строка вида «INFO: No tasks are running which match…»
    const output = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });

    // Решение принимается по формату строки, а не по тексту сообщения.
    // Прежняя проверка искала подстроку «No tasks running», которой нет даже
    // в английском ответе («No tasks are running which match the specified
    // criteria»), не говоря о локализованных системах, — и любой мёртвый pid
    // считался живым. Из-за этого детектор `crashed` не мог сработать на
    // Windows в принципе, а тесты этого не видели: все они подменяют
    // `isProcessAlive`.
    for (const line of output.split('\n')) {
      const fields = line.trim().split('","');
      if (fields.length >= 2 && fields[1] === String(pid)) {
        return 'alive';
      }
    }
    return 'dead';
  } catch (error) {
    // Утилита не нашлась, упала или не уложилась в таймаут. Прежде это
    // читалось как «процесса нет», и `start_pipeline` снимал lock живого
    // раннера — достаточно было занятой машины или пустого PATH у хоста MCP.
    // Второе мнение дешёвое: `kill(pid, 0)` про свои процессы отвечает точно,
    // про чужие даёт `EPERM` — тоже ответ.
    const fallback = probeProcessPosix(pid);
    return fallback === 'dead' ? 'unknown' : fallback;
  }
}
