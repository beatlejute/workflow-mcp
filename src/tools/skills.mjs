import { listSkills } from '../../../workflowAi/src/lib/operations/skills.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowAiRoot = join(__dirname, '../../../workflowAi');

/**
 * List available skills
 * @param {Object} params - Parameters
 * @param {string} [params.project] - Project root path. If not provided, returns only shared skills from global workflow-ai
 * @returns {Promise<Array<{name: string, path: string, source: 'shared' | 'ejected'}>>}
 */
export async function list_skills(params = {}) {
  let projectRoot;

  if (params.project) {
    // Validate that the project directory exists
    const { existsSync } = await import('node:fs');
    if (!existsSync(params.project)) {
      const err = new Error(`Project not found: ${params.project}`);
      err.code = 'INVALID_PROJECT';
      throw err;
    }
    projectRoot = params.project;
  } else {
    // If no project, use global workflow-ai root to get only shared skills
    projectRoot = workflowAiRoot;
  }

  const skills = await listSkills(projectRoot);

  // If no project specified, filter to only shared skills
  if (!params.project) {
    return skills.filter(skill => skill.source === 'shared');
  }

  return skills;
}
