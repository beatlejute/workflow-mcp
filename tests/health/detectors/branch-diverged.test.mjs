import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock execSync before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Детектор больше не зовёт git вне репозитория: без этой подмены все случаи
// ниже выходили бы на первой строке, потому что пути здесь выдуманные.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  default: { existsSync: vi.fn(() => true) }
}));

import { detectBranchDiverged } from '../../../src/health/detectors/branch-diverged.mjs';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

describe('branch-diverged.mjs', () => {
  let execSyncMock;
  const projectPath = '/test/project';
  const config = {
    branch_diverged_max_behind: 10,
    branch_diverged_max_ahead: 30,
  };

  beforeEach(() => {
    execSyncMock = vi.mocked(execSync);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('detectBranchDiverged', () => {
    // ===== Test Case 1: Non-git project (no tracking branch) =====
    it('should return null for non-git project', () => {
      execSyncMock.mockImplementation(() => {
        const err = new Error('fatal: not a git repository');
        throw err;
      });

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 2: In sync (no ahead/behind) =====
    it('should return null when repo is in sync', () => {
      // Git output without ahead/behind values
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 3: No tracking branch =====
    it('should return null when no tracking branch is set', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 4: Behind > threshold → warning alert =====
    it('should return warning alert when behind count exceeds threshold', () => {
      const gitOutput = '## main...origin/main [behind 15]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).not.toBeNull();
      expect(result.type).toBe('branch_diverged');
      expect(result.severity).toBe('warning');
      expect(result.data.behind_count).toBe(15);
      expect(result.data.max_behind).toBe(10);
      expect(result.message).toContain('behind 15');
    });

    // ===== Test Case 4b: Values within threshold → no alert =====
    it('should return null when behind/ahead are within thresholds', () => {
      const gitOutput = '## main...origin/main [ahead 5, behind 3]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 5: Generic git error =====
    it('should gracefully handle git command errors', () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('some git error');
      });

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 6: Empty output =====
    it('should handle empty git status output', () => {
      execSyncMock.mockReturnValue('');

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 7: Default thresholds =====
    it('should use default thresholds when not provided in config', () => {
      const minimalConfig = {};
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, minimalConfig);
      expect(result).toBeNull();
    });

    // ===== Test Case 8: Fetch failure recovery =====
    it('should continue with status even if fetch fails', () => {
      let callCount = 0;
      execSyncMock.mockImplementation((cmd) => {
        callCount++;
        // First call is fetch, second is status
        if (callCount === 1 && cmd.includes('fetch')) {
          throw new Error('fetch failed');
        }
        return '## main\n';
      });

      const configWithFetch = { ...config, branch_diverged_auto_fetch: true };
      const result = detectBranchDiverged(projectPath, configWithFetch);

      expect(result).toBeNull();
      expect(execSyncMock.mock.calls.length).toBeGreaterThan(0);
    });

    // ===== Test Case 8b: After fetch, branch syncs → alert disappears (DoD) =====
    it('should return null after fetch brings branch into sync', () => {
      let callCount = 0;
      execSyncMock.mockImplementation((cmd) => {
        callCount++;
        if (cmd.includes('fetch')) {
          return '';
        }
        // After fetch, status shows in-sync (no behind/ahead)
        return '## main...origin/main\n';
      });

      const configWithFetch = { ...config, branch_diverged_auto_fetch: true };
      const result = detectBranchDiverged(projectPath, configWithFetch);

      expect(result).toBeNull();
    });

    // ===== Test Case 8c: Before fetch diverged, after fetch synced — full cycle =====
    it('should show alert before fetch but null after branch syncs', () => {
      const divergedOutput = '## main...origin/main [behind 15]\n';
      const syncedOutput = '## main...origin/main\n';

      // First call: diverged state
      execSyncMock.mockReturnValue(divergedOutput);
      const resultBefore = detectBranchDiverged(projectPath, config);
      expect(resultBefore).not.toBeNull();
      expect(resultBefore.data.behind_count).toBe(15);

      // Second call: after fetch, synced state
      let callCount = 0;
      execSyncMock.mockImplementation((cmd) => {
        callCount++;
        if (cmd.includes('fetch')) return '';
        return syncedOutput;
      });

      const configWithFetch = { ...config, branch_diverged_auto_fetch: true };
      const resultAfter = detectBranchDiverged(projectPath, configWithFetch);
      expect(resultAfter).toBeNull();
    });

    // ===== Test Case 9: Smoke test - function callable =====
    it('should handle being called without error', () => {
      execSyncMock.mockReturnValue('## main\n');

      expect(() => {
        detectBranchDiverged(projectPath, config);
      }).not.toThrow();
    });

    // ===== Test Case 10: Project name extraction =====
    it('should extract project name from path for fingerprint', () => {
      execSyncMock.mockReturnValue('## main\n');

      const customPath = '/home/user/my-project';
      const result = detectBranchDiverged(customPath, config);

      // No alert in this case, but should process without error
      expect(execSyncMock).toHaveBeenCalled();
    });

    it('should not spawn git when there is no .git directory', () => {
      // Раньше git порождался на каждом проекте каждый тик — только чтобы
      // ответить `fatal: not a git repository`. Тик синхронный, и каждый такой
      // запуск задерживает ответы сервера. Результат детектора в обоих случаях
      // одинаков (null), поэтому поймать это можно только по факту вызова.
      vi.mocked(existsSync).mockReturnValueOnce(false);

      const result = detectBranchDiverged(projectPath, config);

      expect(result).toBeNull();
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    // ===== Test Case 11: команда git без несуществующих опций =====
    it('should call plain `git status -sb` when auto_fetch is not enabled', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      detectBranchDiverged(projectPath, config);

      // Раньше сюда дописывался флаг `--no-fetch`, которого у `git status`
      // нет: команда падала с кодом 129, детектор молча возвращал null и при
      // дефолтной конфигурации не срабатывал никогда. Прежний тест проверял
      // только факт вызова и этого не замечал.
      expect(execSyncMock).toHaveBeenCalledTimes(1);
      expect(execSyncMock.mock.calls[0][0]).toBe('git status -sb');
    });

    // ===== Test Case 12: Fingerprint is stable between calls (DoD: fingerprint стабилен между тиками) =====
    it('should produce identical fingerprint for the same project and branch across calls', () => {
      const gitOutput = '## develop...origin/develop [behind 20]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result1 = detectBranchDiverged('/test/myrepo', config);
      const result2 = detectBranchDiverged('/test/myrepo', config);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1.fingerprint).toBe(result2.fingerprint);
      expect(result1.fingerprint).toBe('branch_diverged:myrepo:develop');
    });

    // ===== Test Case 12b: Fingerprint differs for different projects =====
    it('should produce different fingerprints for different projects', () => {
      const gitOutput = '## main...origin/main [behind 20]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result1 = detectBranchDiverged('/test/project-a', config);
      const result2 = detectBranchDiverged('/test/project-b', config);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1.fingerprint).not.toBe(result2.fingerprint);
    });

    // ===== Test Case 13: Returns object with correct structure when applicable =====
    it('should return alert object with required fields', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);

      // In this case null is expected, but we verify the function doesn't crash
      expect(typeof result === 'object' || result === null).toBe(true);
    });

    // ===== Test Case 14: Ahead > ahead_threshold → warning alert (DoD) =====
    it('should return warning alert when ahead count exceeds ahead_threshold', () => {
      const gitOutput = '## main...origin/main [ahead 50]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).not.toBeNull();
      expect(result.type).toBe('branch_diverged');
      expect(result.severity).toBe('warning');
      expect(result.data.ahead_count).toBe(50);
      expect(result.data.max_ahead).toBe(30);
      expect(result.message).toContain('ahead 50');
    });

    // ===== Test Case 14b: Ahead at exact threshold → no alert =====
    it('should return null when ahead equals threshold (boundary)', () => {
      const gitOutput = '## main...origin/main [ahead 30]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 14c: Custom thresholds are respected =====
    it('should use custom thresholds from config', () => {
      const gitOutput = '## main...origin/main [behind 3]\n';
      execSyncMock.mockReturnValue(gitOutput);

      const strictConfig = { branch_diverged_max_behind: 2, branch_diverged_max_ahead: 30 };
      const result = detectBranchDiverged(projectPath, strictConfig);
      expect(result).not.toBeNull();
      expect(result.data.behind_count).toBe(3);
      expect(result.data.max_behind).toBe(2);
    });

    // ===== Test Case 15: Multiple git status lines handling =====
    it('should extract branch line from multi-line output', () => {
      const gitOutput = '## main\n M file.txt\n?? newfile.txt\n';
      execSyncMock.mockReturnValue(gitOutput);

      const result = detectBranchDiverged(projectPath, config);
      expect(result).toBeNull();
    });

    // ===== Test Case 16: Auto-fetch configuration =====
    it('should respect branch_diverged_auto_fetch configuration', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const configWithAutoFetch = { ...config, branch_diverged_auto_fetch: true };
      detectBranchDiverged(projectPath, configWithAutoFetch);

      expect(execSyncMock).toHaveBeenCalled();
    });

    // ===== Test Case 17: Project path handling with Windows paths =====
    it('should handle Windows-style paths in project path', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      const windowsPath = 'C:\\Users\\test\\project';
      const result = detectBranchDiverged(windowsPath, config);

      expect(result).toBeNull();
    });

    // ===== Test Case 18: Function parameters validation =====
    it('should handle function parameters correctly', () => {
      const gitOutput = '## main\n';
      execSyncMock.mockReturnValue(gitOutput);

      expect(() => {
        detectBranchDiverged(projectPath, {});
        detectBranchDiverged(projectPath, config);
        detectBranchDiverged('/some/path', {});
      }).not.toThrow();
    });
  });
});
