import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// POSIX branches in control.mjs use process.kill() (SIGSTOP/SIGCONT/SIGINT/SIGTERM/SIGKILL).
// We spy on process.kill to avoid real signals, and override process.platform to 'linux'
// so Windows branches are skipped. This lets POSIX paths run on any host OS.

import { pause, resume, abort, kill } from '../../src/process/control.mjs';

describe('POSIX platform: vi.spyOn process.kill (POSIX branches)', () => {
  let platformDescriptor;
  let killSpy;

  beforeEach(() => {
    // Override process.platform → 'linux' so POSIX branches are taken
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    // Spy on process.kill — default: returns undefined (signal delivered, no error)
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { /* success */ });
  });

  afterEach(() => {
    killSpy.mockRestore();
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pause() — POSIX SIGSTOP (lines 105-106)
  // ─────────────────────────────────────────────────────────────────────────
  describe('POSIX pause (SIGSTOP)', () => {
    it('отправляет SIGSTOP и возвращает { ok: true }', async () => {
      const result = await pause(12345);

      // POSIX branch returns sendSignal result: { ok: true } (no pid/state — Windows-only fields)
      expect(result.ok).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGSTOP');
    });

    it('возвращает NO_SUCH_PROCESS когда SIGSTOP → ESRCH', async () => {
      killSpy.mockImplementation(() => {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const result = await pause(99999);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_SUCH_PROCESS');
    });

    it('возвращает PERMISSION_DENIED когда SIGSTOP → EPERM', async () => {
      killSpy.mockImplementation(() => {
        const err = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      });

      const result = await pause(1);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PERMISSION_DENIED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // resume() — POSIX SIGCONT (lines 131-132)
  // ─────────────────────────────────────────────────────────────────────────
  describe('POSIX resume (SIGCONT)', () => {
    it('отправляет SIGCONT и возвращает { ok: true }', async () => {
      const result = await resume(12345);

      // POSIX branch returns sendSignal result: { ok: true } (no pid/state — Windows-only fields)
      expect(result.ok).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGCONT');
    });

    it('возвращает NO_SUCH_PROCESS когда SIGCONT → ESRCH', async () => {
      killSpy.mockImplementation(() => {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const result = await resume(99999);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_SUCH_PROCESS');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // kill() — POSIX SIGKILL (lines 237-245, 261-264)
  // ─────────────────────────────────────────────────────────────────────────
  describe('POSIX kill (SIGKILL)', () => {
    it('отправляет SIGKILL и возвращает { ok: true, state: "killed" }', async () => {
      const result = await kill(12345);

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(12345);
      expect(result.state).toBe('killed');
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
    });

    it('возвращает NO_SUCH_PROCESS когда SIGKILL → ESRCH (line 238-239)', async () => {
      killSpy.mockImplementation(() => {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const result = await kill(99999);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_SUCH_PROCESS');
    });

    it('возвращает PERMISSION_DENIED когда SIGKILL → EPERM (line 241-242)', async () => {
      killSpy.mockImplementation(() => {
        const err = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      });

      const result = await kill(1);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PERMISSION_DENIED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // abort() — POSIX SIGINT → wait → SIGTERM (lines 184-215)
  // ─────────────────────────────────────────────────────────────────────────
  describe('POSIX abort (SIGINT → SIGTERM)', () => {
    it('отправляет SIGINT и SIGTERM, возвращает { ok: true, state: "aborted" }', async () => {
      const result = await abort(12345, { grace_sec: 0 });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(12345);
      expect(result.state).toBe('aborted');
      expect(result.duration_ms).toBe(0);
      // SIGINT and SIGTERM both called
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGINT');
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('escalated=false при grace_sec=0 и оба сигнала доставлены', async () => {
      const result = await abort(12345, { grace_sec: 0 });

      // escalated = !sigtermResult.ok || (sigtermResult.ok && clampedGraceSec > 0)
      // = false || (true && false) = false
      expect(result.escalated).toBe(false);
    });

    it('возвращает NO_SUCH_PROCESS когда SIGINT → ESRCH (line 188-190)', async () => {
      killSpy.mockImplementation((pid, signal) => {
        if (signal === 'SIGINT') {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
      });

      const result = await abort(99999, { grace_sec: 0 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('NO_SUCH_PROCESS');
      // SIGTERM should NOT have been called (early return)
      expect(killSpy).not.toHaveBeenCalledWith(99999, 'SIGTERM');
    });

    it('возвращает PERMISSION_DENIED когда SIGINT → EPERM (line 192-194)', async () => {
      killSpy.mockImplementation((pid, signal) => {
        if (signal === 'SIGINT') {
          const err = new Error('EPERM');
          err.code = 'EPERM';
          throw err;
        }
      });

      const result = await abort(1, { grace_sec: 0 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('fallback: пробует SIGTERM когда SIGINT → UNKNOWN_ERROR (line 196-197)', async () => {
      killSpy
        .mockImplementationOnce(() => {
          // First call: SIGINT fails with unknown error
          const err = new Error('unknown');
          err.code = 'EUNKNOWN';
          throw err;
        })
        .mockImplementation(() => {
          // Second call: SIGTERM succeeds
        });

      const result = await abort(12345, { grace_sec: 0 });

      // Returns sigtermResult = { ok: true }
      expect(result.ok).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGINT');
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });
  });
});
