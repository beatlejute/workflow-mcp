import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  abortPipelineImpl,
  pausePipelineImpl,
  resumePipelineImpl,
  stopPipelineImpl
} from '../../src/tools/pipeline.mjs';
import { setExternalRunnerForTests } from '../../src/process/control.mjs';
import { cancelPipelineStateNotification } from '../../src/resources/index.mjs';
import { setProcessStartReaderForTests } from '../../src/process/process-start.mjs';
import { writeRunnerLock } from '../helpers/pipeline-lock.mjs';

const PID = 987654321;
let workspace;
let projectRoot;
let savedCwd;
let savedForce;

beforeEach(() => {
  setExternalRunnerForTests(null);
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unknown-pid-identity-')));
  projectRoot = path.join(workspace, 'project');
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.workflow', 'state'), { recursive: true });
  savedCwd = process.env.MCP_CWD;
  savedForce = process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  process.env.MCP_CWD = workspace;
  delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  setProcessStartReaderForTests(() => null);
});

afterEach(() => {
  cancelPipelineStateNotification();
  setProcessStartReaderForTests(null);
  setExternalRunnerForTests(null);
  vi.restoreAllMocks();
  if (savedCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = savedCwd;
  if (savedForce === undefined) delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  else process.env.WORKFLOW_MCP_FORCE_FOREIGN = savedForce;
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function assertUnknownWithoutSignal(call) {
  writeRunnerLock(projectRoot, PID);
  const signalSpy = vi.spyOn(process, 'kill');
  const externalSpy = vi.fn(async () => ({ ok: true }));
  setExternalRunnerForTests(externalSpy);

  const result = await call();

  expect(result).toMatchObject({
    ok: false,
    code: 'PROCESS_IDENTITY_UNKNOWN',
    reason: 'IDENTITY_UNKNOWN'
  });
  expect(signalSpy).not.toHaveBeenCalled();
  expect(externalSpy).not.toHaveBeenCalled();
}

describe('mutations require confirmed process identity', () => {
  it.each([
    ['pause_pipeline', () => pausePipelineImpl('project')],
    ['resume_pipeline', () => resumePipelineImpl('project')],
    ['abort_pipeline', () => abortPipelineImpl('project', { grace_sec: 0 })],
    ['stop_pipeline', () => stopPipelineImpl('project')],
    ['stop_pipeline force', () => stopPipelineImpl('project', { force: true })]
  ])('%s refuses unknown identity before signaling', async (_name, call) => {
    await assertUnknownWithoutSignal(call);
  });

  it.each([
    ['pause_pipeline', () => pausePipelineImpl('project')],
    ['resume_pipeline', () => resumePipelineImpl('project')],
    ['abort_pipeline', () => abortPipelineImpl('project', { grace_sec: 0 })],
    ['stop_pipeline', () => stopPipelineImpl('project', { force: true })]
  ])('WORKFLOW_MCP_FORCE_FOREIGN=1 does not bypass unknown identity for %s', async (_name, call) => {
    process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';
    await assertUnknownWithoutSignal(call);
  });

  it('allows force stop of a foreign lock only after identity matches', async () => {
    const lockWrittenAt = new Date(Date.now() + 5000).toISOString();
    const reader = vi.fn(() => new Date(new Date(lockWrittenAt).getTime() - 1000));
    setProcessStartReaderForTests(reader);
    writeRunnerLock(projectRoot, PID, {
      started_at: lockWrittenAt,
      timestamp: lockWrittenAt,
      started_by: 'cli',
      started_by_id: null
    });
    const signalSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const externalCalls = [];
    setExternalRunnerForTests(async (command, args) => {
      externalCalls.push({ command, args });
      return { ok: true };
    });

    const result = await stopPipelineImpl('project', { force: true });

    expect(result).toMatchObject({ ok: true, pid: PID, state: 'killed' });
    expect(reader).toHaveBeenCalledWith(PID);
    if (process.platform === 'win32') {
      expect(externalCalls).toEqual([{ command: 'taskkill', args: ['/F', '/T', '/PID', String(PID)] }]);
      expect(signalSpy).not.toHaveBeenCalled();
    } else {
      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(signalSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
      expect(externalCalls).toEqual([]);
    }
  });

  it('allows the soft abort then blocks force when identity becomes unknown', async () => {
    const lockWrittenAt = new Date(Date.now() + 5000).toISOString();
    let queryCount = 0;
    setProcessStartReaderForTests(() => {
      queryCount += 1;
      return queryCount === 1 ? new Date(new Date(lockWrittenAt).getTime() - 1000) : null;
    });
    writeRunnerLock(projectRoot, PID, {
      started_at: lockWrittenAt,
      timestamp: lockWrittenAt
    });
    const signalSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const externalCalls = [];
    setExternalRunnerForTests(async (command, args) => {
      externalCalls.push({ command, args });
      return { ok: true };
    });

    const result = await abortPipelineImpl('project', { grace_sec: 0 });

    expect(result).toMatchObject({ ok: false, code: 'PROCESS_IDENTITY_UNKNOWN', reason: 'IDENTITY_UNKNOWN' });
    expect(queryCount).toBe(2);
    if (process.platform === 'win32') {
      expect(externalCalls).toEqual([{ command: 'taskkill', args: ['/PID', String(PID)] }]);
      expect(signalSpy).not.toHaveBeenCalled();
    } else {
      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(signalSpy).toHaveBeenCalledWith(PID, 'SIGINT');
      expect(externalCalls).toEqual([]);
    }
  });
});
