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
 * Runner (workflow-ai) и MCP описывают один и тот же файл разным словарём:
 * runner пишет status: pending|approved|rejected + created_at/updated_at,
 * MCP оперирует status: pending|decided + stage + decision + pending_since.
 * Приводим прочитанное к канону MCP, сохраняя остальные поля файла как есть.
 * @param {Object} raw
 * @param {string} [mtimeIso] - fallback для pending_since
 * @returns {Object}
 */
function normalizeApprovalData(raw, mtimeIso) {
  if (typeof raw !== 'object' || raw === null) return raw;

  const data = { ...raw };
  const decisionFromStatus = { approved: 'approve', rejected: 'reject' }[raw.status];

  if (decisionFromStatus) {
    data.status = 'decided';
    data.stage = raw.stage || raw.status;
    data.decision = raw.decision || decisionFromStatus;
  } else if (raw.status === 'pending') {
    data.stage = raw.stage || 'pending';
    if (data.decision === undefined) data.decision = null;
  }

  if (typeof data.pending_since !== 'string') {
    data.pending_since = raw.created_at || mtimeIso || null;
  }
  if (data.decided_at === undefined || data.decided_at === null) {
    data.decided_at = data.status === 'decided'
      ? (raw.decided_at || raw.updated_at || null)
      : null;
  }
  if (data.ticket_id === undefined) data.ticket_id = '';
  if (data.decided_by === undefined) data.decided_by = null;
  if (data.comment === undefined) data.comment = null;

  return data;
}

/**
 * Read an approval file without normalization — нужен writeDecision,
 * чтобы не потерять поля раннера (stage_id, attempt, context_snapshot).
 * @param {string} projectPath
 * @param {string} stepId
 * @returns {Object|null}
 */
function readApprovalRaw(projectPath, stepId) {
  try {
    return JSON.parse(fs.readFileSync(getApprovalPath(projectPath, stepId), 'utf8'));
  } catch {
    return null;
  }
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
    let mtimeIso;
    try { mtimeIso = fs.statSync(filePath).mtime.toISOString(); } catch { mtimeIso = undefined; }
    const validation = validateApprovalFile(normalizeApprovalData(parsed, mtimeIso));
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

  // Базой берём СЫРОЙ файл, а не нормализованный: у manual-gate раннера есть
  // свои поля (stage_id, attempt, context_snapshot), которые нельзя терять.
  let baseData = readApprovalRaw(projectPath, stepId);
  if (!baseData) {
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

  // Раннер (workflow-ai) в manual-gate поллит именно status === 'approved'|'rejected'
  // (runner.mjs executeManualGate). Пишем его словарь в status, а канон MCP
  // (stage/decision/decided_at) — рядом; readApproval нормализует обратно.
  const newData = {
    ...baseData,
    stage,
    status: stage,
    decided_at: now,
    updated_at: now,
    decision,
    decided_by,
    comment,
  };
  if (!newData.step_id) newData.step_id = stepId;
  if (newData.ticket_id === undefined) newData.ticket_id = '';
  if (!newData.pending_since) newData.pending_since = baseData.created_at || now;

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

  return { ok: true, decided: true, data: normalizeApprovalData(newData) };
}

/**
 * Найти реальное имя approval-файла по step_id.
 *
 * Раннер именует файл композитным step_id (`<ticket>_<stage>_<attempt>.json`,
 * runner.mjs computeStepId), поэтому точное совпадение имени работает только
 * если клиент передал полный id. Если файла нет — сканируем каталог и ищем
 * pending по полю step_id или по префиксу имени.
 *
 * @param {string} projectPath
 * @param {string} stepId
 * @returns {{ ok: true, step_id: string } | { ok: false, code: string, candidates?: string[] }}
 */
export function resolvePendingStepId(projectPath, stepId) {
  const approvalsDir = path.join(projectPath, '.workflow', 'approvals');

  if (fs.existsSync(getApprovalPath(projectPath, stepId))) {
    return { ok: true, step_id: stepId };
  }

  let files;
  try {
    files = fs.readdirSync(approvalsDir).filter(file => file.endsWith('.json'));
  } catch {
    return { ok: false, code: 'NOT_FOUND' };
  }

  const matches = [];
  for (const file of files) {
    const base = path.basename(file, '.json');
    const raw = readApprovalRaw(projectPath, base);
    if (!raw) continue;
    if (raw.status !== 'pending') continue;
    if (raw.step_id === stepId || base === stepId || base.startsWith(`${stepId}_`)) {
      matches.push(base);
    }
  }

  if (matches.length === 1) return { ok: true, step_id: matches[0] };
  if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS', candidates: matches };
  return { ok: false, code: 'NOT_FOUND' };
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
