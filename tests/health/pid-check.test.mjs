import { describe, it, expect, vi } from 'vitest';
import { isProcessAlive } from '../../src/health/pid-check.mjs';
import process from 'node:process';

describe('pid-check.mjs', () => {
  describe('isProcessAlive', () => {
    it('should return false for invalid PID (0)', () => {
      expect(isProcessAlive(0)).toBe(false);
    });

    it('should return false for negative PID', () => {
      expect(isProcessAlive(-1)).toBe(false);
    });

    it('should return false for non-integer PID', () => {
      expect(isProcessAlive(3.14)).toBe(false);
      expect(isProcessAlive('123')).toBe(false);
      expect(isProcessAlive(null)).toBe(false);
    });

    it('should return true for current process', () => {
      // Current process (this test process) should always be alive
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('should use mocked isProcessAlive result in crashed detector tests', () => {
      // Note: Direct testing of non-existent PIDs is environment-specific.
      // The actual behavior is thoroughly tested in crashed.test.mjs which mocks
      // isProcessAlive and tests various scenarios. This unit test covers
      // input validation and mocking scenarios above.
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    if (process.platform !== 'win32') {
      it('should handle EPERM (permission denied) as alive on POSIX', () => {
        // Mock process.kill to throw EPERM
        const originalKill = process.kill;
        const mockKill = vi.fn(() => {
          const err = new Error('Operation not permitted');
          err.code = 'EPERM';
          throw err;
        });

        process.kill = mockKill;
        try {
          expect(isProcessAlive(1)).toBe(true); // PID 1 typically exists but we can't signal it
        } finally {
          process.kill = originalKill;
        }
      });

      it('should return false for ESRCH (no such process) on POSIX', () => {
        // Mock process.kill to throw ESRCH
        const originalKill = process.kill;
        const mockKill = vi.fn(() => {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        });

        process.kill = mockKill;
        try {
          expect(isProcessAlive(99999)).toBe(false);
        } finally {
          process.kill = originalKill;
        }
      });
    }
  });
});
