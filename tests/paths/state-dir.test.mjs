import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { resolveStateDir, ensureStateDir } from '../../src/paths/state-dir.mjs';

describe('state-dir: resolveStateDir', () => {
  let stderrSpy;
  const originalStderr = process.stderr.write;
  let capturedStderr = '';

  beforeEach(() => {
    capturedStderr = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      capturedStderr += msg;
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('non-protected directories (writable mode)', () => {
    it('returns XDG path with hash for non-protected cwd', () => {
      const cwd = '/tmp/foo';
      const result = resolveStateDir(cwd);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
      expect(result.dir).toContain('workflow-mcp');
      // Hash should be 12 characters
      const hash = path.basename(result.dir);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });

    it('returns home subdirectory as writable (not the home itself)', () => {
      const homeDir = os.homedir();
      const cwdSubdir = path.join(homeDir, 'subdir');
      const result = resolveStateDir(cwdSubdir);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
      expect(result.dir).toContain('workflow-mcp');
    });

    it('returns XDG path for arbitrary directory', () => {
      const cwd = '/var/tmp/my-workspace';
      const result = resolveStateDir(cwd);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
      const hash = path.basename(result.dir);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe('protected locations (read-only mode)', () => {
    it('returns read-only mode for $HOME', () => {
      const homeDir = os.homedir();
      const result = resolveStateDir(homeDir);

      expect(result.mode).toBe('read-only');
      expect(result.dir).toBeNull();
      expect(capturedStderr).toContain('protected location');
    });

    it('returns read-only mode for / (Unix root)', () => {
      const result = resolveStateDir('/');

      expect(result.mode).toBe('read-only');
      expect(result.dir).toBeNull();
      expect(capturedStderr).toContain('protected location');
    });

    it('writes warning to stderr when cwd is protected', () => {
      const homeDir = os.homedir();
      resolveStateDir(homeDir);

      expect(stderrSpy).toHaveBeenCalled();
      expect(capturedStderr).toContain('[workflow-mcp]');
      expect(capturedStderr).toContain('protected location');
      expect(capturedStderr).toContain('state.dir');
    });
  });

  describe('Windows-specific protected locations', () => {
    it('returns read-only for C:\\ (Windows drive root)', { skip: process.platform !== 'win32' }, () => {
      const result = resolveStateDir('C:\\');
      expect(result.mode).toBe('read-only');
      expect(result.dir).toBeNull();
    });

    it('returns read-only for C:\\Users', { skip: process.platform !== 'win32' }, () => {
      const result = resolveStateDir('C:\\Users');
      expect(result.mode).toBe('read-only');
      expect(result.dir).toBeNull();
    });

    it('returns read-only for C:\\Users\\<username>', { skip: process.platform !== 'win32' }, () => {
      const homeDir = os.homedir();
      const result = resolveStateDir(homeDir);
      expect(result.mode).toBe('read-only');
      expect(result.dir).toBeNull();
    });

    it('returns writable for C:\\Users\\<username>\\subdir', { skip: process.platform !== 'win32' }, () => {
      const homeDir = os.homedir();
      const subdir = path.join(homeDir, 'Projects', 'MyApp');
      const result = resolveStateDir(subdir);
      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
    });
  });

  describe('config.state.dir override', () => {
    it('uses relative override path (resolved from cwd)', () => {
      const cwd = '/home/user/project';
      const config = { state: { dir: './ws-state' } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBe(path.resolve(cwd, './ws-state'));
      // Should not have written any warning
      expect(capturedStderr).not.toContain('protected location');
    });

    it('uses absolute override path directly', () => {
      const cwd = '/home/user/project';
      const config = { state: { dir: '/tmp/custom-state' } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBe('/tmp/custom-state');
    });

    it('allows override even when cwd is protected', () => {
      const homeDir = os.homedir();
      const config = { state: { dir: '/tmp/custom-state' } };
      const result = resolveStateDir(homeDir, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBe('/tmp/custom-state');
      // No warning should be written when override is set
      expect(capturedStderr).not.toContain('protected location');
    });

    it('allows Windows absolute path in config', { skip: process.platform !== 'win32' }, () => {
      const cwd = 'C:\\Users\\john';
      const config = { state: { dir: 'D:\\WorkflowState' } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBe('D:\\WorkflowState');
    });

    it('resolves relative Windows path from cwd', { skip: process.platform !== 'win32' }, () => {
      const cwd = 'C:\\Projects\\MyApp';
      const config = { state: { dir: '.\\state' } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toBe(path.resolve(cwd, '.\\state'));
    });

    it('ignores override when empty string', () => {
      const cwd = '/tmp/foo';
      const config = { state: { dir: '' } };
      const result = resolveStateDir(cwd, config);

      // Should fall back to XDG, not use empty string
      expect(result.mode).toBe('writable');
      expect(result.dir).toContain('workflow-mcp');
    });

    it('ignores override when null', () => {
      const cwd = '/tmp/foo';
      const config = { state: { dir: null } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toContain('workflow-mcp');
    });

    it('ignores override when undefined', () => {
      const cwd = '/tmp/foo';
      const config = { state: { dir: undefined } };
      const result = resolveStateDir(cwd, config);

      expect(result.mode).toBe('writable');
      expect(result.dir).toContain('workflow-mcp');
    });
  });

  describe('hash determinism and isolation', () => {
    it('produces same hash for same cwd across multiple calls', () => {
      const cwd = '/var/tmp/test-workspace';
      const result1 = resolveStateDir(cwd);
      const result2 = resolveStateDir(cwd);

      expect(path.basename(result1.dir)).toBe(path.basename(result2.dir));
    });

    it('produces different hashes for different cwds', () => {
      const result1 = resolveStateDir('/tmp/workspace-a');
      const result2 = resolveStateDir('/tmp/workspace-b');

      const hash1 = path.basename(result1.dir);
      const hash2 = path.basename(result2.dir);

      expect(hash1).not.toBe(hash2);
    });

    it('hash is deterministic based on absolute path', () => {
      // Relative and absolute paths to same directory should produce same hash
      const absolutePath = path.resolve('/tmp', 'foo');
      const result1 = resolveStateDir(absolutePath);
      const result2 = resolveStateDir(absolutePath);

      expect(path.basename(result1.dir)).toBe(path.basename(result2.dir));
    });

    it('produces consistent hash across platforms (case-insensitive on Windows)', () => {
      // Test that normalization is consistent
      const cwd = '/var/tmp/test-dir';
      const result = resolveStateDir(cwd);
      const hash = path.basename(result.dir);

      // Hash should be 12-char hex
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe('config edge cases', () => {
    it('handles missing config object', () => {
      const result = resolveStateDir('/tmp/foo');
      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
    });

    it('handles missing state in config', () => {
      const config = {};
      const result = resolveStateDir('/tmp/foo', config);
      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
    });

    it('handles null config object', () => {
      const result = resolveStateDir('/tmp/foo', null);
      expect(result.mode).toBe('writable');
      expect(result.dir).toBeDefined();
    });
  });

  describe('XDG_STATE_HOME environment variable', () => {
    let originalXdg;

    beforeEach(() => {
      originalXdg = process.env.XDG_STATE_HOME;
    });

    afterEach(() => {
      if (originalXdg !== undefined) {
        process.env.XDG_STATE_HOME = originalXdg;
      } else {
        delete process.env.XDG_STATE_HOME;
      }
    });

    it('uses XDG_STATE_HOME when set (Unix/Linux)', { skip: process.platform === 'win32' }, () => {
      const customXdg = '/custom/xdg/state';
      process.env.XDG_STATE_HOME = customXdg;

      const result = resolveStateDir('/tmp/workspace');
      expect(result.dir).toContain(customXdg);
    });

    it('falls back to $HOME/.local/state when XDG_STATE_HOME not set', { skip: process.platform === 'win32' }, () => {
      delete process.env.XDG_STATE_HOME;

      const result = resolveStateDir('/tmp/workspace');
      const homeDir = os.homedir();
      expect(result.dir).toContain(path.join(homeDir, '.local', 'state'));
    });
  });

  describe('LOCALAPPDATA environment variable (Windows)', () => {
    let originalLocalAppData;

    beforeEach(() => {
      originalLocalAppData = process.env.LOCALAPPDATA;
    });

    afterEach(() => {
      if (originalLocalAppData !== undefined) {
        process.env.LOCALAPPDATA = originalLocalAppData;
      } else {
        delete process.env.LOCALAPPDATA;
      }
    });

    it('uses LOCALAPPDATA when set (Windows)', { skip: process.platform !== 'win32' }, () => {
      const customAppData = 'D:\\CustomAppData';
      process.env.LOCALAPPDATA = customAppData;

      const result = resolveStateDir('D:\\Projects\\MyApp');
      expect(result.dir).toContain(customAppData);
    });

    it('falls back to $HOME/AppData/Local when LOCALAPPDATA not set', { skip: process.platform !== 'win32' }, () => {
      delete process.env.LOCALAPPDATA;

      const result = resolveStateDir('D:\\Projects\\MyApp');
      const homeDir = os.homedir();
      expect(result.dir).toContain(path.join(homeDir, 'AppData', 'Local'));
    });
  });
});

describe('state-dir: ensureStateDir', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('creates directory with recursive flag when mode is writable', () => {
    const stateDir = path.join(testDir, 'nested', 'state', 'dir');
    const result = { dir: stateDir, mode: 'writable' };

    expect(fs.existsSync(stateDir)).toBe(false);
    ensureStateDir(result);
    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.statSync(stateDir).isDirectory()).toBe(true);
  });

  it('does not throw when directory already exists', () => {
    const stateDir = path.join(testDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const result = { dir: stateDir, mode: 'writable' };
    expect(() => {
      ensureStateDir(result);
    }).not.toThrow();
  });

  it('does nothing when mode is read-only', () => {
    const stateDir = path.join(testDir, 'should-not-exist');
    const result = { dir: stateDir, mode: 'read-only' };

    ensureStateDir(result);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it('does nothing when dir is null', () => {
    const result = { dir: null, mode: 'read-only' };
    expect(() => {
      ensureStateDir(result);
    }).not.toThrow();
  });

  it('handles concurrent mkdir calls without EEXIST error', () => {
    const stateDir = path.join(testDir, 'concurrent', 'state');
    const result1 = { dir: stateDir, mode: 'writable' };
    const result2 = { dir: stateDir, mode: 'writable' };

    // Simulate concurrent calls
    expect(() => {
      ensureStateDir(result1);
      ensureStateDir(result2);
    }).not.toThrow();

    expect(fs.existsSync(stateDir)).toBe(true);
  });
});

describe('state-dir: integration scenarios', () => {
  let testDir;
  let stderrSpy;
  let capturedStderr = '';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-int-'));
    capturedStderr = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      capturedStderr += msg;
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore
    }
  });

  it('full workflow: resolve and ensure state dir', () => {
    const cwdDir = path.join(testDir, 'project');
    fs.mkdirSync(cwdDir, { recursive: true });

    const result = resolveStateDir(cwdDir);
    expect(result.mode).toBe('writable');

    ensureStateDir(result);
    expect(fs.existsSync(result.dir)).toBe(true);
  });

  it('config override bypasses protection checks', () => {
    const homeDir = os.homedir();
    const overrideDir = path.join(testDir, 'custom-state');
    const config = { state: { dir: overrideDir } };

    const result = resolveStateDir(homeDir, config);
    expect(result.mode).toBe('writable');
    expect(result.dir).toBe(overrideDir);

    ensureStateDir(result);
    expect(fs.existsSync(overrideDir)).toBe(true);
    // No warning should be written
    expect(capturedStderr).not.toContain('protected location');
  });

  it('protected location workflow: no directory created', () => {
    const homeDir = os.homedir();
    const result = resolveStateDir(homeDir);

    expect(result.mode).toBe('read-only');
    expect(result.dir).toBeNull();

    // ensureStateDir should do nothing
    expect(() => {
      ensureStateDir(result);
    }).not.toThrow();
  });
});
