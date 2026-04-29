import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';


/**
 * Read and parse .workflow-mcp.yaml configuration file
 * @param {string} cwd
 * @returns {Object} Parsed config or empty object
 */
export function readConfig(cwd) {
  const configPath = path.join(cwd, '.workflow-mcp.yaml');
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return yaml.load(content) || {};
    }
  } catch (err) {
    // If config can't be read or parsed, treat as empty config
  }
  return {};
}

/**
 * Get whitelist and blacklist from config
 * @param {Object} config
 * @returns {{whitelist: string[], blacklist: string[]}}
 */
function getLists(config) {
  const projectsCfg = config.projects || {};
  return {
    whitelist: Array.isArray(projectsCfg.whitelist) ? projectsCfg.whitelist : [],
    blacklist: Array.isArray(projectsCfg.blacklist) ? projectsCfg.blacklist : [],
  };
}

/**
 * Read discovery config (debounce_sec, depth)
 * @param {Object} config
 * @returns {{debounce_sec: number, depth: number}}
 */
function getDiscoveryConfig(config) {
  const discoveryCfg = config.discovery || {};
  return {
    debounce_sec: typeof discoveryCfg.debounce_sec === 'number' ? discoveryCfg.debounce_sec : 2,
    depth: typeof discoveryCfg.depth === 'number' ? discoveryCfg.depth : 1,
  };
}

/**
 * Check if a given path is a .workflow directory that's readable
 * @param {string} dirPath
 * @returns {boolean}
 */
function isWorkflowDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Discover projects by scanning cwd for subdirectories containing .workflow/
 * @param {string} cwd - Current working directory
 * @returns {{name: string, path: string}[]} Array of project objects
 */
export function discoverProjects(cwd) {
  const absoluteCwd = path.resolve(cwd);
  const config = readConfig(absoluteCwd);
  const { whitelist, blacklist } = getLists(config);
  const { depth } = getDiscoveryConfig(config);

  // Single-project mode: if cwd itself contains .workflow/
  const selfWorkflow = path.join(absoluteCwd, '.workflow');
  if (isWorkflowDirectory(selfWorkflow)) {
    return [{ name: path.basename(absoluteCwd), path: absoluteCwd }];
  }

  // Scan depth=1: <cwd>/*/ for .workflow/
  // At depth 1 we only look at immediate subdirectories
  let entries = [];
  try {
    entries = fs.readdirSync(absoluteCwd, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (err) {
    // If cwd can't be read, return empty
    return [];
  }

  const projects = [];
  for (const entry of entries) {
    // If depth > 1, we would recurse, but for depth=1 we only use immediate children
    if (depth !== 1) {
      // Recursive scan would go here, but spec says depth=1 default
      // We only implement depth=1 as specified in the plan
    }

    const fullPath = path.join(absoluteCwd, entry);
    const workflowDir = path.join(fullPath, '.workflow');

    if (!isWorkflowDirectory(workflowDir)) {
      continue;
    }

    // Apply whitelist/blacklist filtering
    if (whitelist.length > 0 && !whitelist.includes(entry)) {
      continue;
    }
    if (blacklist.length > 0 && blacklist.includes(entry)) {
      continue;
    }

    projects.push({ name: entry, path: fullPath });
  }

  return projects;
}

/**
 * Watch for project additions/removals in cwd
 * @param {string} cwd - Directory to watch
 * @param {(change: {added: Array<{name: string, path: string}>, removed: Array<{name: string, path: string}>}) => void} onChange - Callback
 * @returns {() => void} - Stop function
 */
export function watchProjects(cwd, onChange) {
  const absoluteCwd = path.resolve(cwd);
  const config = readConfig(absoluteCwd);
  const { debounce_sec } = getDiscoveryConfig(config);

  let timeoutId = null;
  let knownProjects = new Set(discoverProjects(absoluteCwd).map(p => p.name));

  const emitChange = () => {
    const currentProjects = discoverProjects(absoluteCwd);
    const currentNames = new Set(currentProjects.map(p => p.name));

    const added = currentProjects.filter(p => !knownProjects.has(p.name));
    const removed = Array.from(knownProjects)
      .filter(name => !currentNames.has(name))
      .map(name => ({ name, path: path.join(absoluteCwd, name) }));

    if (added.length > 0 || removed.length > 0) {
      onChange({ added, removed });
    }

    knownProjects = currentNames;
  };

  const debouncedEmit = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      emitChange();
      timeoutId = null;
    }, debounce_sec * 1000);
  };

  let watcher;
  try {
    watcher = fs.watch(absoluteCwd, (eventType, filename) => {
      if (filename) {
        // We debounce all changes to handle rapid create/delete pairs
        debouncedEmit();
      }
    });
  } catch (err) {
    // If watch fails (e.g., directory doesn't exist), return a no-op stop function
    return () => {};
  }

  const stop = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    watcher.close();
  };

  return stop;
}
