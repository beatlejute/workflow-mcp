/**
 * Исчезнувшее условие — тоже событие.
 *
 * Дедуп публикации глушит повторное появление, а об исчезновении не сообщает
 * никто: события там нет. Пока `workflow://alerts` был выжимкой из истории,
 * это совпадало с поведением ресурса. Теперь ресурс отвечает обходом, его
 * содержимое меняется в обе стороны, и подписчик обязан узнать и про вторую.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createWatcher } from '../../src/health/watcher.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';
import * as crashed from '../../src/health/detectors/crashed.mjs';

let workspace;
let watcher;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-resolved-'));
  fs.mkdirSync(path.join(workspace, 'proj', '.workflow', 'logs'), { recursive: true });
  vi.useFakeTimers();
  vi.spyOn(thresholds, 'getMcpConfig').mockReturnValue({ tick_interval_sec: 1 });
});

afterEach(() => {
  if (watcher) watcher.stop();
  watcher = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const projects = () => [{ name: 'proj', path: path.join(os.tmpdir(), 'proj') }];

function alert() {
  return {
    fingerprint: 'crashed:proj:999999',
    type: 'crashed',
    project: 'proj',
    severity: 'critical',
    detected_at: new Date().toISOString()
  };
}

describe('уведомление об исчезнувшем условии', () => {
  it('молчит, пока условие держится', () => {
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onResolved = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onResolved });

    watcher.start();
    vi.advanceTimersByTime(3000);

    expect(onResolved).not.toHaveBeenCalled();
  });

  it('зовёт колбэк, когда условие пропало', () => {
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onResolved = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onResolved });

    watcher.start();
    vi.advanceTimersByTime(1000);
    expect(onResolved).not.toHaveBeenCalled();

    detect.mockReturnValue(null);
    vi.advanceTimersByTime(1000);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('не зовёт колбэк на пустом обходе, если и до него было пусто', () => {
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(null);
    const onResolved = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onResolved });

    watcher.start();
    vi.advanceTimersByTime(3000);

    expect(onResolved).not.toHaveBeenCalled();
  });

  it('исключение из колбэка тик не роняет', () => {
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
    const onAlert = vi.fn();
    watcher = createWatcher({
      cwd: workspace,
      projects: projects(),
      onAlert,
      onResolved: () => { throw new Error('подписчик сломался'); }
    });

    watcher.start();
    vi.advanceTimersByTime(1000);
    detect.mockReturnValue(null);
    vi.advanceTimersByTime(1000);

    // Следующий тик всё ещё работает.
    detect.mockReturnValue(alert());
    vi.advanceTimersByTime(1000);

    expect(onAlert).toHaveBeenCalled();
    expect(errors.join('\n')).toContain('подписчик сломался');
  });

  it('после stop память об отпечатках сбрасывается', () => {
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onResolved = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onResolved });

    watcher.start();
    vi.advanceTimersByTime(1000);
    watcher.stop();

    // Новый запуск без условия не должен сообщать о «разрешении» того, что
    // было до остановки: подписка тоже начинается заново.
    detect.mockReturnValue(null);
    watcher.start();
    vi.advanceTimersByTime(1000);

    expect(onResolved).not.toHaveBeenCalled();
  });
});
