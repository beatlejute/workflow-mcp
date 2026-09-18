import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'approvals');

// Ensure fixtures directory exists
if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

// Re-import the module to pick up fresh state each time
function importModel() {
  return import(path.join(process.cwd(), 'src', 'approvals', 'model.mjs'));
}

describe('Approval Model', () => {
  let testProjectDir;

  beforeEach(() => {
    testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  });

  afterEach(() => {
    if (testProjectDir && fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  describe('readApproval', () => {
    it('should read a valid approval file', async () => {
      const { readApproval } = await importModel();
      const stepId = 'step-1';
      const approvalsDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      const approvalData = {
        step_id: stepId,
        ticket_id: 'TICKET-123',
        stage: 'pending',
        status: 'pending',
        pending_since: '2026-04-27T00:00:00.000Z',
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null,
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(approvalData, null, 2)
      );

      const result = readApproval(testProjectDir, stepId);
      expect(result.ok).toBe(true);
      expect(result.data.step_id).toBe(stepId);
      expect(result.data.ticket_id).toBe('TICKET-123');
      expect(result.data.stage).toBe('pending');
      expect(result.data.status).toBe('pending');
    });

    it('should return error for non-existent file', async () => {
      const { readApproval } = await importModel();
      const result = readApproval(testProjectDir, 'non-existent');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should validate schema - missing required field', async () => {
      const { readApproval } = await importModel();
      const stepId = 'step-1';
      const approvalsDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify({ step_id: stepId })
      );

      const result = readApproval(testProjectDir, stepId);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid approval file');
    });

    it('should validate schema - invalid stage', async () => {
      const { readApproval } = await importModel();
      const stepId = 'step-1';
      const approvalsDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      const approvalData = {
        step_id: stepId,
        ticket_id: 'TICKET-123',
        stage: 'invalid',
        status: 'pending',
        pending_since: '2026-04-27T00:00:00.000Z',
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null,
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(approvalData, null, 2)
      );

      const result = readApproval(testProjectDir, stepId);
      expect(result.ok).toBe(false);
    });

    it('should validate schema - approve with approved stage', async () => {
      const { readApproval } = await importModel();
      const stepId = 'step-1';
      const approvalsDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      const approvalData = {
        step_id: stepId,
        ticket_id: 'TICKET-123',
        stage: 'approved',
        status: 'decided',
        pending_since: '2026-04-27T00:00:00.000Z',
        decided_at: '2026-04-27T01:00:00.000Z',
        decision: 'approve',
        decided_by: 'user1',
        comment: 'Looks good',
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(approvalData, null, 2)
      );

      const result = readApproval(testProjectDir, stepId);
      expect(result.ok).toBe(true);
      expect(result.data.decision).toBe('approve');
      expect(result.data.stage).toBe('approved');
    });

    it('should reject invalid approve/reject combination', async () => {
      const { readApproval } = await importModel();
      const stepId = 'step-1';
      const approvalsDir = path.join(testProjectDir, '.workspace', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      const approvalData = {
        step_id: stepId,
        ticket_id: 'TICKET-123',
        stage: 'approved',
        status: 'decided',
        pending_since: '2026-04-27T00:00:00.000Z',
        decided_at: '2026-04-27T01:00:00.000Z',
        decision: 'reject', // mismatch: approve stage but reject decision
        decided_by: 'user1',
        comment: null,
      };

      // Write to correct location
      const correctDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(correctDir, { recursive: true });
      fs.writeFileSync(
        path.join(correctDir, `${stepId}.json`),
        JSON.stringify(approvalData, null, 2)
      );

      const result = readApproval(testProjectDir, stepId);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('stage must be');
    });
  });

  describe('writeDecision', () => {
    it('should create a new approval and write decision', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-1';

      const result = writeDecision(testProjectDir, stepId, {
        decision: 'approve',
        comment: 'All good',
        decided_by: 'user1',
      });

      expect(result.ok).toBe(true);
      expect(result.decided).toBe(true);
      expect(result.already).toBeUndefined();
      expect(result.data.decision).toBe('approve');
      expect(result.data.stage).toBe('approved');
      expect(result.data.status).toBe('decided');
      expect(result.data.comment).toBe('All good');
      expect(result.data.decided_by).toBe('user1');

      // Verify file actually exists
      const filePath = path.join(testProjectDir, '.workflow', 'approvals', `${stepId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(fileContent.decision).toBe('approve');
    });

    it('should write reject decision', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-1';

      const result = writeDecision(testProjectDir, stepId, {
        decision: 'reject',
        comment: 'Not ready',
        decided_by: 'user2',
      });

      expect(result.ok).toBe(true);
      expect(result.data.decision).toBe('reject');
      expect(result.data.stage).toBe('rejected');
    });

    it('should be idempotent on already decided', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-1';

      // First decision
      const result1 = writeDecision(testProjectDir, stepId, {
        decision: 'approve',
        comment: 'First',
        decided_by: 'user1',
      });
      expect(result1.ok).toBe(true);

      // Second decision attempt
      const result2 = writeDecision(testProjectDir, stepId, {
        decision: 'reject',
        comment: 'Second',
        decided_by: 'user2',
      });

      expect(result2.ok).toBe(true);
      expect(result2.already).toBe(true);
      expect(result2.previous).toBe('approve');
      expect(result2.data.decision).toBe('approve'); // unchanged
    });

    it('should reject invalid decision', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-1';

      const result = writeDecision(testProjectDir, stepId, {
        decision: 'invalid',
        comment: 'Bad',
        decided_by: 'user1',
      });


      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid decision');
    });

    it('should handle no parameters', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-1';

      const result = writeDecision(testProjectDir, stepId, null);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('required');
    });
  });

  describe('listPending', () => {
    it('should list pending approvals', async () => {
      const { writeDecision, listPending } = await importModel();
      const approvalsDir = path.join(testProjectDir, '.workflow', 'approvals');
      fs.mkdirSync(approvalsDir, { recursive: true });

      // Create a pending approval directly
      const pendingData = {
        step_id: 'step-pending',
        ticket_id: 'TICKET-001',
        stage: 'pending',
        status: 'pending',
        pending_since: new Date().toISOString(),
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null,
      };
      fs.writeFileSync(
        path.join(approvalsDir, 'step-pending.json'),
        JSON.stringify(pendingData, null, 2)
      );

      // Create a decided approval
      writeDecision(testProjectDir, 'step-decided', {
        decision: 'approve',
        comment: 'Done',
        decided_by: 'user1',
      });

      const result = listPending(testProjectDir);
      expect(result.ok).toBe(true);
      expect(result.approvals.length).toBe(1);
      expect(result.approvals[0].step_id).toBe('step-pending');
      expect(result.approvals[0].status).toBe('pending');
    });

    it('should return empty array when no approvals directory', async () => {
      const { listPending } = await importModel();
      const result = listPending(testProjectDir);
      expect(result.ok).toBe(true);
      expect(result.approvals).toEqual([]);
    });

    it('should filter out decided approvals', async () => {
      const { writeDecision, listPending } = await importModel();

      writeDecision(testProjectDir, 'step-1', {
        decision: 'approve',
        comment: 'Done',
        decided_by: 'user1',
      });

      writeDecision(testProjectDir, 'step-2', {
        decision: 'reject',
        comment: 'Nope',
        decided_by: 'user2',
      });

      const result = listPending(testProjectDir);
      expect(result.ok).toBe(true);
      expect(result.approvals.length).toBe(0);
    });
  });

  describe('race condition', () => {
    it('should handle 10 parallel writeDecision calls - exactly one wins, rest get already=true', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-race';

      // Create 10 concurrent write attempts
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve().then(() =>
            writeDecision(testProjectDir, stepId, {
              decision: 'approve',
              comment: `Attempt ${i + 1}`,
              decided_by: `user${i + 1}`,
            })
          )
        );
      }

      const results = await Promise.all(promises);

      // Exactly one should be the first writer (no already=true)
      const winners = results.filter(r => !r.already);
      expect(winners.length).toBe(1);
      expect(winners[0].ok).toBe(true);
      expect(winners[0].decided).toBe(true);

      // The rest should all have already=true
      const losers = results.filter(r => r.already);
      expect(losers.length).toBe(9);
      losers.forEach(r => {
        expect(r.ok).toBe(true);
        expect(r.already).toBe(true);
        expect(r.previous).toBe('approve');
      });

      // File should contain the first decision
      const filePath = path.join(testProjectDir, '.workflow', 'approvals', `${stepId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(fileContent.decision).toBe('approve');
      // На диске лежит словарь раннера: manual-gate в workflow-ai поллит
      // status === 'approved'|'rejected', а не 'decided' (FIX-002).
      expect(fileContent.status).toBe('approved');
      expect(fileContent.stage).toBe('approved');
    });

    it('should handle mixed race conditions - approve and reject attempt in parallel', async () => {
      const { writeDecision } = await importModel();
      const stepId = 'step-mixed-race';

      // Mix of approve and reject attempts
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          Promise.resolve().then(() =>
            writeDecision(testProjectDir, stepId, {
              decision: 'approve',
              comment: `Approve ${i}`,
              decided_by: `user${i}`,
            })
          )
        );
        promises.push(
          Promise.resolve().then(() =>
            writeDecision(testProjectDir, stepId, {
              decision: 'reject',
              comment: `Reject ${i}`,
              decided_by: `user${i + 100}`,
            })
          )
        );
      }

      const results = await Promise.all(promises);

      // Exactly one should succeed without already=true
      const winners = results.filter(r => !r.already);
      expect(winners.length).toBe(1);
      expect(winners[0].ok).toBe(true);

      // All others must be already=true
      const losers = results.filter(r => r.already);
      expect(losers.length).toBe(9);

      // All should have the same previous decision
      const firstDecision = winners[0].data.decision;
      losers.forEach(r => {
        expect(r.previous).toBe(firstDecision);
      });
    });
  });
});
