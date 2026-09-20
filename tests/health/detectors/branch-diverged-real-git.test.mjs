/**
 * Детектор расхождения веток на настоящем git-репозитории.
 *
 * Соседний `branch-diverged.test.mjs` подменяет `execSync` целиком, поэтому не
 * видел главного: команда была невыполнимой. Детектор звал
 * `git status -sb --no-fetch`, а такой опции у `git status` нет
 * (`error: unknown option 'no-fetch'`, код возврата 129) — вызов падал, детектор
 * молча отдавал null и при дефолтном `branch_diverged_auto_fetch: false` не
 * срабатывал ни разу. Здесь git настоящий, поэтому такую поломку видно.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { detectBranchDiverged } from '../../../src/health/detectors/branch-diverged.mjs';

const CONFIG = { branch_diverged_max_behind: 10, branch_diverged_max_ahead: 30 };

let root;
let remote;
let clone;
let plain;

/** Выполнить git в каталоге, не пуская его вывод в stderr теста. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-diverged-'));
  remote = path.join(root, 'remote.git');
  clone = path.join(root, 'clone');
  plain = path.join(root, 'plain');

  fs.mkdirSync(plain, { recursive: true });

  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'test');

  fs.writeFileSync(path.join(clone, 'file.txt'), 'first\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'first');
  git(clone, 'push', '-u', 'origin', 'main');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectBranchDiverged на настоящем git', () => {
  it('синхронная ветка алерта не даёт', () => {
    expect(detectBranchDiverged(clone, CONFIG)).toBeNull();
  });

  it('ветка, ушедшая вперёд сверх порога, даёт алерт', () => {
    // Порог `ahead` — 2, коммитов сверх origin — 3.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(clone, `extra-${i}.txt`), 'x\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-m', `extra ${i}`);
    }

    const alert = detectBranchDiverged(clone, { ...CONFIG, branch_diverged_max_ahead: 2 });

    expect(alert, 'детектор ничего не вернул на реальном расхождении').not.toBeNull();
    expect(alert.type).toBe('branch_diverged');
    expect(alert.data.ahead_count).toBe(3);
    expect(alert.data.local_branch).toBe('main');
    expect(alert.project).toBe('clone');
    // Без `detected_at` алерт выпадает из ресурса `workflow://alerts`: тот
    // отбирает записи по этому полю.
    expect(new Date(alert.detected_at).toISOString()).toBe(alert.detected_at);
  });

  it('каталог без .git не трогает git вовсе', () => {
    // Раньше на каждом не-репозитории раз в тик порождался процесс git
    // только для того, чтобы ответить `fatal: not a git repository`.
    expect(detectBranchDiverged(plain, CONFIG)).toBeNull();
  });
});
