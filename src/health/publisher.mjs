import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Compute fingerprint = first 12 chars of SHA-256(type+project+stage+step_number).
 */
function fingerprint(alert) {
  const str = `${alert.type}${alert.project}${alert.stage}${alert.step_number}`;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

/**
 * Ensure directory exists (recursive).
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Create publisher with deduplication and persistence.
 *
 * @param {Object} opts
 * @param {(alert: Object) => void} opts.onAlert - callback invoked for non-deduped alerts
 * @param {{ mode: 'read-only' | 'writable', dir?: string }} opts.stateDir - state directory config
 * @param {{ dedup_fingerprint_ttl_sec?: number }} [opts.config] - config overrides
 * @returns {{ publishAlert: (alert: Object) => void, _internal?: Object }} publisher instance
 */
export function createPublisher({ onAlert, stateDir, config = {} }) {
  if (typeof onAlert !== 'function') {
    throw new TypeError('onAlert must be a function');
  }

  const ttl = config.dedup_fingerprint_ttl_sec || 3600;
  const mode = stateDir?.mode || 'writable';
  const stateDirPath = stateDir?.dir || null;

  /** @type {Map<string, number>} */
  const lastPublished = new Map();

  const isReadonly = mode === 'read-only';
  const historyPath = stateDirPath ? path.join(stateDirPath, 'alerts-history.jsonl') : null;

  // If writable and stateDir provided, ensure directory exists and replay history.
  if (!isReadonly && stateDirPath) {
    ensureDir(stateDirPath);
    replayHistory(historyPath, ttl, lastPublished);
  }

  /**
   * Publish alert with deduplication.
   *
   * Rules:
   * 1. Compute fingerprint.
   * 2. If now - last_published_at < ttl → swallow (do not call onAlert, do not write jsonl).
   * 3. Otherwise update in-memory map, call onAlert(alert), and if not read-only + writable stateDir → append to jsonl.
   */
  function publishAlert(alert) {
    const fp = fingerprint(alert);
    const now = Date.now();

    const last = lastPublished.get(fp);
    if (last != null && now - last < ttl * 1000) {
      // Deduplicated within TTL — swallow alert.
      return;
    }

    // Update map (do this before calling onAlert so even if callback throws we've marked it published).
    lastPublished.set(fp, now);

    // Invoke callback.
    try {
      onAlert(alert);
    } catch (err) {
      // Do not let callback failure prevent persistence (if requested).
      // Re-throw so caller can handle.
      throw err;
    }

    // Persist if writable and history path available.
    if (!isReadonly && historyPath) {
      const record = {
        ...alert,
        _fingerprint: fp,
        _published_at: new Date(now).toISOString(),
      };
      const line = JSON.stringify(record);
      try {
        fs.appendFileSync(historyPath, line + '\n', { encoding: 'utf8' });
      } catch (err) {
        // If write fails we keep in-memory state.
        // Surface error silently to caller via exception (caller may want to know).
        throw err;
      }
    }
  }

  /** Expose internals for testing/debugging (non-enumerable). */
  const internal = {
    _fingerprint: fingerprint,
    _lastPublished: lastPublished,
    _historyPath: historyPath,
    _isReadonly: isReadonly,
    _ttl: ttl,
  };

  Object.defineProperty(publishAlert, '_internal', {
    value: internal,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return { publishAlert };
}

/**
 * Replay history from alerts-history.jsonl to rebuild in-memory map.
 * Only entries within TTL (relative to now) are kept.
 */
function replayHistory(historyPath, ttlSeconds, lastPublishedMap) {
  if (!historyPath || !fs.existsSync(historyPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(historyPath, 'utf8');
    const now = Date.now();
    const ttlMs = ttlSeconds * 1000;

    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const fp = record._fingerprint || fingerprint(record);
        const publishedAt = record._published_at ? new Date(record._published_at).getTime() : NaN;

        // If record has no timestamp, assume it's old (skip) or use heuristic: try to keep if present.
        if (Number.isNaN(publishedAt)) {
          // If there's a valid `published_at` or `timestamp` in record, prefer that.
          const ts = record.published_at || record.timestamp;
          const t = ts ? new Date(ts).getTime() : NaN;
          if (Number.isNaN(t)) {
            // Cannot determine age — keep entry (safer to re-publish?) We skip restoring for safety.
            continue;
          }
          if (now - t < ttlMs) {
            lastPublishedMap.set(fp, t);
          }
          continue;
        }

        if (now - publishedAt < ttlMs) {
          lastPublishedMap.set(fp, publishedAt);
        }
      } catch (err) {
        // Malformed line — skip.
        continue;
      }
    }
  } catch (err) {
    // If file cannot be read, we start with empty map.
    // This might happen due to permissions or concurrent access — ignore.
  }
}
