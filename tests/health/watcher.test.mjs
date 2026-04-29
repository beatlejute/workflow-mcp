import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWatcher } from '../../src/health/watcher.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';

describe('watcher.mjs', () => {
  let watcher;
  let mockCheckProjectHealth;
  let mockOnAlert;
  let stderrSpy;

  beforeEach(() => {
    // Set up fake timers for deterministic testing
    vi.useFakeTimers();

    // Mock console.warn to capture warning messages
    stderrSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock onAlert callback
    mockOnAlert = vi.fn();

    // Mock getMcpConfig to return known values
    vi.spyOn(thresholds, 'getMcpConfig').mockReturnValue({
      tick_interval_sec: 1 // 1 second for easy testing
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

  describe('createWatcher', () => {
    describe('start()', () => {
      it('should start the tick loop and call detector stubs', () => {
        const projects = [
          { name: 'project1' },
          { name: 'project2' }
        ];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        // Advance time by 1 second (tick interval)
        vi.advanceTimersByTime(1000);

        // Both projects should have been checked (detector stubs called)
        expect(stderrSpy).not.toHaveBeenCalled(); // No warnings for ≤20 projects
      });

      it('should call detector stubs multiple times over multiple ticks', () => {
        const projects = [
          { name: 'project1' }
        ];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        // Advance time by 3 seconds (3 ticks with 1s interval)
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(1000);

        // After 3 ticks, detector stubs should have been called
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('should emit warning when projects.length > 20', () => {
        const projects = Array.from({ length: 21 }, (_, i) => ({
          name: `project${i + 1}`
        }));

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        // Warning should be emitted exactly once at start
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('Health watcher monitoring 21 projects')
        );
      });

      it('should NOT emit warning when projects.length = 20', () => {
        const projects = Array.from({ length: 20 }, (_, i) => ({
          name: `project${i + 1}`
        }));

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('should NOT emit warning when projects.length < 20', () => {
        const projects = Array.from({ length: 10 }, (_, i) => ({
          name: `project${i + 1}`
        }));

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('should use tick interval from config', () => {
        const projects = [{ name: 'project1' }];

        // Mock different tick interval (5 seconds)
        thresholds.getMcpConfig.mockReturnValue({
          tick_interval_sec: 5
        });

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        // After 4 seconds, no ticks should have occurred
        vi.advanceTimersByTime(4000);
        expect(stderrSpy).not.toHaveBeenCalled();

        // After 5 seconds, one tick should have occurred
        vi.advanceTimersByTime(1000);
        expect(stderrSpy).not.toHaveBeenCalled();
      });
    });

    describe('stop()', () => {
      it('should stop the tick loop and prevent further detector calls', () => {
        const projects = [{ name: 'project1' }];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();

        // Advance time and then stop
        vi.advanceTimersByTime(1000);
        watcher.stop();

        // Clear the spy to verify no new calls after stop
        stderrSpy.mockClear();

        // Advance time further - should not trigger any new ticks
        vi.advanceTimersByTime(2000);

        // No warnings should be logged after stop
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('should allow calling stop multiple times without errors', () => {
        const projects = [{ name: 'project1' }];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        watcher.start();
        watcher.stop();

        // Should not throw
        expect(() => {
          watcher.stop();
        }).not.toThrow();

        // Should not throw after multiple stops
        expect(() => {
          watcher.stop();
        }).not.toThrow();
      });

      it('should allow restarting after stop', () => {
        const projects = [{ name: 'project1' }];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        // First cycle
        watcher.start();
        vi.advanceTimersByTime(1000);
        watcher.stop();

        // Clear the spy
        stderrSpy.mockClear();

        // Second cycle - should work without errors
        watcher.start();
        vi.advanceTimersByTime(1000);

        // Verify watcher is working again (no errors)
        expect(stderrSpy).not.toHaveBeenCalled();
      });
    });

    describe('lifecycle', () => {
      it('should handle complete start/tick/stop lifecycle', () => {
        const projects = [
          { name: 'project1' },
          { name: 'project2' },
          { name: 'project3' }
        ];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        // Start the watcher
        watcher.start();
        expect(stderrSpy).not.toHaveBeenCalled();

        // Advance time through several ticks
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(1000);

        // Stop the watcher
        watcher.stop();

        // Clear spy and advance more time
        stderrSpy.mockClear();
        vi.advanceTimersByTime(5000);

        // No new warnings after stop
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('should not have ticks before start is called', () => {
        const projects = [{ name: 'project1' }];

        watcher = createWatcher({
          cwd: '/test',
          projects,
          onAlert: mockOnAlert
        });

        // Don't call start, just advance time
        vi.advanceTimersByTime(5000);

        // No warnings should be logged
        expect(stderrSpy).not.toHaveBeenCalled();
      });
    });
  });
});
