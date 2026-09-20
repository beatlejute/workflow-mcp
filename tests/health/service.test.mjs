/**
 * Служба здоровья: замкнутая цепочка детекторы → дедуп → уведомление.
 *
 * Цепочки не было вовсе. `watcher.mjs` и `publisher.mjs` были написаны и
 * покрыты тестами по отдельности, но никто не создавал ни того, ни другого:
 * в `server.mjs` под именем `createHealthWatcher` стоял таймер, печатавший
 * «server alive» в stderr. Ресурс `workflow://alerts` при этом был
 * зарегистрирован и всегда отдавал пустой список.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createHealthService } from '../../src/health/service.mjs';
import * as pidCheck from '../../src/health/pid-check.mjs';
import * as thresholds from '../../src/health/thresholds.mjs';
import { writeRunnerLock } from '../helpers/pipeline-lock.mjs';

describe('createHealthService', () => {
  const DEAD_PID = 999999999;

  let workspace;
  let stateDir;
  let service;

  /** Проект с мёртвым раннером и свежим логом — источник алерта `crashed`. */
  function makeCrashedProject(name) {
    const root = path.join(workspace, name);
    const logsDir = path.join(root, '.workflow', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    writeRunnerLock(root, DEAD_PID, { run_id: `run-${name}` });
    fs.writeFileSync(path.join(logsDir, `pipeline_run-${name}.log`), 'log', 'utf8');
    return { name, path: root };
  }

  /** `.workflow-mcp.yaml` рабочей области: тик в секунду, чтобы не ждать. */
  function writeConfig(extra = '') {
    fs.writeFileSync(
      path.join(workspace, '.workflow-mcp.yaml'),
      `health:\n  tick_interval_sec: 1\n${extra}`,
      'utf8'
    );
  }

  function historyLines() {
    const file = path.join(stateDir, 'alerts-history.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'health-service-'));
    stateDir = path.join(workspace, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    // Настоящая проверка pid на Windows уходит в `tasklist` — сотни
    // миллисекунд на каждый тик.
    vi.spyOn(pidCheck, 'isProcessAlive').mockImplementation(pid => pid !== DEAD_PID);
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (service) {
      service.stop();
      service = undefined;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('алерт детектора доходит до колбэка и до истории', () => {
    writeConfig();
    const projects = [makeCrashedProject('proj')];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert)
    });
    expect(service.start()).toBe(true);

    vi.advanceTimersByTime(1000);

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('crashed');
    expect(seen[0].project).toBe('proj');
    expect(seen[0].pid).toBe(DEAD_PID);
    expect(historyLines()).toHaveLength(1);
  });

  it('onChanged доходит от тика через службу', () => {
    // Связка «тик → служба → сервер» иначе покрыта только e2e-тестом: сама
    // служба колбэк лишь пробрасывает, и потерять его здесь проще всего.
    writeConfig();
    const projects = [makeCrashedProject('proj')];
    const changes = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: () => { },
      onChanged: () => changes.push(Date.now())
    });
    service.start();

    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(1);

    // Условие держится — состав набора тот же, события нет.
    vi.advanceTimersByTime(2000);
    expect(changes).toHaveLength(1);

    // Условие исчезло: дедуп публикации об этом молчит, служба — нет.
    fs.rmSync(path.join(workspace, 'proj', '.workflow', 'logs', '.pipeline.lock'));
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(2);
  });

  it('повторные тики не размножают один и тот же алерт', () => {
    writeConfig();
    const projects = [makeCrashedProject('proj')];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert)
    });
    service.start();

    vi.advanceTimersByTime(5000);

    // Раннер мёртв всё это время, детектор срабатывает каждый тик — клиент
    // должен получить одно уведомление, а не пять.
    expect(seen).toHaveLength(1);
    expect(historyLines()).toHaveLength(1);
  });

  it('история пишется до колбэка', () => {
    // Ресурс `workflow://alerts` читается из этого же файла, а колбэк шлёт
    // клиенту `resources/updated`. При обратном порядке клиент успевал
    // прочитать ресурс без только что поднятого алерта.
    writeConfig();
    const projects = [makeCrashedProject('proj')];
    let linesAtCallback = null;

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: () => { linesAtCallback = historyLines().length; }
    });
    service.start();

    vi.advanceTimersByTime(1000);

    expect(linesAtCallback).toBe(1);
  });

  it('исключение из колбэка не отменяет запись и не ломает тик', () => {
    writeConfig();
    const projects = [makeCrashedProject('one'), makeCrashedProject('two')];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => {
        seen.push(alert.project);
        throw new Error('клиент отвалился');
      }
    });
    service.start();

    vi.advanceTimersByTime(1000);

    // Второй проект проверен, хотя колбэк первого бросил исключение.
    expect(seen).toEqual(['one', 'two']);
    expect(historyLines()).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('список проектов берётся функцией и обновляется на лету', () => {
    // discovery пересобирает список; захваченный при старте массив устарел бы
    // после первого же появления проекта.
    writeConfig();
    let projects = [];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects: () => projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert.project)
    });
    service.start();

    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);

    projects = [makeCrashedProject('late')];
    vi.advanceTimersByTime(1000);

    expect(seen).toEqual(['late']);
  });

  it('исключение внутри тика не убивает службу', () => {
    // Проверяется защита тела тика, а не `start()`. Первый вызов функции
    // списка проектов происходит в `start()` (подсчёт для предупреждения о
    // числе проектов) и ловится там же, поэтому ронять надо то, что зовётся
    // только внутри тика, — чтение конфига.
    writeConfig();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects: () => [makeCrashedProject('after')],
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert.project)
    });
    service.start();

    vi.spyOn(thresholds, 'getMcpConfig').mockImplementationOnce(() => {
      throw new Error('конфиг не читается');
    });

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(seen).toEqual([]);

    // Служба пережила отказ: следующий тик проходит обычным порядком.
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['after']);

    errorSpy.mockRestore();
  });

  it('отказ функции списка проектов не убивает службу', () => {
    // Список пересобирает discovery: его поломка не причина ронять сервер.
    writeConfig();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let broken = true;
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects: () => {
        if (broken) throw new Error('discovery сломалась');
        return [makeCrashedProject('after')];
      },
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert.project)
    });

    expect(() => service.start()).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(seen).toEqual([]);

    broken = false;
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['after']);

    errorSpy.mockRestore();
  });

  it('health.enabled: false выключает службу', () => {
    writeConfig('  enabled: false\n');
    const projects = [makeCrashedProject('proj')];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert)
    });

    expect(service.enabled).toBe(false);
    expect(service.start()).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
    expect(historyLines()).toEqual([]);
  });

  it('stop останавливает тики', () => {
    writeConfig();
    let projects = [];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects: () => projects,
      stateDir: { dir: stateDir, mode: 'writable' },
      onAlert: (alert) => seen.push(alert)
    });
    service.start();
    service.stop();

    projects = [makeCrashedProject('proj')];
    vi.advanceTimersByTime(5000);

    expect(seen).toEqual([]);
  });

  it('на read-only каталоге состояния алерты идут без истории', () => {
    writeConfig();
    const projects = [makeCrashedProject('proj')];
    const seen = [];

    service = createHealthService({
      cwd: workspace,
      projects,
      stateDir: { dir: stateDir, mode: 'read-only' },
      onAlert: (alert) => seen.push(alert)
    });
    service.start();

    vi.advanceTimersByTime(1000);

    expect(seen).toHaveLength(1);
    expect(historyLines()).toEqual([]);
  });
});
