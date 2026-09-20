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
 * Creates a health watcher factory
 * @param {Object} options - Configuration options
 * @param {string} options.cwd - Current working directory
 * @param {Array|Function} options.projects - List of projects to monitor, or a
 *   function returning it. Функция нужна серверу: discovery пересобирает список
 *   на лету, и захваченный при старте массив устаревает после первой же правки
 *   состава проектов.
 * @param {Function} options.onAlert - Callback for alerts
 * @returns {Object} Object with start() and stop() methods
 */
export function createWatcher({ cwd, projects, onAlert }) {
  let intervalId = null;

  /** Текущий список проектов — массив либо результат вызова функции. */
  function currentProjects() {
    const list = typeof projects === 'function' ? projects() : projects;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Run all detectors for a single project and collect alerts
   * @param {string} projectPath - Project path
   * @param {Object} config - MCP health config
   * @returns {Array<Object>} Array of alert objects
   */
  function runDetectorsForProject(projectPath, config) {
    const alerts = [];
    
    // Prepare common config objects for detectors
    const detectorConfig = {
      crash_mtime_freshness_sec: config.crash_mtime_freshness_sec
    };
    
    const detectorThresholds = {
      stuck_headroom_sec: config.stuck_headroom_sec
    };
    
    const blockedThreshold = config.blocked_accumulation_threshold;
    const ghostMarker = config.ghost_execution_log_marker;
    
    // Call each detector individually with error handling
    try {
      const alert1 = detectCrashed(projectPath, detectorConfig);
      if (alert1) alerts.push(alert1);
    } catch (err) {
      console.error(`[watcher] detectCrashed error for ${projectPath}:`, err.message);
    }
    
    try {
      const alert2 = detectStuck(projectPath, detectorThresholds);
      if (alert2) alerts.push(alert2);
    } catch (err) {
      console.error(`[watcher] detectStuck error for ${projectPath}:`, err.message);
    }
    
    try {
      const alert3 = detectStageError(projectPath);
      if (alert3) alerts.push(alert3);
    } catch (err) {
      console.error(`[watcher] detectStageError error for ${projectPath}:`, err.message);
    }
    
    try {
      const alert4 = detectRetryLoop(projectPath, detectorThresholds);
      if (alert4) alerts.push(alert4);
    } catch (err) {
      console.error(`[watcher] detectRetryLoop error for ${projectPath}:`, err.message);
    }
    
    try {
      const alert5 = detectBlockedAccumulation(projectPath, blockedThreshold);
      if (alert5) alerts.push(alert5);
    } catch (err) {
      console.error(`[watcher] detectBlockedAccumulation error for ${projectPath}:`, err.message);
    }
    
    try {
      const alert6 = detectGhostExecution(projectPath, ghostMarker);
      if (alert6) alerts.push(alert6);
    } catch (err) {
      console.error(`[watcher] detectGhostExecution error for ${projectPath}:`, err.message);
    }

     try {
       const alert7 = detectApprovalPending(projectPath, config);
       if (alert7) alerts.push(alert7);
     } catch (err) {
       console.error(`[watcher] detectApprovalPending error for ${projectPath}:`, err.message);
     }

     // Detect branch divergence
     try {
       const alert8 = detectBranchDiverged(projectPath, config);
       if (alert8) alerts.push(alert8);
     } catch (err) {
       console.error(`[watcher] detectBranchDiverged error for ${projectPath}:`, err.message);
     }

     return alerts;
  }
  
  /**
   * Start the watcher tick-loop
   */
  function start() {
    // Warn if too many projects
    const initialProjects = currentProjects();
    if (initialProjects.length > 20) {
      console.warn(`Health watcher monitoring ${initialProjects.length} projects. Consider configuring a whitelist for better performance.`);
    }
    
    // Get tick interval from config
    const config = getMcpConfig(cwd);
    const tickIntervalSec = config.tick_interval_sec ?? 15;
    const tickIntervalMs = tickIntervalSec * 1000;
    
    // Set up tick loop
    intervalId = setInterval(() => {
      // Get config once per tick for detector thresholds
      const config = getMcpConfig(cwd);
      
      // Loop through projects and run all detectors
      for (const project of currentProjects()) {
        // Run each detector and collect non-null alerts
        const alerts = runDetectorsForProject(project.path, config);
        
        // Send alerts to callback
        for (const alert of alerts) {
          onAlert(alert);
        }
      }
    }, tickIntervalMs);
  }
  
  /**
   * Stop the watcher and clean up resources
   */
  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
   }
   
   return { start, stop };
 }

