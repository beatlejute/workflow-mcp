import { runSkill, isValidSkillName, hasSkillRunner, skillExists } from '../skills/runner.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { findProjectRoot } from '../../../workflowAi/src/lib/find-root.mjs';
import {
  getNextId,
  createTicket
} from '../../../workflowAi/src/lib/operations/tickets.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../../../workflowAi/src/lib/utils.mjs';
import { fileURLToPath } from 'node:url';
import { parseSkillTestsOutput, extractOutputExcerpt } from '../parsers/skill-tests-output.mjs';

/**
 * Resolve project root from project path or name
 * @param {string} project - Project path or name
 * @param {string} cwd - Current working directory
 * @returns {string} Absolute path to project root
 */
function resolveProjectRoot(project, cwd) {
  const resolved = path.resolve(cwd, project);
  const workflowDir = path.join(resolved, '.workflow');
  if (!fs.existsSync(workflowDir)) {
    throw new Error(`Project not found or not a workflow project: ${project}`);
  }
  return resolved;
}

/**
 * MCP Tool: run_skill
 *
 * Runs a skill in a project via the project's skill runner script.
 *
 * Error codes:
 * - INVALID_PROJECT: Project not found
 * - INVALID_SKILL_NAME: skill_name fails regex validation
 * - SKILL_RUNNER_UNAVAILABLE: run-skill.js script not found
 * - SKILL_NOT_FOUND: skill directory does not exist
 * - SKILL_TIMEOUT: execution exceeded timeout_sec
 * - SKILL_FAILED: skill exited non-zero
 */
export const run_skill = {
  name: 'run_skill',
  description: 'Run a skill in a project via the project\'s skill runner script',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    skill_name: z.string().describe('Name of the skill to run (lowercase, alphanumeric and hyphens only)'),
    args: z.record(z.string(), z.any()).optional().describe('Optional arguments to pass to the skill'),
    context: z.record(z.string(), z.any()).optional().describe('Optional context object for the skill'),
    timeout_sec: z.number().min(1).max(1800).optional().describe('Timeout in seconds (default 300, max 1800)')
  }),
  async execute(args) {
    const cwd = process.env.MCP_CWD || process.cwd();

    // Validate required parameters
    if (!args.project) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'Project is required',
        duration_ms: 0,
        error_code: 'INVALID_PROJECT'
      };
    }

    if (!args.skill_name) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'skill_name is required',
        duration_ms: 0,
        error_code: 'INVALID_SKILL_NAME'
      };
    }

    // Validate skill_name format
    if (!isValidSkillName(args.skill_name)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Invalid skill name: ${args.skill_name}. Must match pattern ^[a-z][a-z0-9-]{0,50}$`,
        duration_ms: 0,
        error_code: 'INVALID_SKILL_NAME'
      };
    }

    // Resolve project path
    let projectPath;
    try {
      projectPath = resolveProjectRoot(args.project, cwd);
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: err.message,
        duration_ms: 0,
        error_code: 'PROJECT_NOT_FOUND'
      };
    }

    // Validate timeout_sec
    const timeoutSec = args.timeout_sec !== undefined ? Math.min(1800, Math.max(1, args.timeout_sec)) : undefined;

    // Run the skill
    try {
      const result = await runSkill({
        projectPath,
        skillName: args.skill_name,
        args: args.args || {},
        context: args.context || {},
        timeout_sec: timeoutSec
      });

      // Map internal error codes to public interface
      const response = {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms
      };

      if (result.artifacts) {
        response.artifacts = result.artifacts;
      }

      if (result.error_code) {
        response.error_code = result.error_code;
      }

      return response;
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Unexpected error running skill: ${err.message}`,
        duration_ms: 0,
        error_code: 'UNEXPECTED_ERROR'
      };
    }
  }
};

/**
 * MCP Tool: list_skill_tests
 *
 * Reads <project>/.workflow/src/skills/<name>/tests/index.yaml and returns list of test cases.
 * If skill_name is not specified, returns all test cases from all skills in the project.
 * When index.yaml is missing for a skill, skips with a warning (not an error).
 * Uses Zod for YAML schema validation - invalid yaml is skipped with warning to stderr.
 * Path traversal protection for skill_name.
 */
export const list_skill_tests = {
  name: 'list_skill_tests',
  description: 'List test cases from skill test index.yaml files',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    skill_name: z.string().optional().describe('Optional skill name (lowercase, alphanumeric and hyphens only). If omitted, lists tests for all skills.')
  }),
  async execute(args) {
    const cwd = process.env.MCP_CWD || process.cwd();

    if (!args.project) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'Project is required',
        duration_ms: 0
      };
    }

    let projectPath;
    try {
      projectPath = resolveProjectRoot(args.project, cwd);
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: err.message,
        duration_ms: 0
      };
    }

    // Validate skill_name format if provided
    if (args.skill_name && !isValidSkillName(args.skill_name)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Invalid skill name: ${args.skill_name}. Must match pattern ^[a-z][a-z0-9-]{0,50}$`,
        duration_ms: 0
      };
    }

    // Path traversal protection
    if (args.skill_name && (args.skill_name.includes('..') || args.skill_name.includes('/') || args.skill_name.includes('\\'))) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Invalid skill name: ${args.skill_name}. Path traversal not allowed.`,
        duration_ms: 0
      };
    }

    const skillsDir = path.join(projectPath, '.workflow', 'src', 'skills');

    // Check if skills directory exists
    if (!fs.existsSync(skillsDir)) {
      return {
        exit_code: 0,
        stdout: JSON.stringify([]),
        stderr: '',
        duration_ms: 0
      };
    }

    // Dynamic import for zod
    let zod;
    try {
      zod = await import('zod');
    } catch (err) {
      return {
        exit_code: 1,
        stdout: JSON.stringify([]),
        stderr: `Zod dependency not available: ${err.message}\n`,
        duration_ms: 0
      };
    }

    // Define Zod schema for test cases
    const TestCaseSchema = zod.z.object({
      test_id: zod.z.string(),
      description: zod.z.string(),
      expected_verdict: zod.z.enum(['pass', 'fail', 'error']).or(zod.z.string()),
      source_path: zod.z.string().optional()
    });

    const TestIndexSchema = zod.z.object({
      tests: zod.z.array(TestCaseSchema)
    });

    const skillNames = args.skill_name ? [args.skill_name] : fs.readdirSync(skillsDir).filter((entry) => {
      const entryPath = path.join(skillsDir, entry);
      return fs.statSync(entryPath).isDirectory();
    });

    const allTestCases = [];
    const warnings = [];

    for (const skillName of skillNames) {
      const testIndexPath = path.join(skillsDir, skillName, 'tests', 'index.yaml');

      if (!fs.existsSync(testIndexPath)) {
        warnings.push(`Warning: No index.yaml found for skill '${skillName}', skipping.`);
        continue;
      }

      try {
        // Read YAML file
        const yamlContent = fs.readFileSync(testIndexPath, 'utf-8');
        
        // Parse YAML
        let parsed;
        try {
          const yaml = await import('js-yaml');
          parsed = yaml.load(yamlContent);
        } catch (err) {
          process.stderr.write(`Warning: Invalid YAML in '${testIndexPath}': ${err.message}\n`);
          continue;
        }

        // Validate with Zod
        const validation = TestIndexSchema.safeParse(parsed);
        if (!validation.success) {
          process.stderr.write(`Warning: Invalid schema in '${testIndexPath}': ${JSON.stringify(validation.error.issues)}\n`);
          continue;
        }

        // Add skill_name to each test case
        for (const test of validation.data.tests) {
          allTestCases.push({
            skill_name: skillName,
            test_id: test.test_id,
            description: test.description,
            expected_verdict: test.expected_verdict,
            source_path: test.source_path || null
          });
        }
      } catch (err) {
        process.stderr.write(`Warning: Error reading '${testIndexPath}': ${err.message}\n`);
      }
    }

    return {
      exit_code: 0,
      stdout: JSON.stringify(allTestCases),
      stderr: warnings.join('\n') + (warnings.length > 0 ? '\n' : ''),
      duration_ms: 0
    };
  }
};

/**
 * MCP Tool: run_skill_tests
 *
 * Runs skill tests via run-skill-tests.js script and parses output into JSON.
 *
 * Error codes:
 * - INVALID_PROJECT: Project not found
 * - INVALID_SKILL_NAME: skill_name fails regex validation
 * - SKILL_NOT_FOUND: Skill directory does not exist
 * - SCRIPT_NOT_FOUND: run-skill-tests.js script not found
 * - SKILL_TIMEOUT: execution exceeded timeout
 * - SKILL_FAILED: tests exited with error
 */
export const run_skill_tests = {
  name: 'run_skill_tests',
  description: 'Run skill tests via run-skill-tests.js and return parsed JSON results',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    skill_name: z.string().describe('Name of the skill to test (lowercase, alphanumeric and hyphens only)'),
    test_ids: z.array(z.string()).optional().describe('Optional list of specific test IDs to run'),
    parallel: z.boolean().optional().describe('Run tests in parallel mode (default: false)'),
    timeout_sec: z.number().min(1).max(3600).optional().describe('Timeout in seconds (default 600, max 3600)')
  }),
  async execute(args) {
    const cwd = process.env.MCP_CWD || process.cwd();
    const startTime = Date.now();

    // Validate required parameters
    if (!args.project) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'Project is required',
        error_code: 'INVALID_PROJECT'
      };
    }

    if (!args.skill_name) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'skill_name is required',
        error_code: 'INVALID_SKILL_NAME'
      };
    }

    // Validate skill_name format
    if (!isValidSkillName(args.skill_name)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Invalid skill name: ${args.skill_name}. Must match pattern ^[a-z][a-z0-9-]{0,50}$`,
        error_code: 'INVALID_SKILL_NAME'
      };
    }

    // Resolve project path
    let projectPath;
    try {
      projectPath = resolveProjectRoot(args.project, cwd);
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: err.message,
        error_code: 'INVALID_PROJECT'
      };
    }

    // Check if skill exists
    if (!skillExists(projectPath, args.skill_name)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Skill "${args.skill_name}" not found in project`,
        error_code: 'SKILL_NOT_FOUND'
      };
    }

    // Check if run-skill-tests.js exists
    const scriptPath = path.join(projectPath, '.workflow', 'src', 'scripts', 'run-skill-tests.js');
    if (!fs.existsSync(scriptPath)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `run-skill-tests.js script not found at ${scriptPath}`,
        error_code: 'SCRIPT_NOT_FOUND'
      };
    }

    // Build command arguments
    const spawnArgs = ['--skill', args.skill_name];

    if (args.parallel === true) {
      spawnArgs.push('--parallel');
    }

    if (args.test_ids && Array.isArray(args.test_ids) && args.test_ids.length > 0) {
      // Note: run-skill-tests.js supports --case flag, we'll add tests one by one or as a batch if supported
      for (const testId of args.test_ids) {
        spawnArgs.push('--case', testId);
      }
    }

    // Set timeout (clamp to 600-3600 range)
    const timeoutMs = Math.min(3600, Math.max(600, args.timeout_sec || 600)) * 1000;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timeoutHandle;

      try {
        const proc = spawn('node', [scriptPath, ...spawnArgs], {
          cwd: projectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs
        });

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        // Set up timeout
        timeoutHandle = setTimeout(() => {
          proc.kill();
          const duration = Date.now() - startTime;
          resolve({
            exit_code: 124,
            stdout,
            stderr: stderr + `\nError: Tests exceeded timeout of ${timeoutMs}ms`,
            error_code: 'SKILL_TIMEOUT',
            duration_ms: duration
          });
        }, timeoutMs);

        proc.on('error', (err) => {
          clearTimeout(timeoutHandle);
          const duration = Date.now() - startTime;
          resolve({
            exit_code: 1,
            stdout,
            stderr: err.message,
            error_code: 'SKILL_FAILED',
            duration_ms: duration
          });
        });

        proc.on('close', (code) => {
          clearTimeout(timeoutHandle);
          const duration = Date.now() - startTime;

          // Parse the output
          const parsed = parseSkillTestsOutput(stdout, stderr, args.skill_name);

          // Add output excerpts to each test result
          const allOutput = stdout + '\n' + stderr;
          for (const result of parsed.results) {
            result.output_excerpt = extractOutputExcerpt(allOutput, 50);
          }

          resolve({
            exit_code: code || 0,
            stdout: JSON.stringify(parsed, null, 2),
            stderr: code !== 0 ? stderr : '',
            duration_ms: duration
          });
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;
        resolve({
          exit_code: 1,
          stdout: '',
          stderr: err.message,
          error_code: 'UNEXPECTED_ERROR',
          duration_ms: duration
        });
      }
    });
  }
};

/**
 * MCP Tool: create_coach_ticket
 *
 * Creates a coach-gap ticket in the project backlog via operations API.
 * Target skill must be a valid existing skill in the project.
 *
 * Error codes:
 * - PROJECT_NOT_FOUND: Project not found or not a workflow project
 * - SKILL_NOT_FOUND: Target skill does not exist in the project
 * - INVALID_PARAMETERS: Required parameters missing or gap_description too short
 */
export const create_coach_ticket = {
  name: 'create_coach_ticket',
  description: 'Create a coach-gap ticket in project backlog via operations API',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    target_skill: z.string().describe('Name of the target skill that has a gap (must exist in project)'),
    gap_description: z.string().describe('Description of the gap (minimum 20 characters)'),
    evidence_path: z.string().optional().describe('Optional path to evidence file'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority of the ticket')
  }),
  async execute(args) {
    const cwd = process.env.MCP_CWD || process.cwd();

    // Validate required parameters
    if (!args.project) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'Project is required',
        duration_ms: 0,
        error_code: 'INVALID_PARAMETERS'
      };
    }

    if (!args.target_skill) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'target_skill is required',
        duration_ms: 0,
        error_code: 'INVALID_PARAMETERS'
      };
    }

    if (!args.gap_description) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: 'gap_description is required',
        duration_ms: 0,
        error_code: 'INVALID_PARAMETERS'
      };
    }

    if (args.gap_description.length < 20) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `gap_description must be at least 20 characters (got ${args.gap_description.length})`,
        duration_ms: 0,
        error_code: 'INVALID_PARAMETERS'
      };
    }

    // Validate target_skill is a valid skill name
    if (!isValidSkillName(args.target_skill)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Invalid target_skill name: ${args.target_skill}. Must match pattern ^[a-z][a-z0-9-]{0,50}$`,
        duration_ms: 0,
        error_code: 'INVALID_PARAMETERS'
      };
    }

    // Resolve project path
    let projectRoot;
    try {
      projectRoot = resolveProjectRoot(args.project, cwd);
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: err.message,
        duration_ms: 0,
        error_code: 'PROJECT_NOT_FOUND'
      };
    }

    // Check that target_skill exists in the project
    if (!skillExists(projectRoot, args.target_skill)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Skill "${args.target_skill}" not found in project`,
        duration_ms: 0,
        error_code: 'SKILL_NOT_FOUND'
      };
    }

    // Set priority mapping (string to number)
    const priorityMap = { low: 4, medium: 3, high: 2 };
    const priorityNum = priorityMap[args.priority || 'medium'] || 3;

    // Prepare ticket data
    const tags = ['coach-gap', `target_skill:${args.target_skill}`];

    const data = {
      type: 'COACH',
      title: `Coach gap: ${args.target_skill} - ${args.gap_description.substring(0, 60)}${args.gap_description.length > 60 ? '...' : ''}`,
      priority: priorityNum,
      tags,
      context: {
        files: args.evidence_path ? [args.evidence_path] : [],
        references: [],
        notes: `Coach gap identified for skill: ${args.target_skill}`
      }
    };

    if (args.evidence_path) {
      data.context.notes += `\nEvidence: ${args.evidence_path}`;
    }

    // Create ticket via operations API
    let result;
    try {
      result = await createTicket(projectRoot, data);
    } catch (err) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Failed to create ticket: ${err.message}`,
        duration_ms: 0,
        error_code: 'UNKNOWN_ERROR'
      };
    }

    // Update the ticket frontmatter to ensure tags are properly set
    try {
      const content = fs.readFileSync(result.path, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      frontmatter.tags = tags;
      const newContent = serializeFrontmatter(frontmatter) + body;
      fs.writeFileSync(result.path, newContent, 'utf-8');
    } catch (err) {
      // Non-fatal - just log it
      console.warn(`Warning: Could not update ticket tags: ${err.message}`);
    }

    return {
      exit_code: 0,
      stdout: JSON.stringify({
        ticket_id: result.id,
        path: result.path,
        target_skill: args.target_skill
      }, null, 2),
      stderr: '',
      duration_ms: 0
    };
  }
};

// Default export for auto-loading via loadTools()
const tools = [run_skill, list_skill_tests, run_skill_tests, create_coach_ticket];

export const loadTools = () => {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: tool.execute
  }));
};

export default {
  loadTools
};
