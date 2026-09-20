import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createPublisher } from '../../src/health/publisher.mjs';

describe('publisher.mjs — createPublisher', () => {
  let tempDir;
  let onAlert;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-test-'));
    onAlert = vi.fn();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    vi.clearAllMocks();
  });

  /**
   * Helper to create publisher with writable state dir.
   */
  function makePublisher({ ttl, stateDirPath } = {}) {
    return createPublisher({
      onAlert,
      stateDir: {
        mode: 'writable',
        dir: stateDirPath ?? tempDir,
      },
      config: { dedup_fingerprint_ttl_sec: ttl ?? 3600 },
    });
  }

  /**
   * Build a minimal alert object with required fingerprint fields.
   */
  function alert({ type = 'error', project = 'proj', stage = 'stage1', step_number = 1, extra = {} } = {}) {
    return { type, project, stage, step_number, ...extra };
  }

  it('3 same events → onAlert called once, jsonl has 1 line', () => {
    const { publishAlert } = makePublisher({ ttl: 3600 });
    const a = alert();

    publishAlert(a);
    publishAlert(a);
    publishAlert(a);

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(a);

    const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const content = fs.readFileSync(jsonlPath, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record._fingerprint).toBeDefined();
    expect(record.type).toBe('error');
    expect(record.project).toBe('proj');
  });

  it('different fingerprints → both published and in jsonl', () => {
    const { publishAlert } = makePublisher({ ttl: 3600 });

    publishAlert(alert({ type: 'A', project: 'p', stage: 's1', step_number: 1 }));
    publishAlert(alert({ type: 'B', project: 'p', stage: 's1', step_number: 2 }));

    expect(onAlert).toHaveBeenCalledTimes(2);

    const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('restart publisher: deduplication restored from jsonl', () => {
    // First publisher instance — publish once
    const p1 = makePublisher({ ttl: 3600 });
    const a = alert();
    p1.publishAlert(a);
    expect(onAlert).toHaveBeenCalledTimes(1);

    const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines1 = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines1.length).toBe(1);

    // Reset mock for second instance
    onAlert.mockClear();

    // Second publisher instance — same stateDir, same TTL
    const p2 = makePublisher({ ttl: 3600 });
    p2.publishAlert(a);

    // Should be deduplicated (onAlert not called again)
    expect(onAlert).toHaveBeenCalledTimes(0);

    // jsonl still has only 1 line
    const lines2 = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines2.length).toBe(1);
  });

  it('mode read-only → jsonl not created, onAlert called, in-process dedup works', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-test-'));
    const { publishAlert } = createPublisher({
      onAlert,
      stateDir: { mode: 'read-only', dir },
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });

    const a = alert();
    publishAlert(a);
    publishAlert(a);

    expect(onAlert).toHaveBeenCalledTimes(1);

    const jsonlPath = path.join(dir, 'alerts-history.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);

    // In-process dedup still works
    publishAlert(a);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('after TTL expires → fingerprint can be published again', async () => {
    // Use very short TTL
    const { publishAlert } = makePublisher({ ttl: 0.001 }); // 1ms
    const a = alert();

    publishAlert(a);
    expect(onAlert).toHaveBeenCalledTimes(1);

    onAlert.mockClear();

    // Wait a bit longer than TTL
    await new Promise((r) => setTimeout(r, 10));

    publishAlert(a);
    expect(onAlert).toHaveBeenCalledTimes(1);

    const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
    // Two lines: one for first publish, one for second (after TTL)
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('publisher without stateDir (no path) → no persistence, in-memory dedup works', () => {
    const { publishAlert } = createPublisher({
      onAlert,
      stateDir: { mode: 'writable' }, // no dir
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });

    const a = alert();
    publishAlert(a);
    publishAlert(a);

    expect(onAlert).toHaveBeenCalledTimes(1);

    // No jsonl should be created (no stateDir)
    expect(fs.existsSync(path.join(tempDir, 'alerts-history.jsonl'))).toBe(false);
  });

  it('publisher with stateDir but read-only on restart → no persistence, no cross-process dedup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-test-'));

    // Writable first — should write
    const p1 = createPublisher({
      onAlert,
      stateDir: { mode: 'writable', dir },
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });
    const a = alert();
    p1.publishAlert(a);
    expect(onAlert).toHaveBeenCalledTimes(1);

    const jsonlPath = path.join(dir, 'alerts-history.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);

    onAlert.mockClear();

    // Read-only second — no persistence, memory map is fresh (no replay),
    // so same alert will trigger onAlert again (no cross-process dedup).
    const p2 = createPublisher({
      onAlert,
      stateDir: { mode: 'read-only', dir },
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });
    p2.publishAlert(a);

    // No cross-process dedup in read-only mode
    expect(onAlert).toHaveBeenCalledTimes(1);

    // jsonl unchanged (read-only never writes)
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('собственный fingerprint детектора важнее вычисленного', () => {
    // У `crashed` нет ни стадии, ни номера шага: общая формула
    // type+project+stage+step_number схлопывала все падения проекта в один
    // отпечаток и глушила второй крах на весь TTL.
    const { publishAlert } = makePublisher({ ttl: 3600 });

    publishAlert({ type: 'crashed', project: 'proj', fingerprint: 'crashed:proj:111' });
    publishAlert({ type: 'crashed', project: 'proj', fingerprint: 'crashed:proj:222' });

    expect(onAlert).toHaveBeenCalledTimes(2);
    const lines = fs.readFileSync(path.join(tempDir, 'alerts-history.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('отказ записи истории не отменяет уведомление', () => {
    // Отпечаток помечается опубликованным до записи. Пока исключение из
    // `appendFileSync` пробрасывалось наверх, колбэк не вызывался, а повтор
    // давился дедупом — алерт терялся на весь TTL.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    });

    const { publishAlert } = makePublisher({ ttl: 3600 });

    expect(() => publishAlert(alert())).not.toThrow();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    appendSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('одинаковый fingerprint детектора дедуплицируется', () => {
    const { publishAlert } = makePublisher({ ttl: 3600 });
    const a = { type: 'crashed', project: 'proj', fingerprint: 'crashed:proj:111' };

    publishAlert(a);
    publishAlert({ ...a, detected_at: new Date().toISOString() });

    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('запись в историю идёт до колбэка', () => {
    // Ресурс `workflow://alerts` читается из этого файла, а колбэк шлёт
    // клиенту `resources/updated`: при обратном порядке клиент успевал
    // прочитать ресурс без только что поднятого алерта.
    const jsonlPath = path.join(tempDir, 'alerts-history.jsonl');
    let linesAtCallback = null;
    const { publishAlert } = createPublisher({
      onAlert: () => {
        linesAtCallback = fs.existsSync(jsonlPath)
          ? fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).length
          : 0;
      },
      stateDir: { mode: 'writable', dir: tempDir },
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });

    publishAlert(alert());

    expect(linesAtCallback).toBe(1);
  });

  it('read-only in-process dedup prevents multiple onAlert calls in same process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-dedup-test-'));
    const { publishAlert } = createPublisher({
      onAlert,
      stateDir: { mode: 'read-only', dir },
      config: { dedup_fingerprint_ttl_sec: 3600 },
    });

    const a = alert();
    publishAlert(a);
    publishAlert(a);
    publishAlert(a);

    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
