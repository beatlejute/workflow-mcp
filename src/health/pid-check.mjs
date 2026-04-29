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

  // Platform-specific check
  if (process.platform === 'win32') {
    return isProcessAliveWindows(pid);
  } else {
    return isProcessAlivePosix(pid);
  }
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
    // tasklist /FI "PID eq <n>" /NH
    // /FI filter by PID, /NH no header
    // If process exists: prints process info
    // If process doesn't exist: prints "No tasks running"
    const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });

    // If output is empty or contains "No tasks", process is not alive
    const trimmed = output.trim();
    return trimmed.length > 0 && !trimmed.includes('No tasks running');
  } catch (error) {
    // Timeout or command error - assume process doesn't exist
    return false;
  }
}
