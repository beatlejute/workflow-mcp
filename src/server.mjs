#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { discoverProjects, watchProjects } from './discovery.mjs';
import * as resources from './resources/index.mjs';
import * as configResources from './resources/config.mjs';
import { createHumanQueueWatcher } from './watchers/human-queue-watcher.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { serverStateDir } from './paths/state-dir.mjs';
import { workflowAiPath, workflowAiPackageJson } from './lib/workflow-ai.mjs';
import { mcpCwd } from './lib/project-root.mjs';
import { createHealthService } from './health/service.mjs';

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
  const failed = [];

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
          failed.push(`${file}: ${err.message}`);
          console.error(`Failed to load tool ${file}:`, err.message);
        }
      }
    }
  } catch (err) {
    // If tools directory doesn't exist or can't be read, just return empty array
  }

  // Молча отдавать урезанный набор нельзя: клиент не отличит «tool не
  // существует» от «файл не загрузился». Так себя ведёт, например, слишком
  // старый workflow-ai, у которого в `exports` нет нужных подпутей.
  if (failed.length > 0) {
    console.error(
      `[workflow-mcp] WARNING: ${failed.length} tool file(s) failed to load, the tool list is incomplete:\n  ${failed.join('\n  ')}`
    );
  }

  return tools;
}

/**
 * Main server initialization and startup
 */
async function main() {
  // Startup guard: verify workflow-ai version compatibility
  let actualVersion;
  try {
    actualVersion = workflowAiPackageJson().version;
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

  // `file:`, `link:`, `workspace:` и git-URL — не semver-диапазоны: версию
  // задаёт то, что реально лежит в node_modules, сверять не с чем.
  // `semver.minVersion` на таком спецификаторе бросает «Invalid comparator» и
  // роняет сервер на старте.
  if (!semver.validRange(expectedRange)) {
    console.error(`[workflow-mcp] workflow-ai pinned to a non-semver specifier (${expectedRange}); installed ${actualVersion}, version check skipped`);
  } else if (!semver.satisfies(actualVersion, expectedRange)) {
    const expectedMajor = semver.minVersion(expectedRange)?.major;
    const actualMajor = semver.parse(actualVersion)?.major;
    if (expectedMajor != null && actualMajor != null && actualMajor !== expectedMajor) {
      console.error(`[workflow-mcp] FATAL: workflow-ai major version mismatch (expected ${expectedRange}, got ${actualVersion})`);
      process.exit(1);
    }
    console.error(`[workflow-mcp] WARNING: workflow-ai version below expected (expected ${expectedRange}, got ${actualVersion}); continuing startup`);
  }

  // Get cwd from environment or use process.cwd()
  const cwd = mcpCwd();

  // Каталог состояния: там же, где лежит история алертов, которую читает
  // ресурс `workflow://alerts`. На read-only дереве служба здоровья работает
  // без истории — алерты уходят уведомлениями, ресурс остаётся пустым.
  //
  // Каталог не создаётся на старте: его заводит первая запись. Иначе каждый
  // запуск сервера в новой рабочей области оставлял пустой каталог навсегда —
  // на машине их накопилось 15 789 при одном каталоге с историей. Заодно исчезает и
  // причина падения: прежний голый `ensureStateDir` ронял сервер (`ENOTDIR`)
  // на старте, и клиент терял все 38 tools из-за каталога, без которого
  // сервер прекрасно работает. Отказ записи разбирает тот, кто пишет.
  const healthStateDir = serverStateDir(cwd);

  // Версия берётся из package.json, а не из хардкода: три разных номера
  // одного сервера (package.json, CHANGELOG и это место) расходились,
  // и клиент видел 0.1.0 при пакете 1.2.0.
  let serverVersion = '0.0.0';
  try {
    serverVersion = JSON.parse(
      fs.readFileSync(resolve(__dirname, '../package.json'), 'utf8')
    ).version || serverVersion;
  } catch {
    // Версия не критична для работы: сервер поднимется и без неё.
  }

  // Create MCP server
  const server = new McpServer({
    name: 'workflow-mcp',
    version: serverVersion,
  });

  // Подписка на ресурсы. `McpServer` её не реализует вовсе: `resources/subscribe`
  // отвечал «Method not found», хотя `resources_list()` помечает три ресурса как
  // `subscribable`, а сервер поднимает под них наблюдателей за файлами. Клиенту
  // оставалось перечитывать ресурсы вручную.
  const subscribedUris = new Set();
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedUris.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  /**
   * Уведомить клиента об изменении ресурса.
   *
   * Прежний код звал `server.sendResourceUpdated(uri)` — метода с таким именем
   * у `McpServer` нет (он у низкоуровневого `Server`, и принимает объект).
   * Каждое уведомление падало с `server.sendResourceUpdated is not a function`,
   * то есть не уходило ни одно: ни по алертам, ни по состоянию пайплайна, ни
   * по human-очереди, ни по логам.
   */
  const sendResourceUpdated = (uri) => {
    if (!subscribedUris.has(uri)) {
      return;
    }
    // `sendResourceUpdated` асинхронен: без транспорта он отвергает промис
    // (`Not connected`), а синхронный `try/catch` этого не видит — Node падал
    // бы на unhandledRejection. Окно реально: наблюдатели переживают
    // `server.close()` в `shutdown`.
    try {
      const sent = server.server.sendResourceUpdated({ uri });
      if (sent && typeof sent.catch === 'function') {
        sent.catch((err) => {
          console.error(`Failed to send resource update notification for ${uri}:`, err.message);
        });
      }
    } catch (err) {
      console.error(`Failed to send resource update notification for ${uri}:`, err.message);
    }
  };

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
      // Тот же каталог, что у службы здоровья: второй вызов `serverStateDir`
      // мог дать другой ответ (он читает конфиг заново) и увести ресурс
      // алертов от файла, в который пишет publisher.
      const stateDir = healthStateDir;

      // Set notification handler for alerts and human-queue
      const notificationHandler = sendResourceUpdated;

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

      // Шаблоны и SKILL.md числятся в `resources_list()` и описаны в README, но
      // регистрации у них не было вовсе: `resources/list` их не отдавал, и добраться
      // до них клиент не мог. Наборы конечные, поэтому регистрируем поштучно,
      // как и остальные ресурсы выше.
      for (const templateType of ['ticket', 'plan', 'report']) {
        try {
          // Регистрируем только то, что есть в пакете: иначе ресурс виден в списке,
          // а чтение падает внутренней ошибкой вместо «не найден».
          if (!fs.existsSync(workflowAiPath('templates', `${templateType}-template.md`))) {
            continue;
          }
          server.registerResource(
            `workflow-template-${templateType}`,
            `workflow://templates/${templateType}`,
            {
              description: `Global ${templateType} template`,
              mimeType: 'text/markdown'
            },
            async () => wrapResource(await resources.get_workflow_template(templateType))
          );
        } catch (err) {
          console.error(`Failed to register workflow://templates/${templateType} resource:`, err.message);
        }
      }

      try {
        const skillsRoot = workflowAiPath('src', 'skills');
        const skillNames = fs.existsSync(skillsRoot)
          ? fs.readdirSync(skillsRoot, { withFileTypes: true })
              .filter((entry) => entry.isDirectory()
                // `__test-*` — временные скилы прогонов, workflow-ai их тоже отбрасывает.
                && !entry.name.startsWith('__test-')
                && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
              .map((entry) => entry.name)
          : [];
        for (const skillName of skillNames) {
          try {
            // Имя идёт в URI, а SDK ищет ресурс по нормализованной строке `new URL(...)`:
            // сырой пробел или кириллица в имени дали бы ресурс, который виден в списке,
            // но не читается ни по какому написанию.
            server.registerResource(
              `workflow-skill-${skillName}`,
              `workflow://skills/${encodeURIComponent(skillName)}/SKILL.md`,
              {
                description: `Skill definition: ${skillName}`,
                mimeType: 'text/markdown'
              },
              async () => wrapResource(await resources.get_workflow_skill(skillName))
            );
          } catch (err) {
            console.error(`Failed to register workflow://skills/${skillName}/SKILL.md resource:`, err.message);
          }
        }
      } catch (err) {
        console.error('Failed to enumerate workflow-ai skills for resources:', err.message);
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
                      // Tools выставляют `err.code` (INVALID_ARGUMENT, TICKET_NOT_FOUND,
                      // INVALID_TRANSITION и т.д.), но до клиента доезжал один
                      // `message` — различать виды отказа приходилось по тексту.
                      text: err.code
                        ? `Error executing tool ${tool.name} [${err.code}]: ${err.message}`
                        : `Error executing tool ${tool.name}: ${err.message}`
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
  const notificationHandler = sendResourceUpdated;

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

  // Служба здоровья. Раньше на этом месте стоял таймер, который раз в 30
  // секунд печатал «server alive» в stderr, — от настоящих детекторов у него
  // было только имя. Сами детекторы, дедуп и ресурс `workflow://alerts` были
  // написаны, но не связаны ничем, поэтому список алертов всегда был пуст.
  // Список проектов передаётся функцией: discovery пересобирает его на лету.
  let healthService = null;
  try {
    healthService = createHealthService({
      cwd,
      projects: () => discoveredProjects,
      stateDir: healthStateDir,
      onAlert: (alert) => {
        resources.notify_workflow_alerts(alert);
        console.error(`[health] ${alert.severity ?? 'warning'} ${alert.type} in ${alert.project}: ${alert.message ?? ''}`);
      }
    });
    if (!healthService.start()) {
      console.error('[health] detectors disabled by config (health.enabled: false)');
    }
  } catch (err) {
    // Мониторинг — не условие работы сервера: tools и ресурсы должны остаться
    // доступны, даже если служба не поднялась.
    console.error('[health] service failed to start:', err.message);
    healthService = null;
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error('[shutdown] stopping server...');
    if (humanQueueWatcher) {
      humanQueueWatcher.stop();
    }
    if (healthService) {
      healthService.stop();
    }
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
