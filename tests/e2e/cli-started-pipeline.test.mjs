/**
 * FIX-002: пайплайны, запущенные вне MCP (CLI `workflow run`, VS Code extension),
 * должны быть видимы и управляемы.
 *
 * Критерии готовности из тикета:
 * - list_running_pipelines видит CLI-запущенный пайплайн (фикстура lock + лог)
 * - approve_step подтверждает pending-файл, созданный вне MCP
 * - stale lock (мёртвый pid) не отображается как running
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { get_workflow_pipeline_state } from '../../src/resources/pipeline-state.mjs';
import approveStepTool from '../../src/tools/approvals.mjs';
import { readApproval } from '../../src/approvals/model.mjs';

const approve_step = approveStepTool.execute;

/** PID, которого заведомо нет в системе. */
const DEAD_PID = 999999;

function createProject(workspaceDir, name = 'cli-project') {
  const projectPath = path.join(workspaceDir, name);
  const workflowDir = path.join(projectPath, '.workflow');
  fs.mkdirSync(path.join(workflowDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(workflowDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(workflowDir, 'approvals'), { recursive: true });
  fs.mkdirSync(path.join(workflowDir, 'tickets', 'backlog'), { recursive: true });
  return projectPath;
}

/** Так пишет lock раннер workflow-ai: src/lib/marker.mjs writeMarker(). */
function writeRunnerLock(projectPath, pid, timestamp = new Date().toISOString()) {
  fs.writeFileSync(
    path.join(projectPath, '.workflow', 'logs', '.pipeline.lock'),
    JSON.stringify({ pid, timestamp }, null, 2)
  );
}

function writeLog(projectPath, name = 'pipeline_2026-09-18_10-00-00.log') {
  fs.writeFileSync(
    path.join(projectPath, '.workflow', 'logs', name),
    '[start] pipeline\n[step 1] decompose-plan\n'
  );
  return name;
}

/** Так пишет approval раннер: runner.mjs writeApprovalPending(). */
function writeRunnerApproval(projectPath, stepId, ticketId) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(projectPath, '.workflow', 'approvals', `${stepId}.json`),
    JSON.stringify({
      step_id: stepId,
      ticket_id: ticketId,
      stage_id: 'manual-gate-human',
      attempt: 1,
      status: 'pending',
      created_at: now,
      updated_at: now,
      decided_by: null,
      comment: null,
      context_snapshot: { ticket_id: ticketId }
    }, null, 2)
  );
}

describe('FIX-002: видимость и управление чужими пайплайнами', () => {
  let workspaceDir;
  let projectPath;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pipeline-'));
    projectPath = createProject(workspaceDir);
    process.chdir(workspaceDir);
    process.env.MCP_CWD = workspaceDir;
  });

  afterEach(() => {
    delete process.env.MCP_CWD;
    try {
      process.chdir(originalCwd);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('видит пайплайн, запущенный извне: только .pipeline.lock, без .runner-pids', () => {
    // Живой процесс = текущий: pid точно существует.
    writeRunnerLock(projectPath, process.pid, '2026-09-18T10:00:00.000Z');
    writeLog(projectPath);

    const snapshot = get_workflow_pipeline_state(workspaceDir);
    const entry = snapshot.find(e => e.project === 'cli-project');

    expect(entry).toBeDefined();
    expect(entry.pid).toBe(process.pid);
    expect(entry.state).toBe('running');
    expect(entry.started_at).toBe('2026-09-18T10:00:00.000Z');
    expect(entry.run_id).toBe('pipeline_2026-09-18_10-00-00');
  });

  it('stale lock (мёртвый pid) не показывается как running', () => {
    writeRunnerLock(projectPath, DEAD_PID);
    writeLog(projectPath);

    const snapshot = get_workflow_pipeline_state(workspaceDir);
    const entry = snapshot.find(e => e.project === 'cli-project');

    expect(entry).toBeDefined();
    expect(entry.state).toBe('stale');
    expect(entry.stale_lock).toBe(true);
  });

  it('без lock и без .runner-pids проект в снапшот не попадает', () => {
    writeLog(projectPath);

    const snapshot = get_workflow_pipeline_state(workspaceDir);

    expect(snapshot.find(e => e.project === 'cli-project')).toBeUndefined();
  });

  it('пайплайн с pending-approval показывается как paused, а не running', () => {
    writeRunnerLock(projectPath, process.pid);
    writeLog(projectPath);
    writeRunnerApproval(projectPath, 'HUMAN-4_manual-gate-human_1', 'HUMAN-4');

    const snapshot = get_workflow_pipeline_state(workspaceDir);
    const entry = snapshot.find(e => e.project === 'cli-project');

    expect(entry.state).toBe('paused');
    expect(entry.awaiting_approval).toEqual(
      expect.objectContaining({ step_id: 'HUMAN-4_manual-gate-human_1' })
    );
  });

  it('approve_step подтверждает approval-файл, созданный раннером', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-4_manual-gate-human_1', 'HUMAN-4');

    const result = await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-4_manual-gate-human_1',
      decision: 'approve',
      comment: 'проверено вручную'
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('APPROVAL_RECORDED');
    expect(result.decision).toBe('approve');
  });

  it('решение записывается в словаре раннера: status=approved (его ждёт manual-gate)', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-4_manual-gate-human_1', 'HUMAN-4');

    await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-4_manual-gate-human_1',
      decision: 'approve'
    });

    const raw = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.workflow', 'approvals', 'HUMAN-4_manual-gate-human_1.json'),
      'utf8'
    ));

    // runner.mjs executeManualGate поллит именно status
    expect(raw.status).toBe('approved');
    // и не теряет собственные поля раннера
    expect(raw.stage_id).toBe('manual-gate-human');
    expect(raw.attempt).toBe(1);
    expect(raw.context_snapshot).toEqual({ ticket_id: 'HUMAN-4' });
  });

  it('reject пишет status=rejected', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-5_manual-gate-human_1', 'HUMAN-5');

    await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-5_manual-gate-human_1',
      decision: 'reject',
      comment: 'не воспроизводится'
    });

    const raw = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.workflow', 'approvals', 'HUMAN-5_manual-gate-human_1.json'),
      'utf8'
    ));

    expect(raw.status).toBe('rejected');
    expect(raw.comment).toBe('не воспроизводится');
  });

  it('readApproval нормализует формат раннера к канону MCP', () => {
    writeRunnerApproval(projectPath, 'HUMAN-6_manual-gate-human_1', 'HUMAN-6');

    const result = readApproval(projectPath, 'HUMAN-6_manual-gate-human_1');

    expect(result.ok).toBe(true);
    expect(result.data.stage).toBe('pending');
    expect(result.data.status).toBe('pending');
    expect(result.data.decision).toBeNull();
    expect(typeof result.data.pending_since).toBe('string');
  });

  it('короткий step_id находится сканом каталога', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-7_manual-gate-human_1', 'HUMAN-7');

    const result = await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-7',
      decision: 'approve'
    });

    expect(result.ok).toBe(true);
    expect(result.step_id).toBe('HUMAN-7_manual-gate-human_1');
  });

  it('неоднозначный step_id не подтверждается молча', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-8_manual-gate-human_1', 'HUMAN-8');
    writeRunnerApproval(projectPath, 'HUMAN-8_manual-gate-human_2', 'HUMAN-8');

    const result = await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-8',
      decision: 'approve'
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMBIGUOUS_STEP_ID');
    expect(result.candidates).toHaveLength(2);
  });

  it('повторное решение возвращает ALREADY_DECIDED, а не перезапись', async () => {
    writeRunnerApproval(projectPath, 'HUMAN-9_manual-gate-human_1', 'HUMAN-9');

    await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-9_manual-gate-human_1',
      decision: 'approve'
    });

    const second = await approve_step({
      project: 'cli-project',
      step_id: 'HUMAN-9_manual-gate-human_1',
      decision: 'reject'
    });

    expect(second.ok).toBe(false);
    expect(second.code).toBe('ALREADY_DECIDED');
    expect(second.previous_decision).toBe('approve');
  });

  it('отсутствующий approval даёт NO_PENDING_APPROVAL', async () => {
    const result = await approve_step({
      project: 'cli-project',
      step_id: 'NOPE_manual-gate-human_1',
      decision: 'approve'
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_PENDING_APPROVAL');
  });
});
