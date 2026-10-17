import fs from 'node:fs';
import path from 'node:path';

const PROJECT_MARKERS = ['tickets', 'config', 'plans'];

/**
 * Whether a workflow directory contains a project marker directory.
 * @param {string} workflowDir
 * @returns {boolean}
 */
export function isProjectWorkflow(workflowDir) {
  return PROJECT_MARKERS.some((marker) => {
    try {
      return fs.statSync(path.join(workflowDir, marker)).isDirectory();
    } catch {
      return false;
    }
  });
}
