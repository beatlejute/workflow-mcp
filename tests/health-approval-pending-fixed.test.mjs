import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectApprovalPending, getApprovalPendingThreshold } from '../src/health/detectors/approval-pending.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('health-approval-pending-fixed (integration tests)', () => {
  let testDir;
  let projectPath;
  let approvalsDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'approval-pending-fixed-test-'));
    projectPath = testDir;
    approvalsDir = path.join(projectPath, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
  });

  describe('DoD 1: pending старше threshold → alert с информацией о stale approval', () => {
    it('should detect pending approval older than threshold with real runner format (created_at field)', () => {
      const now = Date.now();
      const threshold = 600; // 10 minutes
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'manual-gate-step',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'manual-gate-step.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('warning');
      expect(result.step_id).toBe('manual-gate-step');
      expect(result.message).toContain('manual-gate-step.json');
      expect(result.message).toContain(created_at);
    });
  });

  describe('DoD 2: pending в пределах threshold → null (не просрочен)', () => {
    it('should return null when pending is younger than threshold/2', () => {
      const now = Date.now();
      const threshold = 600;
      const half_threshold = threshold / 2;
      // Create approval younger than threshold/2
      const created_at = new Date(now - (half_threshold - 100) * 1000).toISOString();

      const approval = {
        step_id: 'manual-gate-step',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'manual-gate-step.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });
  });

  describe('DoD 3: status "approved" → детектор возвращает null', () => {
    it('should return null when approval status is approved', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'manual-gate-step',
        status: 'approved',
        created_at,
        decided_at: new Date(now - 10).toISOString(),
        decision: 'approve',
        decided_by: 'dev-agent',
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'manual-gate-step.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });
  });

  describe('DoD 4: status "rejected" → детектор возвращает null', () => {
    it('should return null when approval status is rejected', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'manual-gate-step',
        status: 'rejected',
        created_at,
        decided_at: new Date(now - 10).toISOString(),
        decision: 'reject',
        decided_by: 'dev-agent',
        comment: 'Not ready'
      };

      fs.writeFileSync(path.join(approvalsDir, 'manual-gate-step.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });
  });

  describe('DoD 5: Нет approval-файлов → детектор возвращает null', () => {
    it('should return null when no approval files exist', () => {
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });

    it('should return null when approvals directory does not exist', () => {
      fs.rmSync(approvalsDir, { recursive: true });

      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });
  });

  describe('Integration tests with real runner format', () => {
    it('should work with real approval format from runner (all required fields)', () => {
      const now = Date.now();
      const threshold = 600;

      const realApproval = {
        step_id: 'deploy-production',
        ticket_id: 'IMPL-50',
        stage: 'manual-gate',
        status: 'pending',
        created_at: new Date(now - (threshold + 200) * 1000).toISOString(),
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'deploy-production.json'), JSON.stringify(realApproval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('warning');
      expect(result.message).toContain('deploy-production.json');
    });

    it('should transition from pending to approved (state change)', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      // Initial state: pending
      const approval_pending = {
        step_id: 'deploy-production',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'deploy-production.json'), JSON.stringify(approval_pending), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result1 = detectApprovalPending(projectPath, config);

      expect(result1).not.toBeNull();
      expect(result1.type).toBe('approval_pending');

      // State changes to approved
      const approval_approved = {
        step_id: 'deploy-production',
        status: 'approved',
        created_at,
        decided_at: new Date(now).toISOString(),
        decision: 'approve',
        decided_by: 'mcp-user',
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'deploy-production.json'), JSON.stringify(approval_approved), 'utf8');
      const result2 = detectApprovalPending(projectPath, config);

      expect(result2).toBeNull();
    });
  });

  describe('Edge cases with real runner format', () => {
    it('should ignore approval without created_at field gracefully', () => {
      const approval = {
        step_id: 'manual-gate-step',
        status: 'pending',
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
        // Missing created_at
      };

      fs.writeFileSync(path.join(approvalsDir, 'manual-gate-step.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: 600 };
      // Should not crash
      expect(() => detectApprovalPending(projectPath, config)).not.toThrow();
    });

    it('should handle invalid JSON gracefully', () => {
      fs.writeFileSync(path.join(approvalsDir, 'invalid.json'), '{malformed json', 'utf8');

      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);

      // Should continue scanning and return null (no valid approval)
      expect(result).toBeNull();
    });
  });
});
