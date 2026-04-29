import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {'approve' | 'reject'} Decision
 */

/**
 * Approval file schema
 * @typedef {Object} ApprovalFile
 * @property {string} step_id
 * @property {string} ticket_id
 * @property {'pending' | 'approved' | 'rejected'} stage
 * @property {string} status - 'pending' | 'decided'
 * @property {string} pending_since - ISO timestamp
 * @property {string | null} decided_at - ISO timestamp
 * @property {Decision | null} decision
 * @property {string | null} decided_by
 * @property {string | null} comment
 */

/**
 * Zod-like schema validation (manual to avoid dependency).
 * @param {unknown} data
 * @returns {{ valid: true, data: ApprovalFile } | { valid: false, error: string }}
 */
function validateApprovalFile(data) {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'Approval file must be an object' };
  }

  const required = {
    step_id: 'string',
    ticket_id: 'string',
    stage: 'string',
    status: 'string',
    pending_since: 'string',
    decided_at: ['string', 'null'],
    decision: ['string', 'null'],
    decided_by: ['string', 'null'],
    comment: ['string', 'null'],
  };

  for (const [field, type] of Object.entries(required)) {
    const value = data[field];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some(t => (t === 'null' && value === null) || (t === 'string' && typeof value === 'string'))) {
      return { valid: false, error: `Field "${field}" must be of type ${types.join('|')}` };
    }
  }

  if (!['pending', 'approved', 'rejected'].includes(data.stage)) {
    return { valid: false, error: 'Field "stage" must be one of: pending, approved, rejected' };
  }

  if (data.status !== 'pending' && data.status !== 'decided') {
    return { valid: false, error: 'Field "status" must be one of: pending, decided' };
  }

  if (data.decision !== null && !['approve', 'reject'].includes(data.decision)) {
    return { valid: false, error: 'Field "decision" must be one of: approve, reject, or null' };
  }

  if (data.decision === 'approve' && data.stage !== 'approved') {
    return { valid: false, error: 'If decision is "approve", stage must be "approved"' };
  }

  if (data.decision === 'reject' && data.stage !== 'rejected') {
    return { valid: false, error: 'If decision is "reject", stage must be "rejected"' };
  }

  if (data.decision === null && data.status === 'decided') {
    return { valid: false, error: 'If status is "decided", decision must not be null' };
  }

  if (data.decision !== null && data.decided_at === null) {
    return { valid: false, error: 'If decision is set, decided_at must not be null' };
  }

  if (data.decided_by !== null && typeof data.decided_by !== 'string') {
    return { valid: false, error: 'Field "decided_by" must be a string or null' };
  }

  if (data.comment !== null && typeof data.comment !== 'string') {
    return { valid: false, error: 'Field "comment" must be a string or null' };
  }

  return { valid: true, data };
}

/**
 * Get the approval file path for a given project and step.
 * @param {string} projectPath
 * @param {string} stepId
 * @returns {string}
 */
function getApprovalPath(projectPath, stepId) {
  return path.join(projectPath, '.workflow', 'approvals', `${stepId}.json`);
}

/**
 * Read an approval file with schema validation.
 * @param {string} projectPath
 * @param {string} stepId
 * @returns {{ ok: true, data: ApprovalFile } | { ok: false, error: string }}
 */
export function readApproval(projectPath, stepId) {
  const filePath = getApprovalPath(projectPath, stepId);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    const validation = validateApprovalFile(parsed);
    if (!validation.valid) {
      return { ok: false, error: `Invalid approval file: ${validation.error}` };
    }
    return { ok: true, data: validation.data };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: `Approval file not found: ${filePath}` };
    }
    return { ok: false, error: `Failed to read approval file: ${err.message}` };
  }
}

/**
 * Write a decision to an approval file atomically using temp+rename.
 * Idempotent - if the file is already decided, returns previous decision.
 * @param {string} projectPath
 * @param {string} stepId
 * @param {{ decision: Decision, comment?: string, decided_by?: string } | null} params
 * @returns {{ ok: true, decided: boolean, already?: boolean, previous?: Decision, data?: ApprovalFile } | { ok: false, error: string }}
 */
export function writeDecision(projectPath, stepId, params) {
  const filePath = getApprovalPath(projectPath, stepId);

  // If already decided and file exists, check idempotency
  const existing = readApproval(projectPath, stepId);
  if (existing.ok && existing.data.status === 'decided') {
    return {
      ok: true,
      decided: true,
      already: true,
      previous: existing.data.decision,
      data: existing.data,
    };
  }

  if (params === null) {
    return { ok: false, error: 'Decision parameters are required' };
  }

  const { decision, comment = null, decided_by = null } = params;

  if (!['approve', 'reject'].includes(decision)) {
    return { ok: false, error: `Invalid decision: must be "approve" or "reject"` };
  }

  const now = new Date().toISOString();
  const stage = decision === 'approve' ? 'approved' : 'rejected';

  let baseData = {};
  if (existing.ok) {
    baseData = existing.data;
  } else {
    // Create fresh approval file
    baseData = {
      step_id: stepId,
      ticket_id: '',
      stage: 'pending',
      status: 'pending',
      pending_since: now,
      decided_at: null,
      decision: null,
      decided_by: null,
      comment: null,
    };
  }

  // Ensure approvals directory exists
  const approvalsDir = path.dirname(filePath);
  try {
    if (!fs.existsSync(approvalsDir)) {
      fs.mkdirSync(approvalsDir, { recursive: true });
    }
  } catch (err) {
    return { ok: false, error: `Failed to create approvals directory: ${err.message}` };
  }

  const newData = {
    ...baseData,
    stage,
    status: 'decided',
    decided_at: now,
    decision,
    decided_by,
    comment,
  };

  const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  try {
    // Write to temp file first
    fs.writeFileSync(tempFile, JSON.stringify(newData, null, 2), { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `Failed to write temp file: ${err.message}` };
  }

  try {
    // Atomic rename
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    // Clean up temp file on rename failure
    try { fs.unlinkSync(tempFile); } catch (_) {}
    return { ok: false, error: `Failed to commit approval file: ${err.message}` };
  }

  return { ok: true, decided: true, data: newData };
}

/**
 * List all pending approvals in a project.
 * @param {string} projectPath
 * @returns {{ ok: true, approvals: Array<ApprovalFile> } | { ok: false, error: string }}
 */
export function listPending(projectPath) {
  const approvalsDir = path.join(projectPath, '.workflow', 'approvals');

  try {
    if (!fs.existsSync(approvalsDir)) {
      return { ok: true, approvals: [] };
    }

    const files = fs.readdirSync(approvalsDir);
    const approvals = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(approvalsDir, file);
      const result = readApproval(projectPath, path.basename(file, '.json'));

      if (result.ok && result.data.status === 'pending') {
        approvals.push(result.data);
      }
    }

    return { ok: true, approvals };
  } catch (err) {
    return { ok: false, error: `Failed to list pending approvals: ${err.message}` };
  }
}
