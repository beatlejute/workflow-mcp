/**
 * Approval tools for workflow-mcp
 * Provides tool for approving/rejecting pipeline steps
 */

import { discoverProjects } from '../discovery.mjs';
import { readApproval, writeDecision, resolvePendingStepId } from '../approvals/model.mjs';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { mcpCwd, resolveProjectRoot } from '../lib/project-root.mjs';

/**
 * Check runner version compatibility
 * @param {string} projectPath - Path to the project
 * @returns {Object} { compatible: boolean, version?: string, required?: string }
 */
function checkRunnerVersion(projectPath) {
  try {
    // Try to read workflow-ai version from node_modules or package.json
    // For now, we assume runner 1.2.0+ which supports approve_step
    // In a production implementation, this would:
    // 1. Parse .workflow/config/runner.yaml or similar
    // 2. Check version constraints
    // 3. Return incompatible if runner < 1.2.0

    // Check if there's any indication of runner version
    // Look for marker files that might indicate version
    const markerPath = path.join(projectPath, '.workflow', '.runner-version');
    if (fs.existsSync(markerPath)) {
      const version = fs.readFileSync(markerPath, 'utf-8').trim();
      // Parse version and check if >= 1.2.0
      const versionParts = version.split('.').map(v => parseInt(v, 10));
      const major = versionParts[0] || 0;
      const minor = versionParts[1] || 0;

      if (major < 1 || (major === 1 && minor < 2)) {
        return {
          compatible: false,
          version,
          required: '>=1.2.0'
        };
      }
    }

    // No explicit version file or version is compatible
    return { compatible: true };
  } catch (err) {
    // If we can't read version info, assume compatible (graceful degradation)
    return { compatible: true };
  }
}

/**
 * Approve or reject a pipeline step
 * Wrapper over approvals/model.writeDecision with validation and notification.
 *
 * Validation rules:
 * - pending-файл должен существовать (иначе NO_PENDING_APPROVAL)
 * - decision ∈ {approve, reject}
 * - comment ≤ 1000 символов
 * - если уже decided → ALREADY_DECIDED с предыдущим решением
 *
 * @param {Object} params - Parameters
 * @param {string} params.project - Project path or name
 * @param {string} params.step_id - Step ID to approve/reject
 * @param {string} params.decision - 'approve' or 'reject'
 * @param {string} [params.comment] - Optional comment (max 1000 chars)
 * @param {string} [params.decided_by] - Who made the decision (default: 'mcp-client')
 * @returns {Promise<Object>} Result object with code and details
 *
 * Error codes:
 * - INVALID_PROJECT: Project parameter is missing
 * - INVALID_STEP_ID: Step ID parameter is missing
 * - INVALID_DECISION: Decision must be 'approve' or 'reject'
 * - COMMENT_TOO_LONG: Comment exceeds 1000 characters
 * - PROJECT_NOT_FOUND: Project directory not found
 * - RUNNER_VERSION_TOO_OLD: Runner version < 1.2.0
 * - NO_PENDING_APPROVAL: No pending approval file for step_id
 * - ALREADY_DECIDED: Step already has a decision recorded
 * - WRITE_DECISION_FAILED: Failed to write decision to file
 * - UNEXPECTED_ERROR: Unknown error
 */
async function approve_step({ project, step_id, decision, comment, decided_by }) {
  try {
    const cwd = mcpCwd();

    // === Input Validation ===

    if (!project) {
      return { ok: false, code: 'INVALID_PROJECT', message: 'Project is required' };
    }

    if (!step_id) {
      return { ok: false, code: 'INVALID_STEP_ID', message: 'Step ID is required' };
    }

    if (!decision || !['approve', 'reject'].includes(decision)) {
      return {
        ok: false,
        code: 'INVALID_DECISION',
        message: 'Decision must be "approve" or "reject"'
      };
    }

    if (comment && typeof comment !== 'string') {
      return {
        ok: false,
        code: 'INVALID_COMMENT',
        message: 'Comment must be a string'
      };
    }

    if (comment && comment.length > 1000) {
      return {
        ok: false,
        code: 'COMMENT_TOO_LONG',
        message: 'Comment must be at most 1000 characters',
        comment_length: comment.length,
        max_length: 1000
      };
    }

    // === Project Resolution ===

    let projectPath;
    try {
      projectPath = resolveProjectRoot(project);
    } catch (err) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: err.message };
    }

    // === Runner Version Check ===

    const versionCheck = checkRunnerVersion(projectPath);
    if (!versionCheck.compatible) {
      return {
        ok: false,
        code: 'RUNNER_VERSION_TOO_OLD',
        message: `Runner version ${versionCheck.version} is too old. Required: ${versionCheck.required}`,
        current_version: versionCheck.version,
        required_version: versionCheck.required
      };
    }

    // === Approval File Validation ===

    // step_id раннера композитный (<ticket>_<stage>_<attempt>); если клиент передал
    // короткий — находим файл сканом каталога, независимо от того, кто запустил пайплайн.
    const resolved = resolvePendingStepId(projectPath, step_id);
    if (!resolved.ok) {
      if (resolved.code === 'AMBIGUOUS') {
        return {
          ok: false,
          code: 'AMBIGUOUS_STEP_ID',
          message: `Several pending approvals match step: ${step_id}`,
          step_id,
          candidates: resolved.candidates
        };
      }
      return {
        ok: false,
        code: 'NO_PENDING_APPROVAL',
        message: `No pending approval found for step: ${step_id}`,
        step_id
      };
    }

    const resolvedStepId = resolved.step_id;

    const existingApproval = readApproval(projectPath, resolvedStepId);
    if (!existingApproval.ok) {
      // Файл есть, но не читается/не проходит схему — это не "нет approval'а".
      return {
        ok: false,
        code: 'INVALID_APPROVAL_FILE',
        message: existingApproval.error,
        step_id: resolvedStepId
      };
    }

    // === Idempotency Check ===

    if (existingApproval.data.status === 'decided') {
      return {
        ok: false,
        code: 'ALREADY_DECIDED',
        message: `Step ${resolvedStepId} already has a decision: ${existingApproval.data.decision}`,
        step_id: resolvedStepId,
        previous_decision: existingApproval.data.decision,
        decided_at: existingApproval.data.decided_at,
        decided_by: existingApproval.data.decided_by
      };
    }

    // === Decision Recording ===

    // Set decided_by default to 'mcp-client' if not provided
    const decidedByValue = decided_by || 'mcp-client';

    // Write the decision
    const result = writeDecision(projectPath, resolvedStepId, {
      decision,
      comment: comment || null,
      decided_by: decidedByValue
    });

    if (!result.ok) {
      return {
        ok: false,
        code: 'WRITE_DECISION_FAILED',
        message: result.error
      };
    }

    // === Success Response ===

    return {
      ok: true,
      code: 'APPROVAL_RECORDED',
      step_id: resolvedStepId,
      project,
      decision,
      comment: comment || null,
      decided_by: decidedByValue,
      decided_at: result.data.decided_at,
      // Notification payload: pipeline-state should reflect decision
      notification: {
        type: 'approval_decision',
        step_id: resolvedStepId,
        decision,
        decided_by: decidedByValue,
        decided_at: result.data.decided_at,
        awaiting_approval: false // The approval is no longer pending
      }
    };

  } catch (err) {
    return {
      ok: false,
      code: 'UNEXPECTED_ERROR',
      message: err.message
    };
  }
}

/**
 * MCP Tool: approve_step
 */
export default {
  name: 'approve_step',
  description: 'Approve or reject a pending pipeline step',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    step_id: z.string().describe('ID of the step to approve or reject'),
    decision: z.enum(['approve', 'reject']).describe('Decision: approve or reject'),
    comment: z.string().optional().describe('Optional comment (max 1000 characters)'),
    decided_by: z.string().optional().describe('Who made the decision (default: mcp-client)')
  }),
  async execute(args) {
    return approve_step(args);
  }
};
