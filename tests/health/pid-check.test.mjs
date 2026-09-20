import { describe, it, expect, vi } from 'vitest';
import { isProcessAlive } from '../../src/health/pid-check.mjs';
import process from 'node:process';
import { spawn } from 'node:child_process';

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

    it('завершившийся процесс считается мёртвым', async () => {
      // Единственная проверка настоящей ветки платформы: все остальные тесты
      // здоровья подменяют `isProcessAlive`. Из-за этого на Windows годами
      // жила поломка — `tasklist` печатает «No tasks are running which match
      // the specified criteria», а код искал подстроку «No tasks running» и
      // считал живым любой мёртвый pid. Детектор `crashed` не мог сработать.
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      const pid = child.pid;
      await new Promise((resolve) => child.on('exit', resolve));
      // Дать системе снять запись о процессе.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(isProcessAlive(pid)).toBe(false);
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
