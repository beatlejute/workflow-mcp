import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

/**
 * Compute mcp_instance_id from current working directory (same algo as in startup-guard).
 * @returns {string}
 */
function getMcpInstanceId() {
  const cwd = process.cwd();
  const hash = createHash('sha256').update(cwd).digest('hex');
  return `workflow-mcp@${hash.slice(0, 12)}`;
}

/**
 * Atomic write via temp file + rename.
 * Falls back to O_EXCL if temp dir is on different device.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ok: true} | {ok: false, code: string, hint?: string}}
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tempName = `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(dir, tempName);

  try {
    // Try temp + rename (works on same device)
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
    return { ok: true };
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }

    // Fallback: O_EXCL on direct write
    if (err.code === 'EXDEV' || err.code === 'ENOTSUP' || err.code === 'EISDIR' || err.code === 'EEXIST') {
      try {
        const fd = fs.openSync(filePath, 'wx');
        fs.writeSync(fd, content, 'utf8');
        fs.closeSync(fd);
        return { ok: true };
      } catch (openErr) {
        if (openErr.code === 'EEXIST') {
          // File exists, overwrite with rename fallback
          try {
            fs.writeFileSync(filePath, content, 'utf8');
            return { ok: true };
          } catch (writeErr) {
            return {
              ok: false,
              code: 'WRITE_FAILED',
              hint: writeErr.message,
            };
          }
        }
        return {
          ok: false,
          code: 'WRITE_FAILED',
          hint: openErr.message,
        };
      }
    }

    return {
      ok: false,
      code: 'WRITE_FAILED',
      hint: err.message,
    };
  }
}

/**
 * Write marker file atomically.
 * Payload must include version: 1 and mcp_instance_id (added automatically if missing).
 * @param {string} projectPath - Absolute path to project root
 * @param {Object} payload - Marker payload (version, mcp_instance_id, started_at, pid, run_id)
 * @returns {{ok: true} | {ok: false, code: string, hint?: string}}
 */
export function writeMarker(projectPath, payload) {
  const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');

  // Ensure .workflow/logs directory exists
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'MKDIR_FAILED',
      hint: err.message,
    };
  }

  // Ensure required fields
  const markerData = {
    version: 1,
    mcp_instance_id: getMcpInstanceId(),
    started_at: new Date().toISOString(),
    ...payload,
  };

  const content = JSON.stringify(markerData, null, 2);

  const result = atomicWrite(markerPath, content);
  if (!result.ok) {
    return result;
  }

  return { ok: true };
}

/**
 * Read and parse marker file.
 * @param {string} projectPath - Absolute path to project root
 * @returns {Object|null} Parsed marker object or null if file doesn't exist
 */
export function readMarker(projectPath) {
  const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');

  try {
    const content = fs.readFileSync(markerPath, 'utf8');
    const data = JSON.parse(content);
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    // Re-throw parse errors to be caught by validateMarker
    throw err;
  }
}

/**
 * Validate marker file against expected PID and instance ID.
 * @param {string} projectPath - Absolute path to project root
 * @param {number} expectedPid - Expected process ID
 * @param {string} expectedInstanceId - Expected MCP instance ID
 * @returns {{valid: boolean, reason?: string, override?: boolean}}
 */
export function validateMarker(projectPath, expectedPid, expectedInstanceId) {
  // Override check — highest priority
  if (process.env.WORKFLOW_MCP_FORCE_FOREIGN === '1') {
    return { valid: true, override: true };
  }

  const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');

  // Check file existence
  if (!fs.existsSync(markerPath)) {
    return { valid: false, reason: 'MISSING' };
  }

  let marker;
  try {
    marker = readMarker(projectPath);
  } catch (err) {
    return { valid: false, reason: 'PARSE_ERROR' };
  }

  if (!marker) {
    return { valid: false, reason: 'MISSING' };
  }

  // Version check
  if (marker.version !== 1) {
    return { valid: false, reason: 'UNSUPPORTED_VERSION' };
  }

  // PID check
  if (marker.pid !== expectedPid) {
    return { valid: false, reason: 'PID_MISMATCH' };
  }

  // Instance ID check
  if (marker.mcp_instance_id !== expectedInstanceId) {
    return { valid: false, reason: 'INSTANCE_MISMATCH' };
  }

  return { valid: true };
}

/**
 * Remove marker file (idempotent).
 * @param {string} projectPath - Absolute path to project root
 * @returns {{ok: true}}
 */
export function removeMarker(projectPath) {
  const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');

  try {
    fs.unlinkSync(markerPath);
  } catch (err) {
    // Idempotent: ENOENT is not an error
    if (err.code !== 'ENOENT') {
      // Log warning but don't fail
      console.warn(`[marker] Failed to remove marker: ${err.message}`);
    }
  }

  return { ok: true };
}
