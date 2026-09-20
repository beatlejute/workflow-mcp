/**
 * Каталог состояния заводит запись, а не запуск.
 *
 * Публикатор создавал каталог в момент создания — то есть на каждом запуске
 * сервера в каждой рабочей области, включая временные каталоги тестов. На
 * машине их накопилось 15 789 пустых при одном каталоге с историей: алерт за
 * всё время записался единственный раз.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPublisher } from '../../src/health/publisher.mjs';

let base;
let stateDirPath;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-lazy-'));
  stateDirPath = path.join(base, 'state');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function alert(fingerprint = 'stuck:proj:execute-task:run-1') {
  return {
    fingerprint,
    type: 'stuck',
    severity: 'critical',
    project: 'proj',
    message: 'stage stuck',
    detected_at: new Date().toISOString()
  };
}

describe('каталог состояния создаётся лениво', () => {
  it('создание публикатора каталога не заводит', () => {
    createPublisher({ onAlert: () => { }, stateDir: { dir: stateDirPath, mode: 'writable' } });

    expect(fs.existsSync(stateDirPath)).toBe(false);
  });

  it('первая публикация каталог создаёт и пишет историю', () => {
    const seen = [];
    const publisher = createPublisher({
      onAlert: (a) => seen.push(a),
      stateDir: { dir: stateDirPath, mode: 'writable' }
    });

    publisher.publishAlert(alert());

    expect(fs.existsSync(path.join(stateDirPath, 'alerts-history.jsonl'))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('история прошлого запуска читается и без создания каталога заранее', () => {
    fs.mkdirSync(stateDirPath, { recursive: true });
    // Без `_fingerprint`: отпечаток считает та же функция, что и при
    // публикации, — запись в истории и новый алерт обязаны совпасть.
    const record = {
      ...alert(),
      _published_at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(stateDirPath, 'alerts-history.jsonl'), JSON.stringify(record) + '\n', 'utf8');

    const seen = [];
    const publisher = createPublisher({
      onAlert: (a) => seen.push(a),
      stateDir: { dir: stateDirPath, mode: 'writable' }
    });

    // Тот же отпечаток в пределах TTL — дедуп обязан сработать по
    // перечитанной истории, иначе ленивое создание сломало бы дедуп.
    publisher.publishAlert(alert());

    expect(seen).toHaveLength(0);
  });

  it('read-only каталог не создаётся и на публикации', () => {
    const publisher = createPublisher({
      onAlert: () => { },
      stateDir: { dir: stateDirPath, mode: 'read-only' }
    });

    publisher.publishAlert(alert());

    expect(fs.existsSync(stateDirPath)).toBe(false);
  });
});
