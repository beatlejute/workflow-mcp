import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectApprovalPending, getApprovalPendingThreshold } from '../../../src/health/detectors/approval-pending.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('detectApprovalPending (tests/health/detectors/approval-pending.test.mjs)', () => {
  let testDir;
  let projectPath;
  let approvalsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'approval-pending-detector-test-'));
    projectPath = testDir;
    approvalsDir = path.join(projectPath, '.workflow', 'approvals');

    // Create .workflow/approvals directory
    fs.mkdirSync(approvalsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
  });

  describe('getApprovalPendingThreshold', () => {
    it('should return default threshold 600 when config is missing property', () => {
      const config = {};
      const threshold = getApprovalPendingThreshold(config);
      expect(threshold).toBe(600);
    });

    it('should return custom threshold from config', () => {
      const config = { approval_pending_threshold_sec: 300 };
      const threshold = getApprovalPendingThreshold(config);
      expect(threshold).toBe(300);
    });

    it('should return custom threshold with other config properties present', () => {
      const config = {
        tick_interval_sec: 15,
        approval_pending_threshold_sec: 1200,
        other_property: 'value'
      };
      const threshold = getApprovalPendingThreshold(config);
      expect(threshold).toBe(1200);
    });
  });

  describe('Basic functionality - no approvals directory', () => {
    it('should return null when approvals directory does not exist', () => {
      // Remove approvals directory
      fs.rmSync(approvalsDir, { recursive: true });
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);
      expect(result).toBeNull();
    });

    it('should return null when approvals directory is empty', () => {
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);
      expect(result).toBeNull();
    });

    it('should ignore non-json files in approvals directory', () => {
      fs.writeFileSync(path.join(approvalsDir, 'readme.txt'), 'not json', 'utf8');
      fs.writeFileSync(path.join(approvalsDir, 'data.yaml'), 'yaml: content', 'utf8');
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);
      expect(result).toBeNull();
    });
  });

  describe('DoD 1: pending старше threshold → warning alert', () => {
    it('should return warning alert when pending is older than threshold', () => {
      const now = Date.now();
      const threshold = 600; // 10 minutes
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString(); // 100 sec older than threshold

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('warning');
      expect(result.step_id).toBe('step-1');
      expect(result.message).toContain('step-1.json');
      expect(result.message).toContain(created_at);
      expect(result.suggested_actions).toEqual(['approve_step', 'list_running_pipelines']);
    });

    it('should return warning for multiple files exceeding threshold, returns first one', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // Create two old pending approvals
      const approval1 = {
        step_id: 'step-1',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      const approval2 = {
        step_id: 'step-2',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval1), 'utf8');
      fs.writeFileSync(path.join(approvalsDir, 'step-2.json'), JSON.stringify(approval2), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.severity).toBe('warning');
      // Should return the first one found (filesystem order)
      expect(['step-1', 'step-2']).toContain(result.step_id);
    });
  });

  describe('DoD 2: pending моложе threshold/2 → info alert', () => {
    it('should return info alert when pending is between threshold/2 and threshold', () => {
      const now = Date.now();
      const threshold = 600; // 10 minutes
      const half_threshold = threshold / 2; // 5 minutes
      const created_at = new Date(now - (half_threshold + 30) * 1000).toISOString(); // 30 sec older than half

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('info');
      expect(result.step_id).toBe('step-1');
    });

    it('should not return alert when pending is younger than threshold/2', () => {
      const now = Date.now();
      const threshold = 600; // 10 minutes
      const half_threshold = threshold / 2; // 5 minutes
      const created_at = new Date(now - (half_threshold - 10) * 1000).toISOString(); // 10 sec younger than half

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });
  });

  describe('DoD 3: approved/rejected — алерт исчезает (дедупликация работает)', () => {
    it('should return null when approval status is approved', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'approved', // Not pending
        created_at: old_pending,
        decided_at: new Date(now - 100).toISOString(),
        decision: 'approve',
        decided_by: 'mcp-client',
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });

    it('should return null when approval status is rejected', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'rejected', // Not pending
        created_at: old_pending,
        decided_at: new Date(now - 100).toISOString(),
        decision: 'reject',
        decided_by: 'mcp-client',
        comment: 'Not ready yet'
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });

    it('should transition from alert to no alert when status changes from pending to approved', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // First call: pending
      const approval_pending = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval_pending), 'utf8');
      const config = { approval_pending_threshold_sec: threshold };
      const result1 = detectApprovalPending(projectPath, config);

      expect(result1).not.toBeNull();
      expect(result1.type).toBe('approval_pending');

      // Second call: approved
      const approval_approved = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'approved',
        created_at: old_pending,
        decided_at: new Date(now).toISOString(),
        decision: 'approve',
        decided_by: 'mcp-client',
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval_approved), 'utf8');
      const result2 = detectApprovalPending(projectPath, config);

      expect(result2).toBeNull();
    });
  });

  describe('DoD 4: fingerprint стабилен между тиками', () => {
    it('should generate consistent fingerprint across multiple calls', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result1 = detectApprovalPending(projectPath, config);
      const result2 = detectApprovalPending(projectPath, config);
      const result3 = detectApprovalPending(projectPath, config);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result3).not.toBeNull();

      // Fingerprints should be identical across calls
      expect(result1.fingerprint).toBe(result2.fingerprint);
      expect(result2.fingerprint).toBe(result3.fingerprint);
    });

    it('should include project name and step_id in fingerprint', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.fingerprint).toContain('approval_pending');
      expect(result.fingerprint).toContain('step-1.json');
      // Fingerprint format: approval_pending:{project}:{step_id}
      expect(result.fingerprint).toMatch(/approval_pending:[^:]+:step-1\.json/);
    });
  });

  describe('DoD 5: Множественные pending в разных проектах → отдельные алерты', () => {
    it('should detect approval_pending for each project independently', () => {
      // Create first project
      const project1Path = path.join(testDir, 'project1');
      const project1ApprovalsDir = path.join(project1Path, '.workflow', 'approvals');
      fs.mkdirSync(project1ApprovalsDir, { recursive: true });

      // Create second project
      const project2Path = path.join(testDir, 'project2');
      const project2ApprovalsDir = path.join(project2Path, '.workflow', 'approvals');
      fs.mkdirSync(project2ApprovalsDir, { recursive: true });

      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // Add approval to project1
      const approval1 = {
        step_id: 'step-1',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };
      fs.writeFileSync(path.join(project1ApprovalsDir, 'step-1.json'), JSON.stringify(approval1), 'utf8');

      // Add approval to project2
      const approval2 = {
        step_id: 'step-2',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };
      fs.writeFileSync(path.join(project2ApprovalsDir, 'step-2.json'), JSON.stringify(approval2), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };

      // Check project1
      const result1 = detectApprovalPending(project1Path, config);
      expect(result1).not.toBeNull();
      expect(result1.type).toBe('approval_pending');
      // `toContain` пропускал поломку: полный путь содержит имя проекта
      // подстрокой, поэтому `D:\Dev\project1` проверку проходил.
      expect(result1.project).toBe('project1');
      expect(result1.step_id).toBe('step-1');

      // Check project2
      const result2 = detectApprovalPending(project2Path, config);
      expect(result2).not.toBeNull();
      expect(result2.type).toBe('approval_pending');
      expect(result2.project).toBe('project2');
      expect(result2.step_id).toBe('step-2');

      // Fingerprints should be different for different projects
      expect(result1.fingerprint).not.toBe(result2.fingerprint);
    });

    it('should not alert when no pending in one project but pending in another', () => {
      // Create first project (no approvals)
      const project1Path = path.join(testDir, 'project1');
      const project1ApprovalsDir = path.join(project1Path, '.workflow', 'approvals');
      fs.mkdirSync(project1ApprovalsDir, { recursive: true });

      // Create second project (with pending)
      const project2Path = path.join(testDir, 'project2');
      const project2ApprovalsDir = path.join(project2Path, '.workflow', 'approvals');
      fs.mkdirSync(project2ApprovalsDir, { recursive: true });

      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // Add approval only to project2
      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };
      fs.writeFileSync(path.join(project2ApprovalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };

      // Check project1 (should return null)
      const result1 = detectApprovalPending(project1Path, config);
      expect(result1).toBeNull();

      // Check project2 (should return alert)
      const result2 = detectApprovalPending(project2Path, config);
      expect(result2).not.toBeNull();
    });
  });

  describe('Alert object properties', () => {
    it('should include correct alert object structure', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        ticket_id: 'IMPL-10',
        stage: 'manual-gate',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toHaveProperty('fingerprint');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('severity');
      expect(result).toHaveProperty('project');
      expect(result).toHaveProperty('step_id');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('detected_at');
      expect(result).toHaveProperty('suggested_actions');
    });

    it('should include detected_at timestamp in reasonable range', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const beforeTime = Date.now();
      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);
      const afterTime = Date.now();

      expect(result).not.toBeNull();
      expect(result.detected_at).toBeDefined();
      // Формат — ISO-строка, как у остальных детекторов. Число здесь ломало
      // ресурс `workflow://alerts`: он отбирает записи по `new Date(...)`.
      expect(new Date(result.detected_at).toISOString()).toBe(result.detected_at);
      const detectedMs = new Date(result.detected_at).getTime();
      expect(detectedMs >= beforeTime).toBe(true);
      expect(detectedMs <= afterTime).toBe(true);
    });

    it('should extract project name from directory path', () => {
      const customProjectPath = path.join('/tmp', 'my-test-project');
      const customApprovalsDir = path.join(customProjectPath, '.workflow', 'approvals');
      fs.mkdirSync(customApprovalsDir, { recursive: true });

      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(customApprovalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(customProjectPath, config);

      expect(result).not.toBeNull();
      expect(result.project).toBe('my-test-project');

      // Cleanup
      fs.rmSync(customProjectPath, { recursive: true, force: true });
    });

    it('should include message with step_id and created_at timestamp', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.message).toContain('step-1.json');
      expect(result.message).toContain(created_at);
    });

    it('should include correct suggested_actions', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.suggested_actions).toEqual(['approve_step', 'list_running_pipelines']);
    });
  });

  describe('Edge cases', () => {
    it('should handle invalid JSON in approval file gracefully', () => {
      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), '{invalid json}', 'utf8');
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);
      expect(result).toBeNull();
    });

    it('should ignore approval files without status field', () => {
      const approval = {
        step_id: 'step-1',
        created_at: new Date().toISOString()
        // Missing status field
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');
      const config = { approval_pending_threshold_sec: 600 };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });

    it('should ignore approval files without created_at field', () => {
      const approval = {
        step_id: 'step-1',
        status: 'pending'
        // Missing created_at field
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');
      const config = { approval_pending_threshold_sec: 600 };
      // Should not throw, should return null
      expect(() => detectApprovalPending(projectPath, config)).not.toThrow();
    });

    it('should handle exactly at threshold boundary (age === threshold)', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - threshold * 1000).toISOString(); // Exactly at threshold

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      // At threshold, should return info alert (ageSec > threshold? no, so severity = 'info')
      // But due to execution time, might be slightly over threshold
      expect(result).not.toBeNull();
      expect(['info', 'warning']).toContain(result.severity);
    });

    it('should handle exactly at threshold/2 boundary (age === threshold/2)', () => {
      const now = Date.now();
      const threshold = 600;
      const half_threshold = threshold / 2;
      const created_at = new Date(now - half_threshold * 1000).toISOString(); // Exactly at threshold/2

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      // At threshold/2, ageSec > threshold/2? strict greater-than means exactly at boundary is false
      // But due to execution time elapsed, may be slightly over
      // So result can be null or info alert depending on timing
      if (result !== null) {
        expect(result.severity).toBe('info');
      }
    });

    it('should handle multiple pending files and return only first alert', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // Create 5 old pending approvals
      for (let i = 1; i <= 5; i++) {
        const approval = {
          step_id: `step-${i}`,
          status: 'pending',
          created_at: old_pending,
          decided_at: null,
          decision: null,
          decided_by: null,
          comment: null
        };
        fs.writeFileSync(path.join(approvalsDir, `step-${i}.json`), JSON.stringify(approval), 'utf8');
      }

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      // Should return first found (function returns on first match)
      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      // step_id should be one of the 5
      expect(result.step_id).toMatch(/step-[1-5]/);
    });
  });

  describe('DoD verification', () => {
    it('DoD 1: pending старше threshold → warning alert', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('warning');
    });

    it('DoD 2: pending моложе threshold/2 → info alert', () => {
      const now = Date.now();
      const threshold = 600;
      const half_threshold = threshold / 2;
      const created_at = new Date(now - (half_threshold + 30) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).not.toBeNull();
      expect(result.type).toBe('approval_pending');
      expect(result.severity).toBe('info');
    });

    it('DoD 3: approved/rejected — алерт исчезает', () => {
      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      // Create approved approval (was pending but now decided)
      const approval = {
        step_id: 'step-1',
        status: 'approved',
        created_at: old_pending,
        decided_at: new Date(now).toISOString(),
        decision: 'approve',
        decided_by: 'mcp-client',
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result = detectApprovalPending(projectPath, config);

      expect(result).toBeNull();
    });

    it('DoD 4: fingerprint стабилен между тиками', () => {
      const now = Date.now();
      const threshold = 600;
      const created_at = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval = {
        step_id: 'step-1',
        status: 'pending',
        created_at,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(approvalsDir, 'step-1.json'), JSON.stringify(approval), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result1 = detectApprovalPending(projectPath, config);
      const result2 = detectApprovalPending(projectPath, config);

      expect(result1.fingerprint).toBe(result2.fingerprint);
    });

    it('DoD 5: Множественные pending в разных проектах → отдельные алерты', () => {
      const project1Path = path.join(testDir, 'project1');
      const project2Path = path.join(testDir, 'project2');
      const project1ApprovalsDir = path.join(project1Path, '.workflow', 'approvals');
      const project2ApprovalsDir = path.join(project2Path, '.workflow', 'approvals');

      fs.mkdirSync(project1ApprovalsDir, { recursive: true });
      fs.mkdirSync(project2ApprovalsDir, { recursive: true });

      const now = Date.now();
      const threshold = 600;
      const old_pending = new Date(now - (threshold + 100) * 1000).toISOString();

      const approval1 = {
        step_id: 'step-1',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      const approval2 = {
        step_id: 'step-2',
        status: 'pending',
        created_at: old_pending,
        decided_at: null,
        decision: null,
        decided_by: null,
        comment: null
      };

      fs.writeFileSync(path.join(project1ApprovalsDir, 'step-1.json'), JSON.stringify(approval1), 'utf8');
      fs.writeFileSync(path.join(project2ApprovalsDir, 'step-2.json'), JSON.stringify(approval2), 'utf8');

      const config = { approval_pending_threshold_sec: threshold };
      const result1 = detectApprovalPending(project1Path, config);
      const result2 = detectApprovalPending(project2Path, config);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1.project).toBe('project1');
      expect(result2.project).toBe('project2');
      expect(result1.fingerprint).not.toBe(result2.fingerprint);
    });
  });
});
