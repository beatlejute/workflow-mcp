import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted before imports — child_process will be mocked
// when control.mjs is first imported in this file.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Import after vi.mock so control.mjs receives the mocked spawn
import { pause, resume } from '../../src/process/control.mjs';
import { spawn } from 'child_process';

/**
 * Creates a mock ChildProcess object.
 * callExternal() registers .stdout.on / .stderr.on / .on('close') / .on('error').
 * We fire the 'close' event asynchronously so the Promise resolves correctly.
 *
 * @param {number} exitCode - Exit code emitted via the 'close' event
 */
function createMockChildProcess(exitCode) {
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event, cb) => {
      if (event === 'close') {
        // Defer to next tick so all .on() registrations finish first
        setImmediate(() => cb(exitCode));
      }
    }),
  };
  return child;
}

describe('Windows platform: vi.mock child_process (DoD #5 и #6)', () => {
  let platformDescriptor;

  beforeEach(() => {
    // Force process.platform = 'win32' so Windows branches are always exercised
    // (tests are portable to POSIX CI as well)
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DoD #5: Windows ветка без pssuspend → PAUSE_UNSUPPORTED
  // ─────────────────────────────────────────────────────────────────────────
  describe('DoD #5: Windows без pssuspend → PAUSE_UNSUPPORTED', () => {
    it('pause() возвращает PAUSE_UNSUPPORTED когда pssuspend.exe завершается с ненулевым кодом', async () => {
      // exit code 1 → callExternal returns { ok: false }
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(1));

      const result = await pause(12345);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PAUSE_UNSUPPORTED');
      expect(result.hint).toBeDefined();
      expect(typeof result.hint).toBe('string');
    });

    it('pause() возвращает PAUSE_UNSUPPORTED когда spawn выбрасывает исключение (ENOENT)', async () => {
      // spawn throws → callExternal catches → { ok: false, code: 'SPAWN_FAILED' }
      // → pause returns PAUSE_UNSUPPORTED
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error('spawn pssuspend.exe ENOENT');
      });

      const result = await pause(12345);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('PAUSE_UNSUPPORTED');
    });

    it('resume() возвращает RESUME_UNSUPPORTED когда pssuspend.exe завершается с ненулевым кодом', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(1));

      const result = await resume(12345);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('RESUME_UNSUPPORTED');
      expect(result.hint).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DoD #6: Windows ветка с pssuspend → корректный exec call
  // ─────────────────────────────────────────────────────────────────────────
  describe('DoD #6: Windows с pssuspend → корректный вызов spawn', () => {
    it('pause() вызывает spawn("pssuspend.exe", [pid]) и возвращает { ok: true, state: "paused" }', async () => {
      // exit code 0 → callExternal returns { ok: true }
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      const result = await pause(12345);

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(12345);
      expect(result.state).toBe('paused');

      // Verify spawn was called with the right command and args
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'pssuspend.exe',
        ['12345'],
        expect.objectContaining({ shell: false }),
      );
    });

    it('resume() вызывает spawn("pssuspend.exe", ["-r", pid]) и возвращает { ok: true, state: "running" }', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      const result = await resume(12345);

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(12345);
      expect(result.state).toBe('running');

      // Verify spawn was called with the -r flag for resume
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'pssuspend.exe',
        ['-r', '12345'],
        expect.objectContaining({ shell: false }),
      );
    });

    it('pause() вызывает spawn ровно один раз', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      await pause(99);

      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    });

    it('resume() вызывает spawn ровно один раз', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      await resume(99);

      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    });
  });
});
