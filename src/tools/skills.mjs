import { listSkills } from 'workflow-ai/lib/operations/skills.mjs';
import { workflowAiPath } from '../lib/workflow-ai.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { mcpCwd } from '../lib/project-root.mjs';

/**
 * List available skills
 *
 * Общие скилы берутся из глобальной установки (`~/.workflow/skills`), скилы
 * проекта — из `<project>/.workflow/src/skills`; подключённые junction'ом
 * считаются общими, скопированные — вытесненными (`ejected`).
 *
 * Без `project` подставляем каталог внутри пакета workflow-ai: своих скилов
 * там нет, поэтому вернутся только общие.
 *
 * @param {Object} params - Parameters
 * @param {string} [params.project] - Project root path. If not provided, returns only shared skills from global workflow-ai
 * @returns {Promise<Array<{name: string, path: string, source: 'shared' | 'ejected'}>>}
 */
export async function list_skills(params = {}) {
  let projectRoot;

  if (params.project) {
    // Резолвим так же, как соседние tools: имя проекта относительно MCP_CWD,
    // и это должен быть workflow-проект, а не произвольный каталог.
    const cwd = mcpCwd();
    const resolved = path.resolve(cwd, params.project);
    if (!fs.existsSync(path.join(resolved, '.workflow'))) {
      const err = new Error(`Project not found or not a workflow project: ${params.project}`);
      err.code = 'INVALID_PROJECT';
      throw err;
    }
    projectRoot = resolved;
  } else {
    // If no project, use global workflow-ai root to get only shared skills
    projectRoot = workflowAiPath('src');
  }

  const skills = await listSkills(projectRoot);

  // If no project specified, filter to only shared skills
  if (!params.project) {
    return skills.filter(skill => skill.source === 'shared');
  }

  return skills;
}

/**
 * Регистрация списка скилов как MCP-tool. Нужен, в частности, расширению
 * VS Code, которое до сих пор читало каталог скилов с диска само.
 */
export const list_skills_tool = {
  name: 'list_skills',
  description: 'List skills available to a project (shared and ejected); without a project — only shared ones',
  inputSchema: z.object({
    project: z.string().optional().describe('Project root path; omit to list only shared skills')
  }),
  async execute(args) {
    return list_skills(args);
  }
};
