import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

// In-memory cache for file contents with mtime tracking
const pipelineCache = new Map();
const mcpConfigCache = new Map();

/**
 * Reads stage timeout from pipeline.yaml
 * @param {string} projectPath - Path to project directory
 * @param {string} stage - Stage name
 * @returns {number} Timeout value in seconds
 * @throws {Error} With message 'STAGE_NOT_FOUND' if stage not found
 */
export function getStageTimeout(projectPath, stage) {
  const pipelinePath = resolve(projectPath, '.workflow', 'config', 'pipeline.yaml');
  
  // Check cache validity
  const cached = pipelineCache.get(pipelinePath);
  if (cached && cached.mtime === getMtime(pipelinePath)) {
    const stages = cached.data.pipeline?.stages || {};
    const stageConfig = stages[stage];
    if (!stageConfig) {
      throw new Error('STAGE_NOT_FOUND');
    }
    // Extract timeout from stage config (need to check structure)
    // Based on pipeline.yaml, stages have timeout property
    return stageConfig.timeout ?? 300; // default 5 minutes if not specified
  }
  
  // Read and parse file
  let data;
  try {
    const fileContent = readFileSync(pipelinePath, 'utf8');
    data = yaml.load(fileContent);
  } catch (error) {
    // If file doesn't exist or parsing fails, throw appropriate error
    if (error.code === 'ENOENT') {
      throw new Error('PIPELINE_NOT_FOUND');
    }
    throw error;
  }
  
  // Update cache
  pipelineCache.set(pipelinePath, {
    data,
    mtime: getMtime(pipelinePath)
  });
  
  const stages = data.pipeline?.stages || {};
  const stageConfig = stages[stage];
  if (!stageConfig) {
    throw new Error('STAGE_NOT_FOUND');
  }
  
  return stageConfig.timeout ?? 300;
}

/**
 * Reads counter limit from pipeline.yaml
 * @param {string} projectPath - Path to project directory
 * @param {string} counterName - Counter name
 * @returns {number|null} Limit value or null if not set
 */
export function getCounterLimit(projectPath, counterName) {
  const pipelinePath = resolve(projectPath, '.workflow', 'config', 'pipeline.yaml');
  
  // Check cache validity
  const cached = pipelineCache.get(pipelinePath);
  if (cached && cached.mtime === getMtime(pipelinePath)) {
    const counters = cached.data.pipeline?.counters || {};
    return counters[counterName]?.limit ?? null;
  }
  
  // Read and parse file
  let data;
  try {
    const fileContent = readFileSync(pipelinePath, 'utf8');
    data = yaml.load(fileContent);
  } catch (error) {
    // If file doesn't exist or parsing fails, return null
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  
  // Update cache
  pipelineCache.set(pipelinePath, {
    data,
    mtime: getMtime(pipelinePath)
  });
  
  const counters = data.pipeline?.counters || {};
  return counters[counterName]?.limit ?? null;
}

/**
 * Reads MCP health configuration from .workflow-mcp.yaml
 * @param {string} cwd - Current working directory
 * @returns {McpHealthConfig} Configuration object with defaults
 */
export function getMcpConfig(cwd) {
  const mcpConfigPath = resolve(cwd, '.workflow-mcp.yaml');
  
  // Check cache validity
  const cached = mcpConfigCache.get(mcpConfigPath);
  if (cached && cached.mtime === getMtime(mcpConfigPath)) {
    return cached.data;
  }
  
   // Default configuration
   const defaults = {
     tick_interval_sec: 15,
     stuck_headroom_sec: 60,
     blocked_accumulation_threshold: 5,
     ghost_execution_log_marker: '[GHOST-EXECUTION]',
     crash_mtime_freshness_sec: 60,
     dedup_fingerprint_ttl_sec: 3600,
     approval_pending_threshold_sec: 600,
     branch_diverged_max_behind: 10,
     branch_diverged_max_ahead: 30
   };
  
  // If file doesn't exist, return defaults
  if (!existsSync(mcpConfigPath)) {
    mcpConfigCache.set(mcpConfigPath, {
      data: defaults,
      mtime: 0
    });
    return defaults;
  }
  
  // Read and parse file
  let data;
  try {
    const fileContent = readFileSync(mcpConfigPath, 'utf8');
    const parsed = yaml.load(fileContent);
    // Extract health section
    data = {
      ...defaults,
      ...(parsed.health || {})
    };
  } catch (error) {
    // If parsing fails, return defaults to avoid breaking
    if (error.code === 'ENOENT') {
      return defaults;
    }
    // For parsing errors, still return defaults to avoid breaking
    return defaults;
  }
  
  // Update cache
  mcpConfigCache.set(mcpConfigPath, {
    data,
    mtime: getMtime(mcpConfigPath)
  });
  
  return data;
}

/**
 * Gets file modification time or 0 if file doesn't exist
 * @param {string} filePath - Path to file
 * @returns {number} Modification time in milliseconds
 */
function getMtime(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}