import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createWatcher } from '../../src/health/watcher.mjs';
import { createPublisher } from '../../src/health/publisher.mjs';
import * as stuckModule from '../../src/health/detectors/stuck.mjs';
import * as crashedModule from '../../src/health/detectors/crashed.mjs';
import * as stageErrorModule from '../../src/health/detectors/stage-error.mjs';
import * as retryLoopModule from '../../src/health/detectors/retry-loop.mjs';
import * as blockedAccumulationModule from '../../src/health/detectors/blocked-accumulation.mjs';
import * as ghostExecutionModule from '../../src/health/detectors/ghost-execution.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';

describe('watcher E2E — full health-watcher flow (stuck + dedup + persistence)', () => {
  let tempDir;
  let mockOnAlert;
  let stderrSpy;

  beforeEach(() => {
    // Create temporary state directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-e2e-test-'));

    // Set up fake timers for deterministic testing
    vi.useFakeTimers();

    // Mock console.error to capture error logs
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock onAlert callback to track alert calls
    mockOnAlert = vi.fn();

    // Mock getMcpConfig to return fast tick interval (1 sec) and required detector config
    vi.spyOn(thresholds, 'getMcpConfig').mockReturnValue({
      tick_interval_sec: 1,
      crash_mtime_freshness_sec: 3600,
      stuck_headroom_sec: 300,
      blocked_accumulation_threshold: 5,
      ghost_execution_log_marker: 'ghost-execution',
      dedup_fingerprint_ttl_sec: 3600,
    });
  });

  afterEach(() => {
    // Clean up
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Scenario 1: stuck → alert in onAlert + record in alerts-history.jsonl', () => {
    it('should detect stuck condition, publish alert to onAlert, and persist to jsonl', () => {
      // Create a stuck alert
      const stuckAlert = {
        type: 'stuck',
        project: 'test-project',
        stage: 'build',
        step_number: 1,
        severity: 'high',
        detected_at: new Date().toISOString(),
        message: 'Process is stuck'
      };

      // Mock detectStuck to return the alert
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(stuckAlert);

      // Mock other detectors to return null (no alerts)
      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(null);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      // Create publisher that persists to tempDir
      const { publishAlert } = createPublisher({
        onAlert: mockOnAlert,
        stateDir: {
          mode: 'writable',
          dir: tempDir,
        },
        config: { dedup_fingerprint_ttl_sec: 3600 },
      });

      // Create watcher with alert callback that routes through publisher
      const watcher = createWatcher({
        cwd: '/test',
        projects: [{ path: '/test/project1' }],
        onAlert: publishAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick) + 5 sec safety margin = 6 sec
      vi.advanceTimersByTime(6000);

      watcher.stop();

      // Verify onAlert was called at least once
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Verify the alert was the stuck alert
      expect(mockOnAlert).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stuck',
        project: 'test-project'
      }));

      // Verify alerts-history.jsonl was created and has 1 line
      const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
      expect(fs.existsSync(jsonlPath)).toBe(true);

      const content = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(1);

      // Verify the record contains expected alert data
      const record = JSON.parse(lines[0]);
      expect(record._fingerprint).toBeDefined();
      expect(record.type).toBe('stuck');
      expect(record.project).toBe('test-project');
    });
  });

  describe('Scenario 2: second tick with same stuck → deduplication: onAlert not called again', () => {
    it('should deduplicate the same alert on the second tick', () => {
      // Create a stuck alert
      const stuckAlert = {
        type: 'stuck',
        project: 'test-project',
        stage: 'build',
        step_number: 1,
        severity: 'high',
        detected_at: new Date().toISOString(),
        message: 'Process is stuck'
      };

      // Mock detectStuck to always return the same alert
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(stuckAlert);

      // Mock other detectors to return null
      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(null);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      // Create publisher
      const { publishAlert } = createPublisher({
        onAlert: mockOnAlert,
        stateDir: {
          mode: 'writable',
          dir: tempDir,
        },
        config: { dedup_fingerprint_ttl_sec: 3600 },
      });

      // Create watcher
      const watcher = createWatcher({
        cwd: '/test',
        projects: [{ path: '/test/project1' }],
        onAlert: publishAlert
      });

      watcher.start();

      // First tick: should publish alert
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Second tick: same alert, should be deduplicated
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1); // Still only 1, not 2

      watcher.stop();

      // Verify jsonl has only 1 line (not 2)
      const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
      const content = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
    });
  });

  describe('Scenario 3: watcher restart → deduplication restored from jsonl, stuck event swallowed', () => {
    it('should restore deduplication state from jsonl after restart', () => {
      // Create a stuck alert
      const stuckAlert = {
        type: 'stuck',
        project: 'test-project',
        stage: 'build',
        step_number: 1,
        severity: 'high',
        detected_at: new Date().toISOString(),
        message: 'Process is stuck'
      };

      // Mock detectStuck
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(stuckAlert);

      // Mock other detectors
      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(null);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      // === First instance: publish alert ===
      const { publishAlert: publishAlert1 } = createPublisher({
        onAlert: mockOnAlert,
        stateDir: {
          mode: 'writable',
          dir: tempDir,
        },
        config: { dedup_fingerprint_ttl_sec: 3600 },
      });

      const watcher1 = createWatcher({
        cwd: '/test',
        projects: [{ path: '/test/project1' }],
        onAlert: publishAlert1
      });

      watcher1.start();
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      watcher1.stop();

      // Verify jsonl has 1 record
      const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
      let content = fs.readFileSync(jsonlPath, 'utf8').trim();
      let lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(1);

      // === Second instance: same stateDir, same alert ===
      mockOnAlert.mockClear();

      const { publishAlert: publishAlert2 } = createPublisher({
        onAlert: mockOnAlert,
        stateDir: {
          mode: 'writable',
          dir: tempDir,
        },
        config: { dedup_fingerprint_ttl_sec: 3600 },
      });

      const watcher2 = createWatcher({
        cwd: '/test',
        projects: [{ path: '/test/project1' }],
        onAlert: publishAlert2
      });

      watcher2.start();

      // First tick of second instance: alert should be swallowed (deduplicated from restored state)
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(0); // Not called because dedup is restored

      watcher2.stop();

      // Verify jsonl still has only 1 record (no new record written)
      content = fs.readFileSync(jsonlPath, 'utf8').trim();
      lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
    });
  });
});
