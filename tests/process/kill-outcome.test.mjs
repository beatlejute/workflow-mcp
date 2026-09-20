/**
 * Запись об исходе насильственной остановки.
 *
 * Состояние `killed` дважды объявлялось починенным и дважды оставалось
 * фантомом: сперва его искали в `.workflow/logs/.killed`, потом — в строке
 * `[exit] code=N` в логе. Ни того, ни другого не пишет никто; раннер
 * workflow-ai кода выхода в лог не выводит вовсе, и ни один из 2429 настоящих
 * логов такой строки не содержит.
 *
 * Источник, который действительно существует, — тот, кто убивал. Эти проверки
 * стерегут его формат и сверку с прогоном.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeKillOutcome,
  readKillOutcome,
  killedThisRun,
  clearKillOutcome,
  killOutcomePath
} from '../../src/process/kill-outcome.mjs';

let projectRoot;

const LOCK = { pid: 4242, run_id: 'pipeline_2026-09-20_10-00-00' };

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-outcome-'));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function writeRaw(body) {
  const file = killOutcomePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('запись об убийстве прогона', () => {
  it('записывается и читается целиком', () => {
    writeKillOutcome(projectRoot, { pid: LOCK.pid, runId: LOCK.run_id, by: 'stop_pipeline' });

    const outcome = readKillOutcome(projectRoot);

    expect(outcome.pid).toBe(LOCK.pid);
    expect(outcome.run_id).toBe(LOCK.run_id);
    expect(outcome.by).toBe('stop_pipeline');
    expect(new Date(outcome.killed_at).toISOString()).toBe(outcome.killed_at);
  });

  it('каталог состояния создаётся при записи', () => {
    expect(fs.existsSync(path.join(projectRoot, '.workflow', 'state'))).toBe(false);

    expect(writeKillOutcome(projectRoot, { pid: 1, by: 'stop_pipeline' })).toBe(true);
    expect(fs.existsSync(killOutcomePath(projectRoot))).toBe(true);
  });

  it('без файла ничего не утверждается', () => {
    expect(readKillOutcome(projectRoot)).toBeNull();
    expect(killedThisRun(projectRoot, LOCK)).toBe(false);
  });

  it('снятие идемпотентно', () => {
    writeKillOutcome(projectRoot, { pid: 1, by: 'stop_pipeline' });
    clearKillOutcome(projectRoot);
    expect(readKillOutcome(projectRoot)).toBeNull();
    expect(() => clearKillOutcome(projectRoot)).not.toThrow();
  });

  it.each([
    ['пустой файл', ''],
    ['не JSON', '{ это не json'],
    ['без killed_at', JSON.stringify({ pid: 4242 })],
    ['нечитаемая дата', JSON.stringify({ killed_at: 'вчера', pid: 4242 })]
  ])('испорченная запись (%s) читается как отсутствующая', (_label, body) => {
    writeRaw(body);

    expect(readKillOutcome(projectRoot)).toBeNull();
    expect(killedThisRun(projectRoot, LOCK)).toBe(false);
  });

  describe('сверка с прогоном', () => {
    it('совпадение pid и run_id — тот самый прогон', () => {
      writeKillOutcome(projectRoot, { pid: LOCK.pid, runId: LOCK.run_id, by: 'stop_pipeline' });

      expect(killedThisRun(projectRoot, LOCK)).toBe(true);
    });

    it('другой pid — чужой прогон', () => {
      writeKillOutcome(projectRoot, { pid: LOCK.pid + 1, runId: LOCK.run_id, by: 'stop_pipeline' });

      expect(killedThisRun(projectRoot, LOCK)).toBe(false);
    });

    it('другой run_id при том же pid — чужой прогон', () => {
      // Номера процессов система переиспользует; без сверки по `run_id`
      // прошлая остановка приписала бы `killed` новому запуску.
      writeKillOutcome(projectRoot, { pid: LOCK.pid, runId: 'pipeline_2026-09-19_08-00-00', by: 'stop_pipeline' });

      expect(killedThisRun(projectRoot, LOCK)).toBe(false);
    });

    it('без run_id в записи хватает совпадения pid', () => {
      // Старые версии раннера `run_id` в lock не писали.
      writeKillOutcome(projectRoot, { pid: LOCK.pid, by: 'stop_pipeline' });

      expect(killedThisRun(projectRoot, LOCK)).toBe(true);
      expect(killedThisRun(projectRoot, { pid: LOCK.pid, run_id: null })).toBe(true);
    });

    it('без lock ничего не утверждается', () => {
      writeKillOutcome(projectRoot, { pid: LOCK.pid, runId: LOCK.run_id, by: 'stop_pipeline' });

      expect(killedThisRun(projectRoot, null)).toBe(false);
    });
  });
});
