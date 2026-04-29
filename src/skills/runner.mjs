import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Skill name validation regex: lowercase, start with letter, max 51 chars total
 */
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,50}$/;

/**
 * Check if a skill name is valid
 * @param {string} skillName
 * @returns {boolean}
 */
export function isValidSkillName(skillName) {
  return SKILL_NAME_REGEX.test(skillName);
}

/**
 * Check if the skill runner script exists in the project
 * @param {string} projectPath
 * @returns {boolean}
 */
export function hasSkillRunner(projectPath) {
  const scriptPath = path.join(projectPath, '.workflow', 'src', 'scripts', 'run-skill.js');
  return fs.existsSync(scriptPath);
}

/**
 * Check if a skill exists in the project
 * @param {string} projectPath
 * @param {string} skillName
 * @returns {boolean}
 */
export function skillExists(projectPath, skillName) {
  // Skills can be in .workflow/src/skills/<skillName> or similar locations
  // Standard location: .workflow/src/skills/<skillName>
  const skillDir = path.join(projectPath, '.workflow', 'src', 'skills', skillName);
  return fs.existsSync(skillDir);
}

/**
 * Parse artifacts from stdout
 * Artifacts are between ---ARTIFACTS--- marker and end of output
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseArtifacts(stdout) {
  const marker = '---ARTIFACTS---';
  const idx = stdout.indexOf(marker);
  if (idx === -1) {
    return [];
  }
  // Everything after the marker
  const after = stdout.slice(idx + marker.length).trim();
  if (!after) {
    return [];
  }
  // Each line is an artifact path
  return after.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * Run a skill in a project
 * @param {Object} params
 * @param {string} params.projectPath - Absolute path to project root
 * @param {string} params.skillName
 * @param {Object} [params.args] - Arguments to pass to skill
 * @param {Object} [params.context] - Context object
 * @param {number} [params.timeout_sec] - Timeout in seconds (default 300, max 1800)
 * @returns {Promise<{exit_code: number, stdout: string, stderr: string, duration_ms: number, artifacts?: string[]}>}
 */
export async function runSkill({ projectPath, skillName, args = {}, context = {}, timeout_sec }) {
  // Validate skill name
  if (!isValidSkillName(skillName)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Invalid skill name: ${skillName}. Must match pattern ^[a-z][a-z0-9-]{0,50}$`,
      duration_ms: 0,
      error_code: 'INVALID_SKILL_NAME'
    };
  }

  // Check runner script exists
  if (!hasSkillRunner(projectPath)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Skill runner script not found in project. Expected .workflow/src/scripts/run-skill.js`,
      duration_ms: 0,
      error_code: 'SKILL_RUNNER_UNAVAILABLE'
    };
  }

  // Check skill exists
  if (!skillExists(projectPath, skillName)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Skill "${skillName}" not found in project`,
      duration_ms: 0,
      error_code: 'SKILL_NOT_FOUND'
    };
  }

  // Resolve script path
  const scriptPath = path.join(projectPath, '.workflow', 'src', 'scripts', 'run-skill.js');

  // Prepare arguments as JSON string
  const skillArgs = JSON.stringify(args);
  const skillContext = JSON.stringify(context);

  // Timeout handling
  const timeoutMs = Math.min(1800, timeout_sec || 300) * 1000;

  return new Promise((resolve) => {
    const startTime = Date.now();

    const child = spawn('node', [scriptPath, skillName, skillArgs, skillContext], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // After a grace period, force kill
      setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;

      // If killed by timeout, override exit code
      const exitCode = timedOut ? 124 : (code ?? 1);

      const result = {
        exit_code: exitCode,
        stdout,
        stderr,
        duration_ms: durationMs
      };

      // Parse artifacts if exit code is 0 or if stdout contains marker
      if (stdout.includes('---ARTIFACTS---')) {
        result.artifacts = parseArtifacts(stdout);
      }

      // Add error code for common failure scenarios
      if (timedOut) {
        result.error_code = 'SKILL_TIMEOUT';
      } else if (code !== 0) {
        result.error_code = 'SKILL_FAILED';
      }

      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      resolve({
        exit_code: 1,
        stdout: '',
        stderr: `Failed to spawn skill process: ${err.message}`,
        duration_ms: durationMs,
        error_code: 'SPAWN_FAILED'
      });
    });
  });
}
