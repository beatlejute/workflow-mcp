/**
 * Фикстура lock-файла раннера.
 *
 * `.workflow/logs/.pipeline.lock` — единственный источник pid идущего
 * пайплайна. Прежде тесты писали `.runner-pids`; файла с таким именем не
 * пишет никто, и фикстуры воспроизводили контракт, которого не существует.
 */

import fs from 'fs';
import path from 'path';
import { mcpInstanceId } from '../../src/lib/project-root.mjs';

/**
 * Кладёт lock раннера в проект.
 *
 * @param {string} projectRoot корень проекта (не `.workflow`)
 * @param {number} pid pid раннера
 * @param {Object} [extra] переопределения полей: `started_by`, `started_by_id`,
 *   `run_id`, `started_at`, `timestamp`. По умолчанию lock помечен нашей
 *   рабочей областью — так его пишет раннер при запуске из MCP. Метка
 *   считается в момент вызова: тест уже выставил свой `MCP_CWD`.
 * @returns {string} путь к записанному файлу
 */
export function writeRunnerLock(projectRoot, pid, extra = {}) {
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const now = new Date().toISOString();
  const lockPath = path.join(logsDir, '.pipeline.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        pid,
        timestamp: now,
        started_at: now,
        started_by: 'mcp',
        started_by_id: mcpInstanceId(),
        ...extra
      },
      null,
      2
    )
  );
  return lockPath;
}

/** Путь к lock-файлу проекта. */
export function runnerLockPath(projectRoot) {
  return path.join(projectRoot, '.workflow', 'logs', '.pipeline.lock');
}

/** Снимает lock, если он есть. */
export function removeRunnerLock(projectRoot) {
  try {
    fs.unlinkSync(runnerLockPath(projectRoot));
  } catch {
    // нет файла — нечего снимать
  }
}

/**
 * Кладёт lock, который нельзя использовать: пустой файл, не-JSON или JSON без
 * годного `pid`. Раннер может оставить такой при падении посреди записи —
 * инструменты обязаны отвечать `PIPELINE_NOT_RUNNING`, а не падать.
 *
 * @param {string} projectRoot
 * @param {'empty'|'garbage'|'no-pid'|'bad-pid'} [kind]
 */
export function writeBrokenLock(projectRoot, kind = 'empty') {
  const logsDir = path.join(projectRoot, '.workflow', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const body = {
    empty: '',
    garbage: '{ это не json',
    'no-pid': JSON.stringify({ timestamp: new Date().toISOString(), started_by: 'mcp' }),
    'bad-pid': JSON.stringify({ pid: 0, timestamp: new Date().toISOString() })
  }[kind];

  fs.writeFileSync(path.join(logsDir, '.pipeline.lock'), body);
}
