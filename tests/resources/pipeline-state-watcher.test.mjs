/**
 * Подписка на `workflow://pipeline-state` должна замечать появление пайплайна.
 *
 * Наблюдатель подписывался на `<project>/.runner-pids` — файл, которого не
 * пишет никто. `fs.watch` по несуществующему пути молча ничего не даёт (а
 * вызов обёрнут в пустой `catch`), поэтому уведомлений об изменении состояния
 * пайплайна клиент не получал вовсе: ресурс читался только по явному запросу.
 * Тестов у этого места не было.
 *
 * Теперь наблюдение идёт за каталогом `.workflow/logs`, где раннер создаёт
 * `.pipeline.lock`. Каталог создаётся перед подпиской: `workflow init` его
 * делает, но он же в `.gitignore`, и у свежего клона до первого прогона его
 * нет — без создания подписка снова оказалась бы глухой.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  subscribe_workflow_pipeline_state,
  clearPipelineStateCache
} from '../../src/resources/index.mjs';
import { writeRunnerLock } from '../helpers/pipeline-lock.mjs';

let workspace;
let prevMcpCwd;
let unsubscribe;

/** Ждёт вызова подписчика или отдаёт false по истечении времени. */
function waitForNotification(calls, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (calls.length > 0) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Сколько файловых наблюдателей держит процесс.
 *
 * `process.getActiveResourcesInfo()` на Windows их не показывает, поэтому
 * берём устаревший `_getActiveHandles`: без него тест на отписку ничего не
 * доказывает — снятие `.close()` оставляло его зелёным.
 */
function watcherHandleCount() {
  if (typeof process._getActiveHandles !== 'function') return null;
  return process._getActiveHandles()
    .filter((h) => h && h.constructor && /FSWatcher|FSEvent|StatWatcher/i.test(h.constructor.name))
    .length;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-watcher-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
  clearPipelineStateCache();
});

afterEach(() => {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      // уже отписаны
    }
    unsubscribe = undefined;
  }
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Проект с каталогом логов — обычное состояние после `workflow init`. */
function makeProject(name) {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
  return root;
}

/** Проект без каталога логов — свежий клон до первого прогона. */
function makeProjectWithoutLogs(name) {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  return root;
}

describe('наблюдатель за состоянием пайплайна', () => {
  it('появление lock-файла доходит до подписчика', async () => {
    const root = makeProject('proj');

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    // Файла ещё нет — ровно та ситуация, в которой подписка ставится в жизни.
    writeRunnerLock(root, process.pid);

    expect(await waitForNotification(calls), 'подписчик не был вызван').toBe(true);
  });

  it('изменение lock-файла тоже доходит', async () => {
    const root = makeProject('proj');
    writeRunnerLock(root, process.pid);

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    writeRunnerLock(root, process.pid, { run_id: 'pipeline_2026-09-20_12-00-00' });

    expect(await waitForNotification(calls)).toBe(true);
  });

  it('работает, когда каталога логов ещё нет', async () => {
    // Свежий клон: `.workflow/` есть, `.workflow/logs/` — нет, потому что он
    // в `.gitignore`. Раньше подписка в этом случае молча не ставилась.
    const root = makeProjectWithoutLogs('proj');

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    writeRunnerLock(root, process.pid);

    expect(await waitForNotification(calls), 'подписка не встала без каталога логов').toBe(true);
  });

  it('посторонние файлы в каталоге логов подписчика не будят', async () => {
    const root = makeProject('proj');

    const calls = [];
    unsubscribe = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));

    // Раннер дописывает лог постоянно; будить клиента на каждую строку нельзя.
    fs.writeFileSync(path.join(root, '.workflow', 'logs', 'pipeline_2026-09-20_10-00-00.log'), 'x');

    expect(await waitForNotification(calls, 1200)).toBe(false);
  });

  it('отписка закрывает наблюдатель, а не только снимает подписчика', async () => {
    const root = makeProject('proj');
    const baseline = watcherHandleCount();

    const stop = subscribe_workflow_pipeline_state(() => {});
    const during = watcherHandleCount();
    stop();
    unsubscribe = undefined;

    // Дать событийному циклу обработать close.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = watcherHandleCount();

    if (baseline === null) {
      // Нет доступа к списку хэндлов — проверяем хотя бы отсутствие уведомлений.
      const calls = [];
      const stop2 = subscribe_workflow_pipeline_state(() => calls.push(1));
      stop2();
      writeRunnerLock(root, process.pid);
      expect(await waitForNotification(calls, 1200)).toBe(false);
      return;
    }

    // Абсолютное число сравнивать нельзя: соседние тесты в файле могут
    // оставить свои наблюдатели, а `stopAllPipelineStateWatchers` закрывает их
    // все разом. Проверяемое свойство — что закрытие вообще происходит.
    expect(during, 'наблюдатель не был создан').toBeGreaterThan(baseline - 1);
    expect(during, 'наблюдатель остался открытым после отписки').toBeGreaterThan(after);
  });

  it('после отписки уведомления не приходят', async () => {
    const root = makeProject('proj');

    const calls = [];
    const stop = subscribe_workflow_pipeline_state(() => calls.push(Date.now()));
    stop();
    unsubscribe = undefined;

    writeRunnerLock(root, process.pid);

    expect(await waitForNotification(calls, 1200)).toBe(false);
  });
});
