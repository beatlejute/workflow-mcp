import { z } from 'zod';
import { discoverProjects } from '../discovery.mjs';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * Default glob patterns to exclude from search
 */
const DEFAULT_EXCLUDES = [
  'node_modules/**',
  '.git/**',
  '.workflow/.cache/**'
];

/**
 * Check if ripgrep (rg) is available in PATH
 * @returns {boolean}
 */
function isRipgrepAvailable() {
  const result = spawnSync('rg', ['--version'], { stdio: 'pipe' });
  return result.error === undefined && result.status === 0;
}

/**
 * Build rg command arguments for a single project search
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {string} [params.type='code'] - File type for rg --type
 * @param {number} params.maxResults - Max results per project
 * @returns {string[]} Argument array for spawn
 */
function buildRgArgs({ query, type = 'code', maxResults }) {
  const args = [
    '--json',           // JSONL output
    '--max-count', String(maxResults),
    '--max-columns', '200',  // Reasonable snippet width
    '--type', type,
    '--no-ignore-parent'     // Respect .ignore in subdirs but not parent dirs
  ];

  // Add exclusion globs
  for (const pattern of DEFAULT_EXCLUDES) {
    args.push('--glob', pattern);
  }

  // Query (as literal string, not regex pattern)
  args.push('-F', query);

  return args;
}

/**
 * Parse a single JSONL line from rg --json output
 * @param {string} line - JSON line
 * @returns {Object|null} Parsed match data or null if not a match
 */
function parseRgJsonLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    return null;
  }

  if (obj.type !== 'match') {
    return null;
  }

  const data = obj.data || {};
  const filePath = (data.path && data.path.text) ? data.path.text : '';
  const lineNumber = data.line_number || 0;
  const submatches = data.submatches || [];

  // Get first submatch for snippet boundaries
  // In rg --json: submatch has {match: {text}, start, end} — start/end are on the submatch directly
  const first = submatches[0] || {};
  const matchStart = first.start || 0;
  const matchEnd = first.end || 0;

  // Build snippet: data.lines is {text: "..."}, not an array
  let snippet = (data.lines && data.lines.text) ? data.lines.text : '';
  snippet = snippet.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, ''); // strip ANSI + trailing newline

  return {
    file: filePath,
    line: lineNumber,
    snippet,
    match_start: matchStart,
    match_end: matchEnd
  };
}

/**
 * Execute ripgrep search for a single project with timeout
 * @param {string} projectPath - Path to project root
 * @param {Object} params - Search parameters
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Array<Object>>} Array of match objects
 */
async function searchProject(projectPath, params, timeoutMs) {
  const args = buildRgArgs(params);

  return new Promise((resolve) => {
    const matches = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      resolve(matches);
    }, timeoutMs);

    const proc = spawn('rg', args, {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.setEncoding('utf8');
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      if (timedOut) return;
      buffer += chunk;
      let eol;
      while ((eol = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, eol).trim();
        buffer = buffer.slice(eol + 1);
        if (line) {
          const parsed = parseRgJsonLine(line);
          if (parsed) {
            matches.push(parsed);
          }
        }
      }
    });

    proc.on('close', (code) => {
      if (!timedOut) {
        clearTimeout(timer);
        // Process any remaining buffer
        if (buffer.trim()) {
          const parsed = parseRgJsonLine(buffer.trim());
          if (parsed) matches.push(parsed);
        }
        resolve(matches);
      }
    });

    proc.on('error', () => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve(matches);
      }
    });
  });
}

/**
 * MCP Tool: cross_project_search
 * Search across projects using ripgrep
 */
export const cross_project_search = {
  name: 'cross_project_search',
  description: 'Search code across multiple workflow projects using ripgrep. Returns file, line, and snippet for each match.',

  inputSchema: z.object({
    query: z.string().describe('Search query (required, min 2 characters)'),
    projects: z.array(z.string()).optional().describe('Optional list of project paths to search (default: all discovered projects)'),
    type: z.enum(['code', 'text', 'cpp', 'python', 'javascript', 'json', 'yaml', 'md', 'toml', 'rs', 'go', 'java', 'c', 'h', 'hh', 'hpp', 'hxx', 'rb', 'php', 'cs', 'swift', 'kt', 'kts', 'scala', 'xml', 'html', 'css', 'scss', 'ts', 'tsx', 'jsx', 'vue', 'svelte']).optional().describe('File type filter (rg --type). Default: code'),
    max_results: z.number().min(1).max(1000).optional().describe('Maximum total results across all projects (default: 100)')
  }),

  async execute(args) {
    const cwd = process.env.MCP_CWD || process.cwd();

    // Validate query
    if (!args.query || typeof args.query !== 'string' || args.query.length < 2) {
      return {
        error: 'QUERY_TOO_SHORT',
        message: 'Query must be a string with at least 2 characters'
      };
    }

    // Check ripgrep availability
    if (!isRipgrepAvailable()) {
      return {
        error: 'RIPGREP_UNAVAILABLE',
        message: 'ripgrep (rg) is not installed or not in PATH. Install from https://ripgrep.org or your package manager.'
      };
    }

    // Resolve projects to search
    let projectsToSearch;
    if (args.projects && Array.isArray(args.projects) && args.projects.length > 0) {
      // Resolve project paths relative to cwd or use absolute
      projectsToSearch = args.projects.map(p => {
        const resolved = path.resolve(cwd, p);
        // Validate it's a workflow project
        if (!fs.existsSync(path.join(resolved, '.workflow'))) {
          throw new Error(`Not a workflow project: ${p}`);
        }
        return {
          name: path.basename(resolved),
          path: resolved
        };
      });
    } else {
      // Discover all projects
      const discovered = discoverProjects(cwd);
      if (discovered.length === 0) {
        return {
          results: [],
          projects_searched: 0,
          truncated: false
        };
      }
      projectsToSearch = discovered;
    }

    // Search each project
    const timeoutMs = 30 * 1000; // 30 sec default
    const maxPerProject = Math.ceil((args.max_results || 100) / projectsToSearch.length);
    const allResults = [];

    for (const proj of projectsToSearch) {
      try {
        const projectMatches = await searchProject(proj.path, {
          query: args.query,
          type: args.type || 'code',
          maxResults: maxPerProject
        }, timeoutMs);

        for (const match of projectMatches) {
          allResults.push({
            project: proj.name,
            file: match.file,
            line: match.line,
            snippet: match.snippet,
            match_start: match.match_start,
            match_end: match.match_end
          });

          // Global truncation check
          if (args.max_results && allResults.length >= args.max_results) {
            return {
              results: allResults,
              projects_searched: projectsToSearch.length,
              truncated: true
            };
          }
        }
      } catch (err) {
        // Log but continue with other projects
        console.warn(`Warning: search failed for project ${proj.name}: ${err.message}`);
      }
    }

    return {
      results: allResults,
      projects_searched: projectsToSearch.length,
      truncated: false
    };
  }
};
