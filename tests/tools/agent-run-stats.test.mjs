import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get_agent_run_stats, get_agent_run_stats_tool } from '../../src/tools/agent-runs.mjs';

let workspace;
let previousMcpCwd;
let projectRoots;

function project(name) {
  return projectRoots[name];
}

function writeJournal(projectRoot, events) {
  const file = path.join(projectRoot, '.workflow', 'metrics', 'agent-runs.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function run({ project: agentProject = 'PulseProxy', ...overrides }) {
  const ts = overrides.ts ?? '2026-10-11T20:00:00.000Z';
  return {
    type: 'run',
    ts,
    started_at: overrides.started_at ?? ts,
    run_key: `${agentProject}-${overrides.ticket || 'ticket'}`,
    stage: 'execute-task',
    skill: 'execute-task',
    ticket: 'QA-SHARED',
    ticket_type: 'qa',
    agent: `agent-${agentProject}`,
    model: 'model-a',
    status: 'ok',
    changed_files: 2,
    ...overrides,
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-run-report-'));
  previousMcpCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
  projectRoots = {};
  for (const name of ['PulseProxy', 'HegelCodec']) {
    projectRoots[name] = path.join(workspace, name);
    fs.mkdirSync(path.join(projectRoots[name], '.workflow'), { recursive: true });
  }
});

afterEach(() => {
  if (previousMcpCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = previousMcpCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('get_agent_run_stats', () => {
  it('aggregates discovered projects by model, applies inclusive local dates, and keeps status separate from grade', async () => {
    const accepted = run({ project: 'PulseProxy', ticket: 'QA-SHARED', run_key: 'p-accepted', ts: '2026-10-10T19:00:00.000Z' });
    const before = run({ project: 'PulseProxy', ticket: 'QA-BEFORE', run_key: 'p-before', model: 'outside-before', ts: '2026-10-10T18:59:59.999Z' });
    const verifyAfterRange = {
      type: 'verify', ts: '2026-10-12T20:00:00.000Z', ticket: accepted.ticket,
      ticket_type: 'qa', status: 'all_green', fail_reasons: [],
    };
    const crashedSameTicketId = run({
      project: 'HegelCodec', ticket: 'QA-SHARED', run_key: 'h-crashed', model: 'model-a',
      status: 'error', changed_files: 0, ts: '2026-10-12T18:59:59.999Z',
    });
    const atEnd = run({ project: 'HegelCodec', ticket: 'QA-END', run_key: 'h-end', model: 'outside-end', ts: '2026-10-12T19:00:00.000Z' });
    const judge = {
      type: 'run', ts: '2026-10-12T10:00:00.000Z', started_at: '2026-10-12T10:00:00.000Z', run_key: 'h-judge',
      stage: 'review-result', skill: 'review-result', ticket: 'QA-JUDGE', ticket_type: 'qa',
      agent: 'judge', model: 'judge-model', status: 'error', changed_files: null,
    };
    writeJournal(project('PulseProxy'), [accepted, verifyAfterRange, before]);
    writeJournal(project('HegelCodec'), [crashedSameTicketId, atEnd, judge]);

    const openRun = {
      run_key: 'p-open', ts: '2026-10-12T12:00:00.000Z', stage: 'execute-task',
      skill: 'execute-task', ticket: 'QA-OPEN', ticket_type: 'qa', agent: 'free-kilo@unknown', model: null,
    };
    const openPath = path.join(project('PulseProxy'), '.workflow', 'state', 'agent-run-open.json');
    fs.mkdirSync(path.dirname(openPath), { recursive: true });
    fs.writeFileSync(openPath, `${JSON.stringify(openRun)}\n`);

    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', utc_offset: '+05:00', limit: 10,
    });
    expect(report.error).toBeUndefined();
    expect(report.complete).toBe(true);
    expect(report.projects).toEqual(['HegelCodec', 'PulseProxy']);
    expect(report.utc_interval).toEqual({
      from_inclusive: '2026-10-10T19:00:00.000Z',
      to_exclusive: '2026-10-12T19:00:00.000Z',
    });
    expect(report.totals).toMatchObject({
      starts: 4,
      process_ok: 1,
      process_statuses: { ok: 1, error: 2, pending: 1 },
      executor_starts: 3,
      executor_graded: 3,
      executor_ungraded: 0,
      executor_grades: { accepted: 1, crashed: 1, pending: 1 },
      open_starts: 1,
      unplaced_starts: 0,
    });
    const modelA = report.rows.find((row) => row.model === 'model-a');
    expect(modelA).toMatchObject({
      starts: 2,
      process_ok: 1,
      process_statuses: { ok: 1, error: 1 },
      executor_starts: 2,
      executor_graded: 2,
      executor_grades: { accepted: 1, crashed: 1 },
      projects: ['HegelCodec', 'PulseProxy'],
      ticket_types: ['qa'],
    });
    expect(report.rows.find((row) => row.model === 'judge-model')).toMatchObject({
      starts: 1,
      process_statuses: { error: 1 },
      executor_starts: 0,
    });
    expect(report.rows.find((row) => row.model === null)).toMatchObject({
      starts: 1,
      process_statuses: { pending: 1 },
      executor_grades: { pending: 1 },
      open_starts: 1,
    });
  });

  it('paginates model rows after aggregating totals and applies exact model filter', async () => {
    writeJournal(project('PulseProxy'), [
      run({ project: 'PulseProxy', ticket: 'QA-A', run_key: 'a', model: 'model-a' }),
      run({ project: 'PulseProxy', ticket: 'QA-B', run_key: 'b', model: 'model-b' }),
    ]);
    const page = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-11', utc_offset: '+00:00',
      projects: ['PulseProxy'], limit: 1, offset: 0,
    });
    expect(page.total_rows).toBe(2);
    expect(page.rows.map((row) => row.model)).toEqual(['model-a']);
    expect(page.next_offset).toBe(1);
    expect(page.totals.starts).toBe(2);

    const filtered = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-11', projects: ['PulseProxy'], model: 'model-b',
    });
    expect(filtered.total_rows).toBe(1);
    expect(filtered.rows.map((row) => row.model)).toEqual(['model-b']);
    expect(filtered.totals.starts).toBe(1);
  });

  it('validates calendar dates and offsets', async () => {
    expect(await get_agent_run_stats({ date_from: '2026-02-30', date_to: '2026-03-01' }))
      .toMatchObject({ error: 'INVALID_DATE_RANGE' });
    expect(await get_agent_run_stats({ date_from: '2026-10-12', date_to: '2026-10-11' }))
      .toMatchObject({ error: 'INVALID_DATE_RANGE' });
    expect(await get_agent_run_stats({ date_from: '2026-10-11', date_to: '2026-10-12', utc_offset: '+14:01' }))
      .toMatchObject({ error: 'INVALID_DATE_RANGE' });
    expect(get_agent_run_stats_tool.inputSchema.safeParse({ date_from: '2026-10-11', date_to: '2026-10-12' }).success).toBe(true);
    expect(get_agent_run_stats_tool.inputSchema.safeParse({ date_from: 'yesterday', date_to: 'today' }).success).toBe(false);
  });

  it('marks an invalid project incomplete while retaining rows from discovered projects', async () => {
    writeJournal(project('PulseProxy'), [run({ project: 'PulseProxy', ticket: 'QA-VALID', run_key: 'valid' })]);
    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy', 'not-a-project'],
    });
    expect(report.complete).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ project: 'not-a-project', code: 'INVALID_PROJECT' }));
    expect(report.totals.starts).toBe(1);
  });

  it('missing journal is a complete empty project, while unreadable journal is reported incomplete', async () => {
    const empty = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
    });
    expect(empty.complete).toBe(true);
    expect(empty.totals.starts).toBe(0);

    const brokenFile = path.join(project('HegelCodec'), '.workflow', 'metrics', 'agent-runs.jsonl');
    fs.mkdirSync(brokenFile, { recursive: true });
    const partial = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy', 'HegelCodec'],
    });
    expect(partial.complete).toBe(false);
    expect(partial.errors).toContainEqual(expect.objectContaining({ project: 'HegelCodec', code: 'JOURNAL_UNREADABLE' }));
  });

  it('unplaced run timestamps are counted and make the report incomplete', async () => {
    writeJournal(project('PulseProxy'), [run({
      project: 'PulseProxy', ticket: 'QA-UNPLACED', run_key: 'bad-ts',
      ts: 'not-a-date', started_at: null,
    })]);
    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
    });
    expect(report.complete).toBe(false);
    expect(report.totals.starts).toBe(0);
    expect(report.totals.unplaced_starts).toBe(1);
  });

  it('corrupt journal lines are reported incomplete without dropping valid rows', async () => {
    const valid = run({ project: 'PulseProxy', ticket: 'QA-VALID', run_key: 'valid' });
    writeJournal(project('PulseProxy'), [valid]);
    fs.appendFileSync(path.join(project('PulseProxy'), '.workflow', 'metrics', 'agent-runs.jsonl'), '{broken json\n');
    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
    });
    expect(report.complete).toBe(false);
    expect(report.totals.starts).toBe(1);
    expect(report.errors).toContainEqual(expect.objectContaining({
      project: 'PulseProxy', code: 'JOURNAL_CORRUPT_LINES', line_count: 1,
    }));
  });

  it('reports workspace discovery failure rather than a complete empty report', async () => {
    const previous = process.env.MCP_CWD;
    process.env.MCP_CWD = path.join(workspace, 'does-not-exist');
    try {
      const report = await get_agent_run_stats({ date_from: '2026-10-11', date_to: '2026-10-12' });
      expect(report.complete).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'DISCOVERY_FAILED' }));
    } finally {
      if (previous === undefined) delete process.env.MCP_CWD;
      else process.env.MCP_CWD = previous;
    }
  });

  it('deduplicates a journal event against the open-run marker', async () => {
    const closed = run({ project: 'PulseProxy', ticket: 'QA-OVERLAP', run_key: 'overlap-run' });
    writeJournal(project('PulseProxy'), [closed, {
      type: 'verify', ts: '2026-10-12T21:00:00.000Z', ticket: closed.ticket,
      ticket_type: 'qa', status: 'all_green', fail_reasons: [],
    }]);
    const openPath = path.join(project('PulseProxy'), '.workflow', 'state', 'agent-run-open.json');
    fs.mkdirSync(path.dirname(openPath), { recursive: true });
    fs.writeFileSync(openPath, `${JSON.stringify({ ...closed, ts: closed.started_at })}\n`);
    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
    });
    expect(report.totals.starts).toBe(1);
    expect(report.totals.open_starts).toBe(0);
    expect(report.totals.executor_grades.accepted).toBe(1);
  });

  it('counts prototype-like raw status names as ordinary statuses across projects', async () => {
    const constructor = run({ project: 'PulseProxy', ticket: 'QA-STATUS-A', run_key: 'status-a', model: 'special-model', status: 'constructor' });
    const proto = run({ project: 'HegelCodec', ticket: 'QA-STATUS-B', run_key: 'status-b', model: 'special-model', status: '__proto__' });
    writeJournal(project('PulseProxy'), [constructor]);
    writeJournal(project('HegelCodec'), [proto]);
    const report = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy', 'HegelCodec'],
    });
    const row = report.rows.find((item) => item.model === 'special-model');
    expect(Object.hasOwn(row.process_statuses, 'constructor')).toBe(true);
    expect(row.process_statuses.constructor).toBe(1);
    expect(Object.hasOwn(row.process_statuses, '__proto__')).toBe(true);
    expect(row.process_statuses.__proto__).toBe(1);
    expect(JSON.parse(JSON.stringify(row.process_statuses))).toEqual(JSON.parse('{"constructor":1,"__proto__":1}'));
  });

  it('model filter excludes unrelated unplaced starts from totals but retains a diagnostic', async () => {
    const known = run({ project: 'PulseProxy', ticket: 'QA-KNOWN', run_key: 'known', model: 'model-a' });
    const unplaced = run({
      project: 'PulseProxy', ticket: 'QA-UNPLACED-OTHER', run_key: 'unplaced-other',
      model: 'model-b', ts: 'not-a-date', started_at: null,
    });
    writeJournal(project('PulseProxy'), [known, unplaced]);

    const filtered = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'], model: 'model-a',
    });
    expect(filtered.complete).toBe(true);
    expect(filtered.totals.starts).toBe(1);
    expect(filtered.totals.unplaced_starts).toBe(0);
    expect(filtered.diagnostics.unplaced_starts_by_model).toEqual([{ model: 'model-b', starts: 1 }]);

    const allModels = await get_agent_run_stats({
      date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
    });
    expect(allModels.complete).toBe(false);
    expect(allModels.totals.unplaced_starts).toBe(1);
  });

  it('reports a per-project discovery error instead of silently omitting the project', async () => {
    writeJournal(project('PulseProxy'), [run({ project: 'PulseProxy', ticket: 'QA-VALID', run_key: 'valid' })]);
    const deniedWorkflowDir = path.resolve(project('HegelCodec'), '.workflow');
    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === deniedWorkflowDir) {
        const error = new Error('permission denied for test');
        error.code = 'EACCES';
        throw error;
      }
      return originalStatSync.call(fs, target, ...args);
    });
    try {
      const selectedProject = await get_agent_run_stats({
        date_from: '2026-10-11', date_to: '2026-10-12', projects: ['PulseProxy'],
      });
      expect(selectedProject.complete).toBe(true);
      expect(selectedProject.errors).toEqual([]);
      expect(selectedProject.projects).toEqual(['PulseProxy']);
      expect(selectedProject.totals.starts).toBe(1);

      const report = await get_agent_run_stats({ date_from: '2026-10-11', date_to: '2026-10-12' });
      expect(report.complete).toBe(false);
      expect(report.projects).toEqual(['PulseProxy']);
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'DISCOVERY_FAILED', project: 'HegelCodec' }));
      expect(report.totals.starts).toBe(1);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('reports a broken discovery config and does not widen its project scope', async () => {
    writeJournal(project('PulseProxy'), [run({ project: 'PulseProxy', ticket: 'QA-CONFIG', run_key: 'config-run' })]);
    fs.writeFileSync(path.join(workspace, '.workflow-mcp.yaml'), 'projects:\n  whitelist: [PulseProxy\n');
    const report = await get_agent_run_stats({ date_from: '2026-10-11', date_to: '2026-10-12' });
    expect(report.complete).toBe(false);
    expect(report.projects).toEqual([]);
    expect(report.totals.starts).toBe(0);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'DISCOVERY_FAILED', scope: 'workspace', kind: 'config',
    }));
  });

  it('does not probe or report projects excluded by the workspace blacklist', async () => {
    writeJournal(project('PulseProxy'), [run({ project: 'PulseProxy', ticket: 'QA-ALLOWED', run_key: 'allowed' })]);
    fs.writeFileSync(path.join(workspace, '.workflow-mcp.yaml'), 'projects:\n  blacklist:\n    - HegelCodec\n');
    const deniedWorkflowDir = path.resolve(project('HegelCodec'), '.workflow');
    const originalStatSync = fs.statSync;
    let deniedProjectProbes = 0;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === deniedWorkflowDir) {
        deniedProjectProbes += 1;
        const error = new Error('permission denied for excluded project');
        error.code = 'EACCES';
        throw error;
      }
      return originalStatSync.call(fs, target, ...args);
    });
    try {
      const report = await get_agent_run_stats({ date_from: '2026-10-11', date_to: '2026-10-12' });
      expect(report.complete).toBe(true);
      expect(report.projects).toEqual(['PulseProxy']);
      expect(report.errors).toEqual([]);
      expect(report.totals.starts).toBe(1);
      expect(deniedProjectProbes).toBe(0);
    } finally {
      statSpy.mockRestore();
    }
  });
});
