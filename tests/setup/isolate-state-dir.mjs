/**
 * Тесты не пишут в настоящее состояние машины.
 *
 * Каталог состояния и машинный кеш пути к `gh` считаются от `LOCALAPPDATA`
 * (Windows) и `XDG_STATE_HOME` (остальные). Пока эти переменные указывали на
 * настоящий профиль, набор тестов складывал туда свои следы: каждый прогон
 * оставлял пустые каталоги, а после переезда кеша `gh` на уровень машины
 * `tests/tools/git-flow-e2e.test.mjs` записывал в общий с живым сервером файл
 * путь к своему stub'у `gh` из временного каталога. Сервер верил этой записи
 * до суток — ровно до того, как `fs.access` по исчезнувшему пути не пройдёт.
 *
 * Здесь обе переменные уводятся во временный каталог на процесс. Тесты,
 * которые проверяют сам резолв, переопределяют их сами и восстанавливают —
 * им это не мешает.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-state-'));

process.env.LOCALAPPDATA = stateRoot;
process.env.XDG_STATE_HOME = stateRoot;

afterAll(() => {
  try {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // Каталог мог не появиться вовсе — это и есть желаемое состояние.
  }
});
