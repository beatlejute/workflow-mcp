/**
 * Human-queue watcher integration.
 * Watches for HUMAN tickets across all projects and notifies subscribers.
 */

import fs from 'fs';
import path from 'path';
import { FsOrPollWatcher } from './fs-or-poll.mjs';
import { parseFrontmatter } from '../../../workflowAi/src/lib/utils.mjs';
import * as resources from '../resources/index.mjs';

export class HumanQueueWatcher {
  constructor(options = {}) {
    this.projects = options.projects || [];
    this.debounceMs = options.debounceMs || 2000;
    this.watcher = null;
    this.isRunning = false;
    this.lastSeenState = new Map(); // Track last known state of human tickets
  }

  /**
   * Start watching for human-queue changes
   */
  start() {
    if (this.isRunning) {
      console.error('[human-queue-watcher] Already running');
      return;
    }

    this.isRunning = true;

    // Create and configure the fs-or-poll watcher
    this.watcher = new FsOrPollWatcher({
      projects: this.projects,
      debounceMs: this.debounceMs,
      maxProjectsForWatch: 20
    });

    // Listen for file change events
    this.watcher.on('change', (event) => {
      this.handleFileChange(event);
    });

    // Start the underlying watcher
    this.watcher.start();

    console.error('[human-queue-watcher] started watching', this.projects.length, 'project(s)');
  }

  /**
   * Stop watching
   */
  stop() {
    if (!this.isRunning || !this.watcher) {
      return;
    }

    this.isRunning = false;
    this.watcher.stop();
    this.lastSeenState.clear();

    console.error('[human-queue-watcher] stopped');
  }

  /**
   * Handle a file change event
   * @private
   */
  handleFileChange(event) {
    const { filename, project } = event;

    if (!filename) {
      return;
    }

    // Check if this is a human ticket based on filename or content
    if (!filename.endsWith('.md')) {
      return;
    }

    // Find the actual file path - filename might be relative
    const projectPath = typeof project === 'string' ? project : project.path;
    const ticketsDir = path.join(projectPath, '.workflow', 'tickets');

    // The filename from the watcher might be:
    // 1. Just the basename: "HUMAN-001.md"
    // 2. Relative path: "in-progress/HUMAN-001.md"
    // 3. Full path: "/path/to/.workflow/tickets/in-progress/HUMAN-001.md"

    const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
    let filePath = null;

    // Try direct path first (if filename is absolute or relative to project)
    if (fs.existsSync(filename)) {
      filePath = filename;
    } else {
      // Try relative to tickets directory
      for (const status of statuses) {
        const candidate1 = path.join(ticketsDir, status, path.basename(filename));
        if (fs.existsSync(candidate1)) {
          filePath = candidate1;
          break;
        }

        // Also try if filename includes status directory
        const candidate2 = path.join(ticketsDir, filename);
        if (fs.existsSync(candidate2)) {
          filePath = candidate2;
          break;
        }
      }
    }

    // If not found, skip
    if (!filePath || !fs.existsSync(filePath)) {
      return;
    }

    // Read the file to check if it's a human ticket
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // Check if it's a human ticket (by prefix or type field)
      const baseName = path.basename(filePath);
      const isHumanByPrefix = baseName.startsWith('HUMAN-');
      const isHumanByType = frontmatter && frontmatter.type === 'human';

      if (!isHumanByPrefix && !isHumanByType) {
        // Not a human ticket, don't notify
        return;
      }

      // This is a human ticket - notify subscribers
      resources.notify_workflow_human_queue({
        project: projectPath,
        filename: baseName,
        ticketId: frontmatter?.id || baseName.replace('.md', ''),
        timestamp: Date.now()
      });

      console.error(`[human-queue-watcher] change detected: ${projectPath}/${baseName}`);
    } catch (err) {
      console.error(`[human-queue-watcher] error processing ${filePath}:`, err.message);
    }
  }
}

/**
 * Create a human-queue watcher instance
 * @param {Object} options - Configuration options
 * @returns {HumanQueueWatcher}
 */
export function createHumanQueueWatcher(options = {}) {
  return new HumanQueueWatcher(options);
}
