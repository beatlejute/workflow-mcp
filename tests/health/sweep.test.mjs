/**
 * Обход детекторов — общий источник для тика службы здоровья и ресурса
 * `workflow://alerts`.
 *
 * Раньше обход жил внутри `createWatcher` и вызывался только из тика, а ресурс
 * читал историю публикаций и выдавал её за текущее состояние.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runDetectorsForProject, sweepProjects } from '../../src/health/sweep.mjs';
import * as crashed from '../../src/health/detectors/crashed.mjs';
import * as stuck from '../../src/health/detectors/stuck.mjs';
import * as blocked from '../../src/health/detectors/blocked-accumulation.mjs';

let workspace;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeProject(name = 'proj') {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
  return root;
}

function alertOf(type, project, detectedAt = new Date().toISOString()) {
  return { type, project, severity: 'critical', detected_at: detectedAt, fingerprint: `${type}:${project}` };
}

describe('runDetectorsForProject', () => {
  it('собирает всё, что сработало', () => {
    const root = makeProject();
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alertOf('crashed', 'proj'));
    vi.spyOn(blocked, 'detectBlockedAccumulation').mockReturnValue(alertOf('blocked_accumulation', 'proj'));

    const alerts = runDetectorsForProject(root, {});

    expect(alerts.map((a) => a.type).sort()).toEqual(['blocked_accumulation', 'crashed']);
  });

  it('поломка одного детектора не отменяет остальные', () => {
    // Детекторы ходят в файловую систему, в `tasklist` и в `git`: любой может
    // бросить. Без защиты по одному падение первого съедало бы весь обход — а
    // вместе с ним и ответ ресурса, и тик службы здоровья.
    const root = makeProject();
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
    vi.spyOn(stuck, 'detectStuck').mockImplementation(() => {
      throw new Error('детектор сломался');
    });
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alertOf('crashed', 'proj'));

    const alerts = runDetectorsForProject(root, {});

    expect(alerts.map((a) => a.type)).toEqual(['crashed']);
    expect(errors.join('\n')).toContain('детектор сломался');
  });

  it('детектор, которому нечего сказать, в список не добавляет', () => {
    const root = makeProject();

    expect(runDetectorsForProject(root, {})).toEqual([]);
  });
});

describe('sweepProjects', () => {
  it('обходит все проекты', () => {
    makeProject('proj-a');
    makeProject('proj-b');
    vi.spyOn(crashed, 'detectCrashed').mockImplementation((projectPath) => alertOf('crashed', path.basename(projectPath)));

    const alerts = sweepProjects(workspace, [
      { path: path.join(workspace, 'proj-a') },
      { path: path.join(workspace, 'proj-b') }
    ]);

    expect(alerts.map((a) => a.project).sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('свежие алерты идут первыми', () => {
    makeProject('proj-a');
    makeProject('proj-b');
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    vi.spyOn(crashed, 'detectCrashed').mockImplementation((projectPath) => (
      path.basename(projectPath) === 'proj-a'
        ? alertOf('crashed', 'proj-a', older)
        : alertOf('crashed', 'proj-b', newer)
    ));

    const alerts = sweepProjects(workspace, [
      { path: path.join(workspace, 'proj-a') },
      { path: path.join(workspace, 'proj-b') }
    ]);

    expect(alerts.map((a) => a.project)).toEqual(['proj-b', 'proj-a']);
  });

  it('запись без пути пропускается, а не роняет обход', () => {
    makeProject('proj');
    vi.spyOn(crashed, 'detectCrashed').mockReturnValue(alertOf('crashed', 'proj'));

    const alerts = sweepProjects(workspace, [null, { name: 'без пути' }, { path: path.join(workspace, 'proj') }]);

    expect(alerts).toHaveLength(1);
  });

  it('пустой список проектов даёт пустой результат', () => {
    expect(sweepProjects(workspace, [])).toEqual([]);
  });
});
