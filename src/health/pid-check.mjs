import { execSync } from 'node:child_process';
import process from 'node:process';

/**
 * Check if a process is alive.
 *
 * Platform-specific implementation:
 * - POSIX: uses process.kill(pid, 0) - no signal sent, just availability check
 * - Windows: uses tasklist /FI "PID eq <n>" /NH with 2-second timeout
 *
 * @param {number} pid - Process ID to check
 * @returns {boolean} true if process is alive, false if not
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const cached = recentChecks.get(pid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.alive;
  }

  // Platform-specific check
  const alive = process.platform === 'win32'
    ? isProcessAliveWindows(pid)
    : isProcessAlivePosix(pid);

  rememberCheck(pid, alive);
  return alive;
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

function rememberCheck(pid, alive) {
  const now = Date.now();
  recentChecks.set(pid, { alive, at: now });
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
export function clearProcessAliveCache() {
  recentChecks.clear();
}

/**
 * POSIX implementation using process.kill(pid, 0)
 * @param {number} pid - Process ID
 * @returns {boolean}
 */
function isProcessAlivePosix(pid) {
  try {
    // Signal 0 means: check if we can send a signal to this process
    // If process doesn't exist, throws with code ESRCH
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process
    // EPERM = permission denied (process exists but we can't signal it)
    if (error.code === 'ESRCH') {
      return false;
    }
    // For EPERM or other errors, assume process exists
    return true;
  }
}

/**
 * Windows implementation using tasklist command
 * @param {number} pid - Process ID
 * @returns {boolean}
 */
function isProcessAliveWindows(pid) {
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
        return true;
      }
    }
    return false;
  } catch (error) {
    // Timeout or command error - assume process doesn't exist
    return false;
  }
}
