import { spawn } from 'child_process';
import process from 'process';
import os from 'os';

/**
 * Cross-platform process control module.
 * Provides pause, resume, abort, and kill operations for managing child processes.
 */

/**
 * Sends a signal to a process (POSIX-only).
 * @param {number} pid - Process ID to signal
 * @param {string} signal - Signal to send (e.g., 'SIGSTOP', 'SIGCONT', 'SIGINT', 'SIGTERM', 'SIGKILL')
 * @returns {{ok: true}} | {{ok: false, code: string, hint?: string}}
 */
function sendSignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { ok: false, code: 'NO_SUCH_PROCESS', hint: `No process with PID ${pid}` };
    }
    if (err.code === 'EPERM') {
      return { ok: false, code: 'PERMISSION_DENIED', hint: `Permission denied to signal PID ${pid}` };
    }
    return { ok: false, code: 'UNKNOWN_ERROR', hint: err.message };
  }
}

/**
 * Calls an external command via spawn (Windows helper).
 * @param {string} command - Command to execute
 * @param {string[]} args - Arguments
 * @returns {{ok: true, stdout?: string, stderr?: string} | {ok: false, code: string, hint?: string}}
 */
function callExternal(command, args) {
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
            hint: `${command} exited with code ${code}: ${stderr}`,
          });
        }
      });

      child.on('error', (err) => {
        resolve({ ok: false, code: 'SPAWN_FAILED', hint: err.message });
      });
    });
  } catch (err) {
    return { ok: false, code: 'SPAWN_FAILED', hint: err.message };
  }
}

/**
 * Pause a process (suspend execution).
 * - POSIX: Sends SIGSTOP
 * - Windows: Uses pssuspend.exe (Sysinternals), falls back to PAUSE_UNSUPPORTED
 * @param {number} pid - Process ID to pause
 * @returns {Promise<{ok: true, pid: number, state: 'paused'} | {ok: false, code: string, hint?: string}>}
 */
export async function pause(pid) {
  if (process.platform === 'win32') {
    // On Windows, we need pssuspend.exe from Sysinternals.
    // The result is cached in state-dir/process-tools.json by the caller (marker module).
    // Here we attempt to use pssuspend directly.
    const result = await callExternal('pssuspend.exe', [pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'paused' };
    }
    // If pssuspend is not available, return PAUSE_UNSUPPORTED
    return {
      ok: false,
      code: 'PAUSE_UNSUPPORTED',
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
 * @returns {Promise<{ok: true, pid: number, state: 'running'} | {ok: false, code: string, hint?: string}>}
 */
export async function resume(pid) {
  if (process.platform === 'win32') {
    // pssuspend.exe -r <pid> resumes the process
    const result = await callExternal('pssuspend.exe', ['-r', pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'running' };
    }
    return {
      ok: false,
      code: 'RESUME_UNSUPPORTED',
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
 * @returns {Promise<{ok: true, pid: number, state: 'aborted', duration_ms: number, escalated: boolean} | {ok: false, code: string, hint?: string}>}
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
  const escalationRefused = (verdict) => (
    verdict.reason === 'RUNNER_GONE'
      ? { ok: true, pid, state: 'aborted', duration_ms: clampedGraceSec * 1000, escalated: false }
      : {
          ok: false,
          code: 'OWNERSHIP_LOST',
          pid,
          reason: verdict.reason,
          hint: `Process ${pid} is no longer the pipeline runner; not escalating to a forced kill`
        }
  );

  if (process.platform === 'win32') {
    // First attempt: graceful taskkill (without /F)
    const gracefulResult = await callExternal('taskkill', ['/PID', pid.toString()]);
    if (!gracefulResult.ok) {
      // If process not found, return NO_SUCH_PROCESS
      if (gracefulResult.hint && gracefulResult.hint.includes('not found')) {
        return { ok: false, code: 'NO_SUCH_PROCESS', hint: gracefulResult.hint };
      }
      // If access denied, return PERMISSION_DENIED
      if (gracefulResult.hint && gracefulResult.hint.includes('denied')) {
        return { ok: false, code: 'PERMISSION_DENIED', hint: gracefulResult.hint };
      }
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
    const forceResult = await callExternal('taskkill', ['/F', '/PID', pid.toString()]);
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

    return forceResult;
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
 * @returns {Promise<{ok: true, pid: number, state: 'killed'} | {ok: false, code: string, hint?: string}>}
 */
export async function kill(pid) {
  if (process.platform === 'win32') {
    // Force kill with taskkill /F /T (includes child processes)
    const result = await callExternal('taskkill', ['/F', '/T', '/PID', pid.toString()]);
    if (result.ok) {
      return { ok: true, pid, state: 'killed' };
    }
    return result;
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
 * Check if a process exists and we can signal it.
 * @param {number} pid - Process ID to check
 * @returns {{exists: true} | {exists: false, code: string}}
 */
export function checkProcess(pid) {
  try {
    process.kill(pid, 0);
    return { exists: true };
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { exists: false, code: 'NO_SUCH_PROCESS' };
    }
    if (err.code === 'EPERM') {
      return { exists: true }; // Process exists but we can't signal it
    }
    return { exists: false, code: 'UNKNOWN_ERROR' };
  }
}
