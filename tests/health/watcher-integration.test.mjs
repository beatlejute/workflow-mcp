import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWatcher } from '../../src/health/watcher.mjs';
import * as crashedModule from '../../src/health/detectors/crashed.mjs';
import * as stuckModule from '../../src/health/detectors/stuck.mjs';
import * as stageErrorModule from '../../src/health/detectors/stage-error.mjs';
import * as retryLoopModule from '../../src/health/detectors/retry-loop.mjs';
import * as blockedAccumulationModule from '../../src/health/detectors/blocked-accumulation.mjs';
import * as ghostExecutionModule from '../../src/health/detectors/ghost-execution.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';

describe('watcher-integration.mjs — 6 detectors in one tick', () => {
  let watcher;
  let mockOnAlert;
  let stderrSpy;

  beforeEach(() => {
    // Set up fake timers for deterministic testing
    vi.useFakeTimers();

    // Mock console.error to capture error logs
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock onAlert callback
    mockOnAlert = vi.fn();

    // Mock getMcpConfig to return known values
    vi.spyOn(thresholds, 'getMcpConfig').mockReturnValue({
      tick_interval_sec: 1,
      crash_mtime_freshness_sec: 3600,
      stuck_headroom_sec: 300,
      blocked_accumulation_threshold: 5,
      ghost_execution_log_marker: 'ghost-execution'
    });
  });

  afterEach(() => {
    // Clean up
    if (watcher && watcher.stop) {
      watcher.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Criterion 1: All 6 detectors called in one tick → onAlert called 6 times', () => {
    it('should call onAlert 6 times when all 6 detectors return alerts in one tick', () => {
      // Mock all 6 detectors to return distinct alerts
      const alert1 = { type: 'crashed', project: 'p1', severity: 'critical' };
      const alert2 = { type: 'stuck', project: 'p1', severity: 'high' };
      const alert3 = { type: 'stage_error', project: 'p1', severity: 'medium' };
      const alert4 = { type: 'retry_loop', project: 'p1', severity: 'high' };
      const alert5 = { type: 'blocked_accumulation', project: 'p1', severity: 'medium' };
      const alert6 = { type: 'ghost_execution', project: 'p1', severity: 'critical' };

      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(alert1);
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(alert2);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(alert3);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(alert4);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(alert5);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(alert6);

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick)
      vi.advanceTimersByTime(1000);

      // Verify onAlert was called exactly 6 times
      expect(mockOnAlert).toHaveBeenCalledTimes(6);

      // Verify all 6 alert types were passed to onAlert
      expect(mockOnAlert).toHaveBeenCalledWith(alert1);
      expect(mockOnAlert).toHaveBeenCalledWith(alert2);
      expect(mockOnAlert).toHaveBeenCalledWith(alert3);
      expect(mockOnAlert).toHaveBeenCalledWith(alert4);
      expect(mockOnAlert).toHaveBeenCalledWith(alert5);
      expect(mockOnAlert).toHaveBeenCalledWith(alert6);
    });

    it('should call onAlert 3 times when only 3 detectors return alerts (others return null)', () => {
      // Mock detectors: 3 return alerts, 3 return null
      const alert1 = { type: 'crashed', project: 'p1', severity: 'critical' };
      const alert2 = { type: 'stuck', project: 'p1', severity: 'high' };
      const alert3 = { type: 'stage_error', project: 'p1', severity: 'medium' };

      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(alert1);
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(alert2);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(alert3);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null); // No alert
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null); // No alert
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null); // No alert

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick)
      vi.advanceTimersByTime(1000);

      // Verify onAlert was called 3 times (only for non-null alerts)
      expect(mockOnAlert).toHaveBeenCalledTimes(3);
    });
  });

  describe('Criterion 2: Detector error handling — 5 of 6 alerts delivered even when one detector errors', () => {
    it('should deliver 5 alerts when one detector throws and other 5 return alerts', () => {
      // Mock detectors: 1 throws, 5 return alerts
      const alert1 = { type: 'stuck', project: 'p1', severity: 'high' };
      const alert2 = { type: 'stage_error', project: 'p1', severity: 'medium' };
      const alert3 = { type: 'retry_loop', project: 'p1', severity: 'high' };
      const alert4 = { type: 'blocked_accumulation', project: 'p1', severity: 'medium' };
      const alert5 = { type: 'ghost_execution', project: 'p1', severity: 'critical' };

      // detectCrashed throws an error
      vi.spyOn(crashedModule, 'detectCrashed').mockImplementation(() => {
        throw new Error('Detector error: file not found');
      });

      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(alert1);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(alert2);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(alert3);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(alert4);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(alert5);

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick)
      vi.advanceTimersByTime(1000);

      // Verify onAlert was called 5 times (5 alerts delivered despite 1 detector error)
      expect(mockOnAlert).toHaveBeenCalledTimes(5);

      // Verify error was logged
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('detectCrashed error'),
        'Detector error: file not found'
      );

      // Verify the 5 delivered alerts
      expect(mockOnAlert).toHaveBeenCalledWith(alert1);
      expect(mockOnAlert).toHaveBeenCalledWith(alert2);
      expect(mockOnAlert).toHaveBeenCalledWith(alert3);
      expect(mockOnAlert).toHaveBeenCalledWith(alert4);
      expect(mockOnAlert).toHaveBeenCalledWith(alert5);
    });

    it('should handle multiple detectors throwing errors and deliver remaining alerts', () => {
      // Mock detectors: 2 throw, 4 return alerts
      const alert1 = { type: 'stage_error', project: 'p1', severity: 'medium' };
      const alert2 = { type: 'retry_loop', project: 'p1', severity: 'high' };
      const alert3 = { type: 'blocked_accumulation', project: 'p1', severity: 'medium' };
      const alert4 = { type: 'ghost_execution', project: 'p1', severity: 'critical' };

      // detectCrashed and detectStuck throw
      vi.spyOn(crashedModule, 'detectCrashed').mockImplementation(() => {
        throw new Error('detectCrashed error');
      });
      vi.spyOn(stuckModule, 'detectStuck').mockImplementation(() => {
        throw new Error('detectStuck error');
      });

      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(alert1);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(alert2);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(alert3);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(alert4);

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick)
      vi.advanceTimersByTime(1000);

      // Verify onAlert was called 4 times (4 alerts delivered despite 2 detector errors)
      expect(mockOnAlert).toHaveBeenCalledTimes(4);

      // Verify both errors were logged
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('detectCrashed error'),
        'detectCrashed error'
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('detectStuck error'),
        'detectStuck error'
      );
    });
  });

  describe('Criterion 3: Fake timers — deterministic tick behavior', () => {
    it('should use fake timers for deterministic testing (no real sleep)', () => {
      const alert = { type: 'crashed', project: 'p1', severity: 'critical' };

      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(alert);
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(null);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // No alerts before first tick
      expect(mockOnAlert).not.toHaveBeenCalled();

      // First tick: 1ms into future
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Clear and advance to second tick
      mockOnAlert.mockClear();
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Third tick
      mockOnAlert.mockClear();
      vi.advanceTimersByTime(1000);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Verify no real delay occurred (all done instantly without real time passing)
      // The test is synchronous - if real timers were used, this test would hang
      expect(true).toBe(true); // Implicit proof: we reach this line without hanging
    });

    it('should control tick timing exactly with advanceTimersByTime', () => {
      const alert = { type: 'stuck', project: 'p1', severity: 'high' };

      vi.spyOn(crashedModule, 'detectCrashed').mockReturnValue(null);
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(alert);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      const projects = [{ path: '/test/project1' }];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance 500ms — no tick yet (tick interval is 1000ms)
      vi.advanceTimersByTime(500);
      expect(mockOnAlert).not.toHaveBeenCalled();

      // Advance to 1000ms total — tick occurs
      vi.advanceTimersByTime(500);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Advance 500ms more — no new tick yet
      vi.advanceTimersByTime(500);
      expect(mockOnAlert).toHaveBeenCalledTimes(1);

      // Advance to 2000ms total — second tick occurs
      vi.advanceTimersByTime(500);
      expect(mockOnAlert).toHaveBeenCalledTimes(2);
    });
  });

  describe('Multiple projects in one tick', () => {
    it('should call all detectors for each project in one tick', () => {
      const alertP1 = { type: 'crashed', project: 'p1', severity: 'critical' };
      const alertP2 = { type: 'crashed', project: 'p2', severity: 'critical' };

      vi.spyOn(crashedModule, 'detectCrashed')
        .mockReturnValueOnce(alertP1) // First project
        .mockReturnValueOnce(alertP2); // Second project
      vi.spyOn(stuckModule, 'detectStuck').mockReturnValue(null);
      vi.spyOn(stageErrorModule, 'detectStageError').mockReturnValue(null);
      vi.spyOn(retryLoopModule, 'detectRetryLoop').mockReturnValue(null);
      vi.spyOn(blockedAccumulationModule, 'detectBlockedAccumulation').mockReturnValue(null);
      vi.spyOn(ghostExecutionModule, 'detectGhostExecution').mockReturnValue(null);

      const projects = [
        { path: '/test/project1' },
        { path: '/test/project2' }
      ];

      watcher = createWatcher({
        cwd: '/test',
        projects,
        onAlert: mockOnAlert
      });

      watcher.start();

      // Advance time by 1 second (one tick)
      vi.advanceTimersByTime(1000);

      // Verify both project alerts were delivered (2 alerts total)
      expect(mockOnAlert).toHaveBeenCalledTimes(2);
      expect(mockOnAlert).toHaveBeenCalledWith(alertP1);
      expect(mockOnAlert).toHaveBeenCalledWith(alertP2);
    });
  });
});
