import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'path';

/**
 * Applies approval_pending_threshold_sec from MCP config
 * @param {Object} config - MCP health configuration
 * @returns {number} Threshold in seconds
 */
export function getApprovalPendingThreshold(config) {
  return config.approval_pending_threshold_sec ?? 600;
}

/**
 * Detects pending approvals by scanning .workflow/approvals/ directory
 * Returns an alert if any approval exceeds threshold
 * @param {string} projectPath - Project directory path
 * @param {Object} config - MCP health configuration
 * @returns {Object|null} Alert object or null
 */
export function detectApprovalPending(projectPath, config) {
  const approvalsDir = join(projectPath, '.workflow', 'approvals');
  const threshold = getApprovalPendingThreshold(config);
  const now = Date.now();

  if (!existsSync(approvalsDir)) return null;

  try {
    const files = readdirSync(approvalsDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(approvalsDir, file);
        const content = readFileSync(filePath, 'utf8');
        try {
          const approval = JSON.parse(content);
          if (approval.status === 'pending') {
            const ageSec = (now - new Date(approval.pending_since).getTime()) / 1000;
            if (ageSec > threshold / 2) {
              return {
                fingerprint: `approval_pending:${projectPath.split('/').pop()}:${file}`,
                type: 'approval_pending',
                severity: ageSec > threshold ? 'warning' : 'info',
                project: projectPath.split('/').pop(),
                step_id: file.replace('.json', ''),
                message: `Approval pending for ${file} since ${new Date(approval.pending_since).toISOString()}`,
                detected_at: now,
                suggested_actions: ['approve_step', 'list_running_pipelines']
              };
            }
          }
        } catch (e) {
          console.warn(`[approval-pending] Error parsing ${filePath}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error(`[approval-pending] Error scanning ${approvalsDir}:`, e.message);
  }

  return null;
}
