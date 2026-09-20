/**
 * Наблюдатели не просыпаются на служебные файлы каталога.
 *
 * `.gitkeep.md`, который `workflow init` кладёт в каждый каталог тикетов,
 * проходил фильтр «оканчивается на .md» и будил наблюдателя за human-очередью
 * на каждое своё изменение.
 */

import { describe, it, expect } from 'vitest';
import { FsOrPollWatcher } from '../../src/watchers/fs-or-poll.mjs';

const watcher = new FsOrPollWatcher({ projects: [] });

describe('FsOrPollWatcher.isRelevantFile', () => {
  it('human-тикет относится к делу', () => {
    expect(watcher.isRelevantFile('HUMAN-12.md')).toBe(true);
  });

  it('обычный тикет тоже: тип проверяет обработчик по frontmatter', () => {
    expect(watcher.isRelevantFile('IMPL-3.md')).toBe(true);
  });

  it('служебный .gitkeep.md наблюдателя не будит', () => {
    expect(watcher.isRelevantFile('.gitkeep.md')).toBe(false);
  });

  it('не markdown не будит', () => {
    expect(watcher.isRelevantFile('notes.txt')).toBe(false);
  });
});
