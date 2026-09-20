/**
 * `list_running_pipelines` — снимок состояния пайплайнов по всем проектам.
 *
 * Прежняя версия этого файла состояла из 26 тестов, в которых на всех был один
 * `expect()`, а сам инструмент не вызывался ни разу — единственный вызов был
 * закомментирован. Тесты строили фикстуры и тут же их удаляли, поэтому набор
 * был зелёным при любом поведении кода. Вдобавок фикстуры были неверны дважды:
 * `.runner-pids` клался в `.workflow/logs/`, хотя читается он из корня проекта,
 * а лог писался в формате `[STAGE_START] stage=... step=...`, которого парсер
 * не понимает.
 *
 * Здесь каждый тест вызывает инструмент и проверяет результат.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import { list_running_pipelines } from '../../src/tools/pipeline.mjs';
import { mcpInstanceId } from '../../src/lib/project-root.mjs';
import { writeAbortState, abortStatePath, ABORT_STATE_TTL_MS } from '../../src/process/abort-state.mjs';

let workspace;
let prevMcpCwd;
const victims = [];

/** Живой процесс, чей pid можно выдать за раннера. */
async function spawnVictim() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  victims.push(child);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return child;
}

/** Заведомо свободный номер процесса. */
const DEAD_PID = 999999;

/** Лог в том формате, который действительно разбирает `parsers/pipeline-log.mjs`. */
function pipelineLog({ step = 3, stage = 'execute-task' } = {}) {
  return [
    '[2026-09-20 10:00:00] [INFO] [PipelineRunner] Step 1',
    '[2026-09-20 10:00:00] [INFO] START stage="pick-first-task" agent="script"',
    '[2026-09-20 10:00:01] [INFO] COMPLETE stage="pick-first-task" status="ok" exitCode=0',
    `[2026-09-20 10:00:02] [INFO] [PipelineRunner] Step ${step}`,
    `[2026-09-20 10:00:02] [INFO] START stage="${stage}" agent="claude-sonnet"`
  ].join('\n');
}

function makeProject(name) {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'state'), { recursive: true });
  return root;
}

function writeLock(root, pid, extra = {}) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(root, '.workflow', 'logs', '.pipeline.lock'),
    JSON.stringify({ pid, timestamp: now, started_at: now, started_by: 'mcp', ...extra }, null, 2)
  );
}

function writeMarker(root, marker) {
  fs.writeFileSync(
    path.join(root, '.workflow', 'logs', '.mcp-started-by'),
    typeof marker === 'string' ? marker : JSON.stringify(marker, null, 2)
  );
}

function writeLog(root, content = pipelineLog(), name = 'pipeline_2026-09-20_10-00-00.log') {
  fs.writeFileSync(path.join(root, '.workflow', 'logs', name), content);
}

function writeApproval(root, name, payload) {
  const dir = path.join(root, '.workflow', 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payload, null, 2));
}

/** Снимок по единственному проекту в рабочем каталоге. */
async function snapshotOne() {
  const all = await list_running_pipelines.execute({});
  expect(all).toHaveLength(1);
  return all[0];
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'list-running-'));
  prevMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  while (victims.length) {
    try {
      victims.pop().kill();
    } catch {
      // мог завершиться сам
    }
  }
  if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('источник pid', () => {
  it('проект без lock пропускается', async () => {
    makeProject('proj');

    await expect(list_running_pipelines.execute({})).resolves.toEqual([]);
  });

  it('pid берётся из .pipeline.lock', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.pid).toBe(victim.pid);
    expect(entry.project).toBe('proj');
  });

});

describe('определение состояния', () => {
  it('живой pid даёт running', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);

    expect((await snapshotOne()).state).toBe('running');
  });

  it('мёртвый pid при живом lock даёт stale', async () => {
    const root = makeProject('proj');
    writeLock(root, DEAD_PID);
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.state).toBe('stale');
    expect(entry.stale_lock).toBe(true);
  });

  it('файл паузы с тем же pid даёт paused', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    fs.writeFileSync(
      path.join(root, '.workflow', 'state', 'pipeline-pause.json'),
      JSON.stringify({ pid: victim.pid, paused_at: new Date().toISOString() })
    );

    expect((await snapshotOne()).state).toBe('paused');
  });

  it('файл паузы с чужим pid состояние не меняет', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    fs.writeFileSync(
      path.join(root, '.workflow', 'state', 'pipeline-pause.json'),
      JSON.stringify({ pid: DEAD_PID, paused_at: new Date().toISOString() })
    );

    expect((await snapshotOne()).state).toBe('running');
  });

  // Состояние `aborting` раньше читалось из `.workflow/logs/.aborting` —
  // файла, которого не пишет никто, — и потому не возникало никогда. Признак
  // идущей остановки всё это время лежал рядом: `abort_pipeline` пишет
  // `.workflow/state/abort-state.json` на всё grace-окно.
  it('флаг идущего abort даёт aborting и перекрывает живой процесс', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid, { run_id: 'pipeline_2026-09-20_10-00-00' });
    writeLog(root);
    writeAbortState(root, { runnerPid: victim.pid, runId: 'pipeline_2026-09-20_10-00-00' });

    expect((await snapshotOne()).state).toBe('aborting');
  });

  it('флаг от другого pid чужому прогону состояния не меняет', async () => {
    // Сервер может умереть посреди grace-окна: файл переживёт и остановку, и
    // сам прогон. Следующий запуск не должен всю жизнь числиться aborting.
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    writeAbortState(root, { runnerPid: victim.pid + 1 });

    expect((await snapshotOne()).state).toBe('running');
  });

  it('флаг от другого прогона того же pid игнорируется', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid, { run_id: 'pipeline_2026-09-20_12-00-00' });
    writeLog(root);
    writeAbortState(root, { runnerPid: victim.pid, runId: 'pipeline_2026-09-20_10-00-00' });

    expect((await snapshotOne()).state).toBe('running');
  });

  it('протухший флаг игнорируется', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    // Старше TTL: abort с grace_sec максимум в минуту столько не идёт.
    fs.writeFileSync(
      abortStatePath(root),
      JSON.stringify({
        started_at: new Date(Date.now() - ABORT_STATE_TTL_MS - 60000).toISOString(),
        runner_pid: victim.pid
      })
    );

    expect((await snapshotOne()).state).toBe('running');
  });

  it('abort перекрывает паузу', async () => {
    // Приостановленный пайплайн, которому уже послали сигнал, для клиента
    // прежде всего останавливается.
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    fs.writeFileSync(
      path.join(root, '.workflow', 'state', 'pipeline-pause.json'),
      JSON.stringify({ pid: victim.pid, paused_at: new Date().toISOString() })
    );
    writeAbortState(root, { runnerPid: victim.pid });

    expect((await snapshotOne()).state).toBe('aborting');
  });

  it('ненулевой код выхода в логе даёт killed', async () => {
    // Состояние `killed` читалось ещё и из `.workflow/logs/.killed`, которого
    // тоже никто не писал. Оно и без маркера выводится из лога — маркер был
    // лишним чтением, а не источником.
    const root = makeProject('proj');
    writeLock(root, DEAD_PID);
    writeLog(root, '[2026-09-20 10:05:00] [exit] code=137\n');

    expect((await snapshotOne()).state).toBe('killed');
  });
});

describe('чужие пайплайны', () => {
  it('без маркера запуск считается чужим', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.foreign).toBe(true);
    expect(entry.marker_valid).toBe(false);
  });

  it('свой маркер снимает признак чужого', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeMarker(root, {
      version: 1,
      mcp_instance_id: mcpInstanceId(workspace),
      started_at: new Date().toISOString(),
      pid: victim.pid
    });
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.marker_valid).toBe(true);
    expect(entry.foreign).toBeUndefined();
  });

  it('чужой идентификатор экземпляра делает пайплайн чужим', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeMarker(root, {
      version: 1,
      mcp_instance_id: 'workflow-mcp@deadbeefdead',
      started_at: new Date().toISOString(),
      pid: victim.pid
    });
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.foreign).toBe(true);
    expect(entry.marker_reason).toBeTruthy();
  });

  it('маркер с чужим pid делает пайплайн чужим', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeMarker(root, {
      version: 1,
      mcp_instance_id: mcpInstanceId(workspace),
      started_at: new Date().toISOString(),
      pid: victim.pid + 1
    });
    writeLog(root);

    expect((await snapshotOne()).foreign).toBe(true);
  });

  it('битый маркер не роняет снимок целиком', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeMarker(root, '{ это не json');
    writeLog(root);

    const entry = await snapshotOne();

    expect(entry.pid).toBe(victim.pid);
    expect(entry.foreign).toBe(true);
  });
});

describe('ожидание одобрения', () => {
  it('pending-одобрение переводит running в paused и попадает в ответ', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    writeApproval(root, 'HUMAN-1_manual-gate-human_1.json', {
      ticket_id: 'HUMAN-1',
      stage_id: 'manual-gate-human',
      status: 'pending',
      created_at: new Date().toISOString()
    });

    const entry = await snapshotOne();

    expect(entry.state).toBe('paused');
    expect(entry.awaiting_approval).toBeTruthy();
  });

  it('решённое одобрение в ответ не попадает', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);
    writeApproval(root, 'HUMAN-1_manual-gate-human_1.json', {
      ticket_id: 'HUMAN-1',
      status: 'approved'
    });

    const entry = await snapshotOne();

    expect(entry.awaiting_approval).toBeUndefined();
    expect(entry.state).toBe('running');
  });
});

describe('данные запуска из лога', () => {
  it('run_id, стадия и номер шага берутся из последнего лога', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root, pipelineLog({ step: 7, stage: 'review-result' }));

    const entry = await snapshotOne();

    expect(entry.run_id).toBe('pipeline_2026-09-20_10-00-00');
    expect(entry.current_stage).toBe('review-result');
    expect(entry.step_number).toBe(7);
  });

  it('started_at берётся из lock', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    const stamp = '2026-09-20T08:30:00.000Z';
    writeLock(root, victim.pid, { timestamp: stamp });
    writeLog(root);

    expect((await snapshotOne()).started_at).toBe(stamp);
  });
});

describe('несколько проектов', () => {
  it('снимок собирается по всем проектам и различает их состояния', async () => {
    const victim = await spawnVictim();

    const live = makeProject('live-proj');
    writeLock(live, victim.pid);
    writeLog(live);

    const stale = makeProject('stale-proj');
    writeLock(stale, DEAD_PID);
    writeLog(stale);

    // Без pid — в снимок не попадает вовсе.
    makeProject('idle-proj');

    const all = await list_running_pipelines.execute({});
    const byName = Object.fromEntries(all.map((e) => [e.project, e]));

    expect(Object.keys(byName).sort()).toEqual(['live-proj', 'stale-proj']);
    expect(byName['live-proj'].state).toBe('running');
    expect(byName['stale-proj'].state).toBe('stale');
  });
});

describe('форма ответа', () => {
  it('обязательные поля присутствуют, внутренние — нет', async () => {
    const victim = await spawnVictim();
    const root = makeProject('proj');
    writeLock(root, victim.pid);
    writeLog(root);

    const entry = await snapshotOne();

    for (const field of ['project', 'pid', 'state', 'marker_valid', 'run_id', 'current_stage', 'step_number']) {
      expect(entry, `отсутствует поле ${field}`).toHaveProperty(field);
    }
    // Внутренняя кухня наружу не выдаётся.
    for (const field of ['lock', 'marker', 'projectRoot', 'logAgeMs']) {
      expect(entry).not.toHaveProperty(field);
    }
  });
});
