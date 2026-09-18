#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { discoverProjects, watchProjects } from './discovery.mjs';
import * as resources from './resources/index.mjs';
import * as configResources from './resources/config.mjs';
import { createHumanQueueWatcher } from './watchers/human-queue-watcher.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { resolveStateDir, ensureStateDir } from './paths/state-dir.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load tools from src/tools/*
 * @returns {Object[]} Array of tool definitions
 */
async function loadTools() {
  const toolsDir = resolve(__dirname, 'tools');
  const tools = [];
  const seen = new Set();

  function isValidTool(obj) {
    return obj
      && typeof obj === 'object'
      && typeof obj.name === 'string'
      && typeof obj.description === 'string'
      && typeof obj.execute === 'function'
      && obj.inputSchema;
  }

  function collectFromExport(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isValidTool(item) && !seen.has(item.name)) {
          seen.add(item.name);
          tools.push(item);
        }
      }
    } else if (isValidTool(value) && !seen.has(value.name)) {
      seen.add(value.name);
      tools.push(value);
    }
  }

  try {
    if (fs.existsSync(toolsDir)) {
      const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
      for (const file of files) {
        const toolPath = path.join(toolsDir, file);
        try {
          const module = await import(`file://${toolPath}`);
          for (const exportName of Object.keys(module)) {
            collectFromExport(module[exportName]);
          }
        } catch (err) {
          console.error(`Failed to load tool ${file}:`, err.message);
        }
      }
    }
  } catch (err) {
    // If tools directory doesn't exist or can't be read, just return empty array
  }

  return tools;
}

/**
 * Create a health watcher that periodically logs server status
 * @returns {{start: () => void, stop: () => void}}
 */
function createHealthWatcher() {
  let intervalId = null;

  return {
    start() {
      intervalId = setInterval(() => {
        console.error(`[healthwatch] server alive at ${new Date().toISOString()}`);
      }, 30000); // Log every 30 seconds
      intervalId.unref(); // Don't keep process alive for this timer
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

/**
 * Main server initialization and startup
 */
async function main() {
  // Startup guard: verify workflow-ai version compatibility
  let actualVersion;
  try {
    const require = createRequire(import.meta.url);
    // Anchor on a known-exported subpath; package.json itself is not in `exports`.
    // WORKFLOW_AI_RESOLVE_PATH overrides resolution base (used in tests for version isolation).
    const resolveOpts = process.env.WORKFLOW_AI_RESOLVE_PATH
      ? { paths: [process.env.WORKFLOW_AI_RESOLVE_PATH] }
      : undefined;
    const anchor = require.resolve('workflow-ai/lib/find-root.mjs', resolveOpts);
    let dir = path.dirname(anchor);
    let pkgPath = null;
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.name === 'workflow-ai') {
          actualVersion = pkg.version;
          pkgPath = candidate;
          break;
        }
      }
      dir = path.dirname(dir);
    }
    if (!pkgPath) {
      console.error('[workflow-mcp] FATAL: workflow-ai package.json not found near resolved entry.');
      process.exit(1);
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('[workflow-mcp] FATAL: workflow-ai not found. Run npm install.');
      process.exit(1);
    }
    console.error('[workflow-mcp] FATAL: unexpected error checking workflow-ai version:', err.message);
    process.exit(1);
  }

  const ourPkgPath = resolve(__dirname, '../package.json');
  let expectedRange;
  try {
    const ourPkgContent = fs.readFileSync(ourPkgPath, 'utf8');
    const ourPkg = JSON.parse(ourPkgContent);
    expectedRange = ourPkg.dependencies?.['workflow-ai'];
    if (!expectedRange) {
      console.error('[workflow-mcp] FATAL: workflow-ai dependency not found in package.json.');
      process.exit(1);
    }
  } catch (err) {
    console.error('[workflow-mcp] FATAL: unable to read package.json:', err.message);
    process.exit(1);
  }

  if (!semver.satisfies(actualVersion, expectedRange)) {
    const expectedMajor = semver.minVersion(expectedRange)?.major;
    const actualMajor = semver.parse(actualVersion)?.major;
    if (expectedMajor != null && actualMajor != null && actualMajor !== expectedMajor) {
      console.error(`[workflow-mcp] FATAL: workflow-ai major version mismatch (expected ${expectedRange}, got ${actualVersion})`);
      process.exit(1);
    }
    console.error(`[workflow-mcp] WARNING: workflow-ai version below expected (expected ${expectedRange}, got ${actualVersion}); continuing startup`);
  }

  // Get cwd from environment or use process.cwd()
  const cwd = process.env.MCP_CWD || process.cwd();

  // Create MCP server
  const server = new McpServer({
    name: 'workflow-mcp',
    version: '0.1.0',
  });

  const transport = new StdioServerTransport();

  // Track discovered projects
  let discoveredProjects = discoverProjects(cwd);

/**
    * Register resources for all discovered projects
    */
   async function registerProjectResources() {
     // Register a resource for each discovered project
     for (const project of discoveredProjects) {
       try {
         server.registerResource(
           `project-${project.name}`,
           `project://${project.name}`,
           {
             description: `Project resources for ${project.name}`,
             mimeType: 'application/json'
           },
           async () => {
             return {
               contents: [{
                 uri: `project://${project.name}`,
                 mimeType: 'application/json',
                 text: JSON.stringify(project, null, 2)
               }]
             };
           }
         );
       } catch (err) {
         console.error(`Failed to register resource for project ${project.name}:`, err.message);
       }

       // Register subscribable pipeline log latest resource
       try {
         server.registerResource(
           `project-${project.name}-pipeline-log-latest`,
           `workflow://${project.name}/logs/pipeline/latest`,
           {
             description: `Latest pipeline log for ${project.name} with cursor-based live-tail support`,
             mimeType: 'application/json'
           },
           async (uri) => {
             try {
               const result = await resources.get_workflow_project_pipeline_log_latest(cwd, project.name, uri ? new URL(uri) : null);
               return result?.contents ? result : { contents: [result] };
             } catch (err) {
               return {
                 contents: [{
                   uri: `workflow://${project.name}/logs/pipeline/latest`,
                   mimeType: 'application/json',
                   text: JSON.stringify({ error: err.message }, null, 2)
                 }]
               };
             }
           }
         );
        } catch (err) {
          console.error(`Failed to register pipeline log resource for project ${project.name}:`, err.message);
        }

        // Register static config resources
        try {
          server.registerResource(
            `project-${project.name}-config-pipeline`,
            `workflow://${project.name}/config/pipeline`,
            {
              description: `Pipeline configuration YAML for ${project.name}`,
              mimeType: 'application/yaml'
            },
            async () => {
              try {
                const result = await configResources.get_workflow_project_config_pipeline(cwd, project.name);
                return result?.contents ? result : { contents: [result] };
              } catch (err) {
                return {
                  contents: [{
                    uri: `workflow://${project.name}/config/pipeline`,
                    mimeType: 'application/yaml',
                    text: err.message || 'RESOURCE_NOT_FOUND'
                  }]
                };
              }
            }
          );
        } catch (err) {
          console.error(`Failed to register pipeline config resource for project ${project.name}:`, err.message);
        }

        try {
          server.registerResource(
            `project-${project.name}-config-ticket-movement-rules`,
            `workflow://${project.name}/config/ticket-movement-rules`,
            {
              description: `Ticket movement rules configuration YAML for ${project.name}`,
              mimeType: 'application/yaml'
            },
            async () => {
              try {
                const result = await configResources.get_workflow_project_config_ticket_movement_rules(cwd, project.name);
                return result?.contents ? result : { contents: [result] };
              } catch (err) {
                return {
                  contents: [{
                    uri: `workflow://${project.name}/config/ticket-movement-rules`,
                    mimeType: 'application/yaml',
                    text: err.message || 'RESOURCE_NOT_FOUND'
                  }]
                };
              }
            }
          );
        } catch (err) {
          console.error(`Failed to register ticket movement rules config resource for project ${project.name}:`, err.message);
        }
      }
    }

    /**
     * Register workflow resources (alerts, human-queue, etc.)
     */
  async function registerWorkflowResources() {
    try {
      // Get stateDir config: env override first, then resolver fallback (XDG/LOCALAPPDATA)
      let stateDir;
      if (process.env.WORKFLOW_STATE_DIR) {
        stateDir = {
          dir: process.env.WORKFLOW_STATE_DIR,
          mode: process.env.WORKFLOW_STATE_MODE || 'writable'
        };
      } else {
        stateDir = resolveStateDir(process.cwd());
      }
      ensureStateDir(stateDir);

      // Set notification handler for alerts and human-queue
      const notificationHandler = (uri) => {
        try {
          server.sendResourceUpdated(uri);
        } catch (err) {
          console.error(`Failed to send resource update notification for ${uri}:`, err.message);
        }
      };

      resources.setResourceNotificationHandler(notificationHandler);
      resources.setHumanQueueNotificationHandler(notificationHandler);
      resources.setPipelineStateNotificationHandler(notificationHandler);

      // Wrap a resource-provider result so it always has `contents: [...]` —
      // MCP SDK validates the response shape and rejects bare {uri,mimeType,text}.
      const wrapResource = (result) => {
        if (result && Array.isArray(result.contents)) return result;
        return { contents: [result] };
      };

      // Register subscribable workflow://pipeline-state resource
      try {
        server.registerResource(
          'workflow-pipeline-state',
          'workflow://pipeline-state',
          {
            description: 'Aggregated running pipeline state across all projects',
            mimeType: 'application/json'
          },
          async () => wrapResource(await resources.get_workflow_pipeline_state(cwd))
        );
      } catch (err) {
        console.error('Failed to register workflow://pipeline-state resource:', err.message);
      }

      // Register subscribable workflow://alerts resource
      try {
        server.registerResource(
          'workflow-alerts',
          'workflow://alerts',
          {
            description: 'Current list of active alerts from health monitoring',
            mimeType: 'application/json'
          },
          async () => wrapResource(await resources.get_workflow_alerts(stateDir))
        );
      } catch (err) {
        console.error('Failed to register workflow://alerts resource:', err.message);
      }

      // Register workflow://alerts/history resource
      try {
        server.registerResource(
          'workflow-alerts-history',
          'workflow://alerts/history',
          {
            description: 'Historical alerts from alerts-history.jsonl with optional since parameter',
            mimeType: 'application/json'
          },
          async (uri) => {
            const url = new URL(uri, 'workflow://base');
            const since = url.searchParams.get('since');
            return wrapResource(await resources.get_workflow_alerts_history(stateDir, since));
          }
        );
      } catch (err) {
        console.error('Failed to register workflow://alerts/history resource:', err.message);
      }

      // Register subscribable workflow://human-queue resource
      try {
        server.registerResource(
          'workflow-human-queue',
          'workflow://human-queue',
          {
            description: 'Aggregated human tickets across all projects',
            mimeType: 'application/json'
          },
          async () => wrapResource(await resources.get_workflow_human_queue(cwd))
        );
      } catch (err) {
        console.error('Failed to register workflow://human-queue resource:', err.message);
      }
    } catch (err) {
      console.error('Failed to register workflow resources:', err.message);
    }
  }

  /**
   * Register tools from src/tools/
   */
  async function registerTools() {
    const tools = await loadTools();
    for (const tool of tools) {
      if (tool.name && tool.description && typeof tool.execute === 'function') {
        try {
          const inputSchema = tool.inputSchema || {};
          server.registerTool(
            tool.name,
            {
              description: tool.description,
              inputSchema: inputSchema
            },
            async (args) => {
              try {
                const result = await tool.execute(args);
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(result, null, 2)
                    }
                  ]
                };
              } catch (err) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Error executing tool ${tool.name}: ${err.message}`
                    }
                  ],
                  isError: true,
                };
              }
            }
          );
        } catch (err) {
          console.error(`Failed to register tool ${tool.name}:`, err.message);
        }
      }
    }
  }

    // Register tools BEFORE connecting (tools must be registered before server starts).
    // registerTools() now auto-discovers all named/default/array exports from src/tools/*,
    // so manual registration of start_pipeline/get_pipeline_log/list_running_pipelines/
    // list_ghost_executions has been removed to prevent duplicate-name errors.
    await registerTools();

   // Register initial projects and workflow resources
   await registerProjectResources();
  await registerWorkflowResources();

  // Connect and start transport BEFORE starting watchers
  await server.connect(transport);

  // Pipeline log watchers map
  const pipelineLogWatchers = new Map();

  // Start watching for project changes (after connection is established)
  const stopWatcher = watchProjects(cwd, async (change) => {
    discoveredProjects = discoverProjects(cwd);
    await registerProjectResources();
    server.sendResourceListChanged();
    console.error(`[discovery] projects changed: +${change.added.length} -${change.removed.length}`);

    // Update human-queue watcher with new projects
    if (humanQueueWatcher) {
      humanQueueWatcher.stop();
      humanQueueWatcher = createHumanQueueWatcher({ projects: discoveredProjects, debounceMs: 2000 });
      humanQueueWatcher.start();
    }

    // Update pipeline-state watchers: start for new projects, stop for removed
    for (const proj of change.added) {
      resources.startProjectWatchers(proj.path, proj.name, cwd);
    }
    for (const proj of change.removed) {
      resources.stopProjectWatchers(proj.name);
    }

    // Clean up old pipeline log watchers
    for (const [projectName, watcher] of pipelineLogWatchers) {
      if (!discoveredProjects.find(p => p.name === projectName)) {
        try { resources.stop_pipeline_log_watch(projectName); } catch (e) { }
        pipelineLogWatchers.delete(projectName);
      }
    }
  });

  // Start pipeline log watchers for each project
  const notificationHandler = (uri) => {
    try {
      server.sendResourceUpdated(uri);
    } catch (err) {
      console.error(`Failed to send resource update notification:`, err.message);
    }
  };

  for (const project of discoveredProjects) {
    try {
      await resources.start_pipeline_log_watch(cwd, project.name, notificationHandler);
      pipelineLogWatchers.set(project.name, true);
    } catch (err) {
      console.error(`Failed to start pipeline log watch for ${project.name}:`, err.message);
    }
  }

  // Create and start human-queue watcher
  let humanQueueWatcher = createHumanQueueWatcher({
    projects: discoveredProjects,
    debounceMs: 2000
  });
  humanQueueWatcher.start();

  // Create and start health watcher
  const healthWatcher = createHealthWatcher();
  healthWatcher.start();

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error('[shutdown] stopping server...');
    if (humanQueueWatcher) {
      humanQueueWatcher.stop();
    }
    healthWatcher.stop();
    // Stop pipeline log watchers
    for (const projectName of pipelineLogWatchers.keys()) {
      try {
        await resources.stop_pipeline_log_watch(projectName);
      } catch (e) {
        // Ignore
      }
    }
    stopWatcher();
    try {
      await server.close();
    } catch (err) {
      console.error('[shutdown] error closing server:', err.message);
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Handle stdin close (when parent process closes stdio)
  process.stdin.on('end', shutdown);

  console.error('[server] workflow-mcp server started, listening on stdio');
}

// Run server
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
