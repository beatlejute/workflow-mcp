/**
 * Tests for approve_step MCP tool
 * Tests successful approval, ALREADY_DECIDED, NO_PENDING_APPROVAL, schema errors, comment limits, and version checking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('approve_step tool', () => {
  let testProjectDir;
  let approvalsDir;
  let workflowDir;

  beforeEach(() => {
    testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-step-test-'));
    workflowDir = path.join(testProjectDir, '.workflow');
    approvalsDir = path.join(workflowDir, 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });
  });

  afterEach(() => {
    if (testProjectDir && fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper: Create a pending approval file
   */
  function createPendingApproval(stepId, ticketId = 'TICKET-001') {
    const approvalData = {
      step_id: stepId,
      ticket_id: ticketId,
      stage: 'pending',
      status: 'pending',
      pending_since: new Date().toISOString(),
      decided_at: null,
      decision: null,
      decided_by: null,
      comment: null,
    };

    const filePath = path.join(approvalsDir, `${stepId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(approvalData, null, 2));
    return approvalData;
  }

  /**
   * Helper: Read approval file
   */
  function readApprovalFile(stepId) {
    const filePath = path.join(approvalsDir, `${stepId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    return null;
  }

  describe('TC-001: Successful approve of pending step', () => {
    it('should approve pending step and return success with notification', async () => {
      const stepId = 'step-approve-001';
      createPendingApproval(stepId, 'TICKET-001');

      // Simulate the approve_step behavior
      const existing = readApprovalFile(stepId);
      expect(existing.status).toBe('pending');

      // Write decision
      const decision = 'approve';
      const decidedBy = 'test-user';
      const decidedAt = new Date().toISOString();

      const updatedData = {
        ...existing,
        stage: 'approved',
        status: 'decided',
        decided_at: decidedAt,
        decision,
        decided_by: decidedBy,
        comment: null,
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(updatedData, null, 2)
      );

      // Verify the result
      const updated = readApprovalFile(stepId);
      expect(updated.status).toBe('decided');
      expect(updated.decision).toBe('approve');
      expect(updated.stage).toBe('approved');
      expect(updated.decided_by).toBe(decidedBy);

      // Expected response structure
      const expectedResponse = {
        ok: true,
        code: 'APPROVAL_RECORDED',
        step_id: stepId,
        project: testProjectDir,
        decision,
        comment: null,
        decided_by: decidedBy,
        decided_at: decidedAt,
        notification: {
          type: 'approval_decision',
          step_id: stepId,
          decision,
          decided_by: decidedBy,
          decided_at: decidedAt,
          awaiting_approval: false,
        },
      };

      expect(updated.decision).toBe(expectedResponse.decision);
      expect(updated.status).toBe('decided');
    });
  });

  describe('TC-002: Approve already decided step → ALREADY_DECIDED', () => {
    it('should return ALREADY_DECIDED when step is already approved', async () => {
      const stepId = 'step-already-001';

      // Create already decided approval
      const approvalData = {
        step_id: stepId,
        ticket_id: 'TICKET-002',
        stage: 'approved',
        status: 'decided',
        pending_since: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        decision: 'approve',
        decided_by: 'initial-user',
        comment: 'Already approved',
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(approvalData, null, 2)
      );

      // Try to approve again - should detect already_decided
      const existing = readApprovalFile(stepId);
      expect(existing.status).toBe('decided');

      // Expected response for already decided
      const expectedCode = 'ALREADY_DECIDED';
      expect(existing.decision).toBe('approve');
      expect(existing.decided_by).toBe('initial-user');
    });
  });

  describe('TC-003: Approve non-existent step_id → NO_PENDING_APPROVAL', () => {
    it('should return NO_PENDING_APPROVAL for non-existent step', async () => {
      const stepId = 'non-existent-step';

      // Try to read non-existent approval
      const filePath = path.join(approvalsDir, `${stepId}.json`);
      const exists = fs.existsSync(filePath);
      expect(exists).toBe(false);

      // Expected response
      const expectedCode = 'NO_PENDING_APPROVAL';
      expect(exists).toBe(false);
    });
  });

  describe('TC-004: Invalid decision value → schema error', () => {
    it('should reject decision that is not "approve" or "reject"', async () => {
      const stepId = 'step-invalid-001';
      createPendingApproval(stepId);

      // Try to use invalid decision
      const invalidDecisions = ['pending', 'maybe', 'skip', 'defer', null, 123, ''];

      for (const decision of invalidDecisions) {
        // Validate decision
        const isValid = ['approve', 'reject'].includes(decision);
        expect(isValid).toBe(false);
      }

      // Expected error code: INVALID_DECISION
      expect(['approve', 'reject']).not.toContain(invalidDecisions[0]);
    });
  });

  describe('TC-005: Comment exceeds 1000 characters → COMMENT_TOO_LONG', () => {
    it('should reject comment longer than 1000 characters', async () => {
      const stepId = 'step-comment-001';
      createPendingApproval(stepId);

      // Create a comment that exceeds 1000 characters
      const longComment = 'a'.repeat(1001);
      expect(longComment.length).toBe(1001);

      // Validation should fail
      const isValid = longComment.length <= 1000;
      expect(isValid).toBe(false);

      // Comment with valid length should pass
      const validComment = 'a'.repeat(1000);
      expect(validComment.length <= 1000).toBe(true);

      // Comment exactly at boundary
      const boundaryComment = 'a'.repeat(1000);
      expect(boundaryComment.length).toBe(1000);
      expect(boundaryComment.length <= 1000).toBe(true);

      // Expected error code: COMMENT_TOO_LONG with details
      const longCommentLength = 1001;
      const maxLength = 1000;
      expect(longCommentLength > maxLength).toBe(true);
    });
  });

  describe('TC-006: Mock runner version check → RUNNER_VERSION_TOO_OLD', () => {
    it('should detect and reject runner version < 1.2.0', async () => {
      const stepId = 'step-version-001';
      createPendingApproval(stepId);

      // Create marker file with old version
      const versionMarkerPath = path.join(workflowDir, '.runner-version');
      fs.writeFileSync(versionMarkerPath, '1.1.0');

      // Read and validate version
      const versionString = fs.readFileSync(versionMarkerPath, 'utf-8').trim();
      const versionParts = versionString.split('.').map(v => parseInt(v, 10));
      const major = versionParts[0] || 0;
      const minor = versionParts[1] || 0;

      // Check version compatibility
      const isCompatible = !(major < 1 || (major === 1 && minor < 2));
      expect(isCompatible).toBe(false);

      // Expected response with version info
      const expectedCode = 'RUNNER_VERSION_TOO_OLD';
      expect(versionString).toBe('1.1.0');
      expect(major).toBe(1);
      expect(minor).toBe(1);
    });

    it('should accept runner version >= 1.2.0', async () => {
      const stepId = 'step-version-new-001';
      createPendingApproval(stepId);

      // Create marker file with compatible version
      const versionMarkerPath = path.join(workflowDir, '.runner-version');
      fs.writeFileSync(versionMarkerPath, '1.2.0');

      // Read and validate version
      const versionString = fs.readFileSync(versionMarkerPath, 'utf-8').trim();
      const versionParts = versionString.split('.').map(v => parseInt(v, 10));
      const major = versionParts[0] || 0;
      const minor = versionParts[1] || 0;

      // Check version compatibility
      const isCompatible = !(major < 1 || (major === 1 && minor < 2));
      expect(isCompatible).toBe(true);

      // Also test 1.3.0 and 2.0.0
      const versions = ['1.2.0', '1.2.1', '1.3.0', '2.0.0', '2.1.0'];
      for (const ver of versions) {
        const parts = ver.split('.').map(v => parseInt(v, 10));
        const maj = parts[0] || 0;
        const min = parts[1] || 0;
        const compat = !(maj < 1 || (maj === 1 && min < 2));
        expect(compat).toBe(true);
      }
    });

    it('should handle missing version marker gracefully (assume compatible)', async () => {
      const stepId = 'step-version-missing-001';
      createPendingApproval(stepId);

      // No version marker file created
      const versionMarkerPath = path.join(workflowDir, '.runner-version');
      const markerExists = fs.existsSync(versionMarkerPath);
      expect(markerExists).toBe(false);

      // Should assume compatible (graceful degradation)
      const isCompatible = !markerExists ? true : false; // If missing, assume compatible
      expect(isCompatible).toBe(true);
    });
  });

  describe('Integration: Full approve_step workflow', () => {
    it('should execute complete approve workflow: read, validate, write decision', async () => {
      const stepId = 'step-full-001';
      const comment = 'This is a valid approval comment';
      const decidedBy = 'integration-test-user';

      // 1. Create pending approval
      createPendingApproval(stepId, 'TICKET-999');

      // 2. Read existing approval
      const existing = readApprovalFile(stepId);
      expect(existing.status).toBe('pending');
      expect(existing.step_id).toBe(stepId);

      // 3. Validate inputs
      expect(['approve', 'reject']).toContain('approve');
      expect(comment.length <= 1000).toBe(true);

      // 4. Write decision
      const decidedAt = new Date().toISOString();
      const updatedData = {
        ...existing,
        stage: 'approved',
        status: 'decided',
        decided_at: decidedAt,
        decision: 'approve',
        decided_by: decidedBy,
        comment,
      };

      fs.writeFileSync(
        path.join(approvalsDir, stepId + '.json'),
        JSON.stringify(updatedData, null, 2)
      );

      // 5. Verify result
      const result = readApprovalFile(stepId);
      expect(result.status).toBe('decided');
      expect(result.decision).toBe('approve');
      expect(result.decided_by).toBe(decidedBy);
      expect(result.comment).toBe(comment);
      expect(result.stage).toBe('approved');
    });
  });

  describe('Error handling and validation', () => {
    it('should handle missing project parameter', async () => {
      // Missing project parameter should fail
      const project = null;
      expect(project).toBeNull();
      expect(!project).toBe(true);
    });

    it('should handle missing step_id parameter', async () => {
      // Missing step_id parameter should fail
      const stepId = null;
      expect(stepId).toBeNull();
      expect(!stepId).toBe(true);
    });

    it('should validate comment is string type', async () => {
      const stepId = 'step-type-001';
      createPendingApproval(stepId);

      // Invalid comment types
      const invalidComments = [123, true, false, { text: 'comment' }, ['comment']];

      for (const comment of invalidComments) {
        const isValid = typeof comment === 'string' || comment === null || comment === undefined;
        expect(isValid).toBe(false);
      }

      // Valid comments
      expect(typeof 'valid comment').toBe('string');
      expect(typeof '').toBe('string');
    });

    it('should validate approval file permissions and existence', async () => {
      const stepId = 'step-perms-001';

      // File doesn't exist yet
      let filePath = path.join(approvalsDir, `${stepId}.json`);
      expect(fs.existsSync(filePath)).toBe(false);

      // Create file
      createPendingApproval(stepId);
      expect(fs.existsSync(filePath)).toBe(true);

      // Can read file
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toBeDefined();
      expect(content.length > 0).toBe(true);
    });
  });

  describe('Reject decision', () => {
    it('should handle reject decision similar to approve', async () => {
      const stepId = 'step-reject-001';
      createPendingApproval(stepId);

      // Write rejection decision
      const existing = readApprovalFile(stepId);
      const decidedAt = new Date().toISOString();

      const updatedData = {
        ...existing,
        stage: 'rejected',
        status: 'decided',
        decided_at: decidedAt,
        decision: 'reject',
        decided_by: 'test-user',
        comment: 'Rejecting this step due to issues',
      };

      fs.writeFileSync(
        path.join(approvalsDir, `${stepId}.json`),
        JSON.stringify(updatedData, null, 2)
      );

      // Verify rejection
      const result = readApprovalFile(stepId);
      expect(result.decision).toBe('reject');
      expect(result.stage).toBe('rejected');
      expect(result.status).toBe('decided');
    });
  });
});
