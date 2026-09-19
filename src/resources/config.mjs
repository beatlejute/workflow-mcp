import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../discovery.mjs';

/**
 * Static Config Resources - read-only YAML config files
 *
 * Resource URIs:
 *   - workflow://{project}/config/pipeline
 *   - workflow://{project}/config/ticket-movement-rules
 *
 * Both read corresponding YAML files from <project>/.workflow/config/
 * Path traversal protection: project is validated via discovery.
 * MIME: application/yaml, encoding: UTF-8.
 */

/**
 * Validate project name - only allow existing discovered projects
 * @param {string} cwd
 * @param {string} projectName
 * @returns {{name: string, path: string}|null}
 */
function validateProject(cwd, projectName) {
  // Prevent path traversal in project name
  if (!projectName || projectName.includes('/') || projectName.includes('\\') || projectName.includes('..')) {
    return null;
  }

  const projects = discoverProjects(cwd);
  const project = projects.find(p => p.name === projectName);
  return project || null;
}

/**
 * Safely resolve a config file path within the project's .workflow/config/ directory
 * @param {string} projectPath - Absolute project path
 * @param {string} filename - Config filename (e.g., 'pipeline.yaml')
 * @returns {string|null} Safe absolute path or null if path traversal detected
 */
function resolveConfigFile(projectPath, filename) {
  // Prevent path traversal in filename
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }

  // В проекте каталог называется `config` (его создаёт `workflow init` junction'ом
  // на `~/.workflow/configs`). Множественное число — только внутри пакета и в global dir.
  const configDir = path.join(projectPath, '.workflow', 'config');
  const resolvedPath = path.join(configDir, filename);

  // Ensure the resolved path is within the config directory (double-check)
  const normalizedConfigDir = path.resolve(configDir) + path.sep;
  const normalizedResolvedPath = path.resolve(resolvedPath);

  if (!normalizedResolvedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  return normalizedResolvedPath;
}

/**
 * Read a YAML config file
 * @param {string} filePath
 * @returns {{content: string, size: number}|null}
 */
function readConfigFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, size: Buffer.byteLength(content, 'utf-8') };
  } catch (err) {
    return null;
  }
}

/**
 * Get the list of available config resources for a project
 * @param {string} cwd
 * @param {string} projectName
 * @returns {Array<{uri: string, format: string, description: string, mimeType: string}>}
 */
function getProjectConfigResources(cwd, projectName) {
  const project = validateProject(cwd, projectName);
  if (!project) {
    return [];
  }

  const configsDir = path.join(project.path, '.workflow', 'config');
  const configFiles = [];

  try {
    if (fs.existsSync(configsDir)) {
      const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        // Map filename to resource type
        let resourceName;
        if (file === 'pipeline.yaml') {
          resourceName = 'pipeline';
        } else if (file === 'ticket-movement-rules.yaml') {
          resourceName = 'ticket-movement-rules';
        } else {
          // Generic config resource
          resourceName = file.replace(/\.ya?ml$/, '');
        }
        configFiles.push({
          uri: `workflow://${projectName}/config/${resourceName}`,
          format: 'YAML',
          description: `Configuration: ${file}`,
          mimeType: 'application/yaml'
        });
      }
    }
  } catch (err) {
    // Silent fail - no configs discovered
  }

  return configFiles;
}

/**
 * Get a specific config resource
 * @param {string} cwd
 * @param {string} projectName
 * @param {string} resourceType - e.g., 'pipeline' or 'ticket-movement-rules'
 * @returns {{uri: string, mimeType: string, text: string}|null}
 */
function getConfigResource(cwd, projectName, resourceType) {
  const project = validateProject(cwd, projectName);
  if (!project) {
    return null;
  }

  // Map resource type to filename
  const filename = `${resourceType}.yaml`;
  const filePath = resolveConfigFile(project.path, filename);

  if (!filePath) {
    return null;
  }

  const fileData = readConfigFile(filePath);
  if (!fileData) {
    return null;
  }

  return {
    uri: `workflow://${projectName}/config/${resourceType}`,
    mimeType: 'application/yaml',
    text: fileData.content
  };
}

/**
 * Check if the resource list should be refreshed (called on discovery changes)
 * This function re-reads the project config directory.
 *
 * @param {string} cwd
 * @returns {Array<{uri: string, format: string, description: string, mimeType: string}>}
 */
export function resources_list_config(cwd) {
  const projects = discoverProjects(cwd);
  const allResources = [];

  for (const project of projects) {
    const configs = getProjectConfigResources(cwd, project.name);
    allResources.push(...configs);
  }

  return allResources;
}

/**
 * Get workflow://{project}/config/pipeline resource
 * @param {string} cwd
 * @param {string} projectName
 * @returns {{uri: string, mimeType: string, text: string}}
 */
export async function get_workflow_project_config_pipeline(cwd, projectName) {
  const result = getConfigResource(cwd || process.cwd(), projectName, 'pipeline');
  if (!result) {
    const err = new Error('RESOURCE_NOT_FOUND');
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  return result;
}

/**
 * Get workflow://{project}/config/ticket-movement-rules resource
 * @param {string} cwd
 * @param {string} projectName
 * @returns {{uri: string, mimeType: string, text: string}}
 */
export async function get_workflow_project_config_ticket_movement_rules(cwd, projectName) {
  const result = getConfigResource(cwd || process.cwd(), projectName, 'ticket-movement-rules');
  if (!result) {
    const err = new Error('RESOURCE_NOT_FOUND');
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  return result;
}
