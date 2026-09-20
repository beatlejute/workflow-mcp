/**
 * Обход детекторов: один проход по проектам, восемь детекторов на проект.
 *
 * Жил внутри `createWatcher` и вызывался только из тика. Ресурс
 * `workflow://alerts` при этом читал историю публикаций и выдавал её за
 * текущее состояние: разрешившееся условие висело в списке сутки, пока запись
 * не состарится. Обход вынесен сюда, чтобы у ресурса был тот же источник, что
 * у тика, — и чтобы копии кода не завелось.
 *
 * Все детекторы синхронные и защищены по одному: поломка одного не отменяет
 * остальные и не роняет ни тик, ни чтение ресурса.
 */

import { getMcpConfig } from './thresholds.mjs';
import { detectCrashed } from './detectors/crashed.mjs';
import { detectStuck } from './detectors/stuck.mjs';
import { detectStageError } from './detectors/stage-error.mjs';
import { detectRetryLoop } from './detectors/retry-loop.mjs';
import { detectBlockedAccumulation } from './detectors/blocked-accumulation.mjs';
import { detectGhostExecution } from './detectors/ghost-execution.mjs';
import { detectApprovalPending } from './detectors/approval-pending.mjs';
import { detectBranchDiverged } from './detectors/branch-diverged.mjs';

/**
 * Прогнать все детекторы по одному проекту.
 *
 * @param {string} projectPath - Путь к корню проекта
 * @param {Object} config - Конфиг здоровья (`getMcpConfig`)
 * @returns {Array<Object>} Алерты, которые сработали
 */
export function runDetectorsForProject(projectPath, config) {
  const alerts = [];

  const detectorConfig = {
    crash_mtime_freshness_sec: config.crash_mtime_freshness_sec
  };

  const detectorThresholds = {
    stuck_headroom_sec: config.stuck_headroom_sec
  };

  const detectors = [
    ['detectCrashed', () => detectCrashed(projectPath, detectorConfig)],
    ['detectStuck', () => detectStuck(projectPath, detectorThresholds)],
    ['detectStageError', () => detectStageError(projectPath)],
    ['detectRetryLoop', () => detectRetryLoop(projectPath, detectorThresholds)],
    ['detectBlockedAccumulation', () => detectBlockedAccumulation(projectPath, config.blocked_accumulation_threshold)],
    ['detectGhostExecution', () => detectGhostExecution(projectPath, config.ghost_execution_log_marker)],
    ['detectApprovalPending', () => detectApprovalPending(projectPath, config)],
    ['detectBranchDiverged', () => detectBranchDiverged(projectPath, config)]
  ];

  for (const [name, run] of detectors) {
    try {
      const alert = run();
      if (alert) alerts.push(alert);
    } catch (err) {
      console.error(`[health] ${name} error for ${projectPath}:`, err.message);
    }
  }

  return alerts;
}

/**
 * Обойти проекты и собрать всё, что сработало прямо сейчас.
 *
 * Обход синхронный: на проект с живым lock'ом приходится вызов `tasklist`, на
 * git-проект — `git status`, у каждого таймаут 5 секунд. Это цена и тика, и
 * чтения `workflow://alerts`.
 *
 * @param {string} cwd - Корень рабочей области
 * @param {Array<{path: string}>} projects - Проекты обхода
 * @returns {Array<Object>} Алерты, отсортированные по `detected_at` (свежие первыми)
 */
export function sweepProjects(cwd, projects) {
  const config = getMcpConfig(cwd);
  const alerts = [];

  for (const project of projects) {
    if (!project || typeof project.path !== 'string') continue;
    alerts.push(...runDetectorsForProject(project.path, config));
  }

  return alerts.sort((a, b) => new Date(b.detected_at || 0) - new Date(a.detected_at || 0));
}
