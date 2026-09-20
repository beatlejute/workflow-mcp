/**
 * Уведомление идёт от изменения набора условий, а не от публикации алерта.
 *
 * Дедуп публикации глушит повтор отпечатка на весь `dedup_fingerprint_ttl_sec`
 * — по умолчанию час. Пока `workflow://alerts` был выжимкой из истории, это
 * совпадало с поведением ресурса. Теперь ресурс отвечает обходом: условие,
 * которое разрешилось и вернулось внутри часа, меняет его содержимое дважды, а
 * событий не порождало ни одного — подписчик держал пустой список до конца TTL.
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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-changed-'));
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

/** Проект теста, а не случайный путь в %TEMP%: детекторы ходят по нему всерьёз. */
const projects = () => [{ name: 'proj', path: path.join(workspace, 'proj') }];

function alert(pid = 999999) {
  return {
    fingerprint: `crashed:proj:${pid}`,
    type: 'crashed',
    project: 'proj',
    severity: 'critical',
    pid,
    detected_at: new Date().toISOString()
  };
}

describe('уведомление об изменении набора условий', () => {
  it('появление условия — событие', () => {
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(null);
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    expect(onChanged).not.toHaveBeenCalled();

    detect.mockReturnValue(alert());
    vi.advanceTimersByTime(1000);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('молчит, пока набор держится неизменным', () => {
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    expect(onChanged).toHaveBeenCalledTimes(1); // первое появление

    vi.advanceTimersByTime(5000);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('исчезновение условия — событие', () => {
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    onChanged.mockClear();

    detect.mockReturnValue(null);
    vi.advanceTimersByTime(1000);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('возврат условия внутри TTL дедупа — тоже событие', () => {
    // Дедуп публикации на этом круге молчит: отпечаток тот же, час не прошёл.
    // Содержимое ресурса при этом сменилось дважды.
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert());
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    onChanged.mockClear();

    detect.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    detect.mockReturnValue(alert());
    vi.advanceTimersByTime(1000);

    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('замена одного условия другим — событие', () => {
    // Размер набора не меняется, меняется состав: сравнение по размеру одно
    // такую подмену не заметило бы.
    const detect = vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alert(111));
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    onChanged.mockClear();

    detect.mockReturnValue(alert(222));
    vi.advanceTimersByTime(1000);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('пустой обход после пустого события не даёт', () => {
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(null);
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(3000);

    expect(onChanged).not.toHaveBeenCalled();
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
      onChanged: () => { throw new Error('подписчик сломался'); }
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
    const onChanged = vi.fn();
    watcher = createWatcher({ cwd: workspace, projects: projects(), onAlert: () => { }, onChanged });

    watcher.start();
    vi.advanceTimersByTime(1000);
    watcher.stop();
    onChanged.mockClear();

    // Новый запуск без условия не должен сообщать о «разрешении» того, что
    // было до остановки: подписка тоже начинается заново.
    detect.mockReturnValue(null);
    watcher.start();
    vi.advanceTimersByTime(1000);

    expect(onChanged).not.toHaveBeenCalled();
  });
});
