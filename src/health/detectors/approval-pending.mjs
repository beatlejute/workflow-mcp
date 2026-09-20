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
/**
 * Имя проекта из пути.
 *
 * Разделитель обязан быть обоим: `discoverProjects` отдаёт на Windows пути с
 * `\`, и разбор только по `/` клал в `project` и в отпечаток весь путь
 * вида `D:\Dev\proj` вместо имени. Остальные детекторы считают так же.
 */
function projectName(projectPath) {
  return projectPath.split(/[\/]/).filter(Boolean).pop() || 'unknown';
}

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
             const ageSec = (now - new Date(approval.created_at).getTime()) / 1000;
             if (ageSec > threshold / 2) {
               return {
                 fingerprint: `approval_pending:${projectName(projectPath)}:${file}`,
                 type: 'approval_pending',
                 severity: ageSec > threshold ? 'warning' : 'info',
                 project: projectName(projectPath),
                 step_id: file.replace('.json', ''),
                 message: `Approval pending for ${file} since ${new Date(approval.created_at).toISOString()}`,
                detected_at: new Date(now).toISOString(),
                suggested_actions: ['approve_step', 'list_running_pipelines']
              };
            }
          }
        } catch (e) {
          // Битый файл одобрения остаётся битым: жаловаться на него каждый
          // тик бессмысленно. Пропускаем молча — как и остальные детекторы,
          // которые не печатают своё обычное «нечего сказать».
        }
      }
    }
  } catch (e) {
    console.error(`[approval-pending] Error scanning ${approvalsDir}:`, e.message);
  }

  return null;
}
