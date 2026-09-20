/**
 * File system watcher or polling fallback for multiple projects.
 * Implements the strategy for choosing between fs.watch and polling.
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

export class FsOrPollWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cwd = options.cwd || process.cwd();
    this.projects = options.projects || [];
    this.debounceMs = options.debounceMs || 2000;
    this.maxProjectsForWatch = options.maxProjectsForWatch || 20;
    this.watchers = new Map();
    this.pollIntervals = new Map();
    this.debouncedCallbacks = new Map();
    this.isWatching = false;
  }

  /**
   * Start watching projects
   */
  start() {
    if (this.isWatching) return;
    
    this.isWatching = true;
    
    if (this.shouldUsePolling()) {
      this.startPolling();
    } else {
      this.startWatching();
    }
  }

  /**
   * Stop watching all projects
   */
  stop() {
    if (!this.isWatching) return;
    
    this.isWatching = false;
    
    // Stop all fs.watch watchers
    for (const [projectPath, watcher] of this.watchers) {
      try {
        watcher.close();
      } catch (err) {
        console.error(`Error closing watcher for ${projectPath}:`, err.message);
      }
    }
    this.watchers.clear();
    
    // Stop all polling intervals
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    
    // Clear debounced callbacks
    this.debouncedCallbacks.clear();
  }

  /**
   * Determine if polling should be used instead of fs.watch
   */
  shouldUsePolling() {
    // Force polling via environment variable
    if (process.env.WORKFLOW_MCP_FORCE_POLLING === '1') {
      console.log('[fs-or-poll] Using polling due to WORKFLOW_MCP_FORCE_POLLING=1');
      return true;
    }

    // Use polling for Linux with Node < 20
    if (process.platform === 'linux') {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.replace(/^v/, '').split('.')[0]);
      if (majorVersion < 20) {
        console.log(`[fs-or-poll] Using polling for Linux + Node ${majorVersion} < 20`);
        return true;
      }
    }

    // Use polling for too many projects
    if (this.projects.length > this.maxProjectsForWatch) {
      console.log(`[fs-or-poll] Using polling for ${this.projects.length} projects > ${this.maxProjectsForWatch} max`);
      return true;
    }

    // Default to fs.watch
    return false;
  }

  /**
   * Start fs.watch for each project
   */
  startWatching() {
    for (const project of this.projects) {
      this.watchProject(project);
    }
  }

  /**
   * Watch a single project directory
   */
  watchProject(project) {
    const ticketsDir = path.join(project.path, '.workflow', 'tickets');
    
    if (!fs.existsSync(ticketsDir)) {
      console.warn(`Tickets directory does not exist: ${ticketsDir}`);
      return;
    }

    const watcher = fs.watch(ticketsDir, { recursive: true }, (eventType, filename) => {
      this.handleFileChange(eventType, filename, project);
    });

    this.watchers.set(project.path, watcher);
    
    watcher.on('error', (err) => {
      console.error(`Error watching ${project.path}:`, err.message);
      this.watchers.delete(project.path);
    });
  }

  /**
   * Start polling for all projects
   */
  startPolling() {
    // Get debounce_sec from config or use default (2 seconds * 5 = 10 seconds)
    const debounceSec = this.debounceMs / 1000; // Convert to seconds
    const pollInterval = debounceSec * 5 * 1000; // Convert back to milliseconds
    console.log(`[fs-or-poll] Using polling interval: ${pollInterval}ms (${debounceSec * 5}s)`);
    
    for (const project of this.projects) {
      const interval = setInterval(() => {
        this.pollProject(project);
      }, pollInterval);
      
      this.pollIntervals.set(project.path, interval);
    }
  }

  /**
   * Poll a single project directory for changes
   */
  pollProject(project) {
    const ticketsDir = path.join(project.path, '.workflow', 'tickets');
    
    if (!fs.existsSync(ticketsDir)) {
      return;
    }

    try {
      const files = fs.readdirSync(ticketsDir, { recursive: true });
      const now = Date.now();
      
      // Simple polling: check if any files have been modified recently
      // In a real implementation, we'd track mtime of files
      this.emit('poll', { project, files, timestamp: now });
    } catch (err) {
      console.error(`Error polling ${project.path}:`, err.message);
    }
  }

  /**
   * Handle file system events
   */
  handleFileChange(eventType, filename, project) {
    if (!filename) return;

    // Filter for relevant files
    if (!this.isRelevantFile(filename)) {
      return;
    }

    // Debounce rapid events
    const projectKey = project.path;
    if (!this.debouncedCallbacks.has(projectKey)) {
      this.debouncedCallbacks.set(projectKey, setTimeout(() => {
        this.debouncedCallbacks.delete(projectKey);
        this.emit('change', { 
          eventType, 
          filename, 
          project,
          timestamp: Date.now()
        });
      }, this.debounceMs));
    }
  }

  /**
   * Check if a file is relevant for human-queue monitoring
   * Only filters for HUMAN- prefixed files here.
   * Additional filtering (e.g., type: human in frontmatter) is done by the handler.
   */
  isRelevantFile(filename) {
    // Check if filename starts with HUMAN- prefix
    if (filename.startsWith('HUMAN-')) {
      return true;
    }

    // Also include all .md files to allow handler to check frontmatter for type: human.
    // Точечные файлы — служебные: `.gitkeep.md` от `workflow init` будил
    // наблюдателя на каждое своё изменение, хотя тикетом не является.
    if (isWorkflowDoc(filename)) {
      return true;
    }

    return false;
  }

  /**
   * Get watcher statistics
   */
  getStats() {
    return {
      projectsCount: this.projects.length,
      usingPolling: this.shouldUsePolling(),
      activeWatchers: this.watchers.size,
      activePolls: this.pollIntervals.size,
      debounceCount: this.debouncedCallbacks.size,
      isWatching: this.isWatching
    };
  }
}

/**
 * Factory function to create watcher instance
 */
export function createWatcher(options = {}) {
  return new FsOrPollWatcher(options);
}