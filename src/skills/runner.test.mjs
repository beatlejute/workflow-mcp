import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isValidSkillName,
  hasSkillRunner,
  skillExists,
  parseArtifacts,
  runSkill
} from './runner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Helper: Create temp directory
 */
function createTempDir() {
  const tmpBase = os.tmpdir();
  const randomName = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(tmpBase, `skill-test-${randomName}`);

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  return tmpDir;
}

/**
 * Helper: Cleanup temp directory
 */
function cleanupTempDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Helper: Setup test project structure
 */
function setupTestProject(projectRoot) {
  // Create .workflow/src/scripts directory
  const scriptsDir = path.join(projectRoot, '.workflow', 'src', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Create .workflow/src/skills directory
  const skillsDir = path.join(projectRoot, '.workflow', 'src', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // Copy run-skill.js from project to test project
  const sourceRunSkill = path.join(__dirname, '..', '..', '.workflow', 'src', 'scripts', 'run-skill.js');
  const targetRunSkill = path.join(scriptsDir, 'run-skill.js');
  if (fs.existsSync(sourceRunSkill)) {
    fs.copyFileSync(sourceRunSkill, targetRunSkill);
  }

  return { scriptsDir, skillsDir };
}

/**
 * Helper: Create a test skill
 */
function createTestSkill(projectRoot, skillName, mainContent) {
  const skillDir = path.join(projectRoot, '.workflow', 'src', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });

  const mainPath = path.join(skillDir, 'main.js');
  fs.writeFileSync(mainPath, mainContent);

  return skillDir;
}

describe('isValidSkillName', () => {
  it('should accept valid lowercase names', () => {
    expect(isValidSkillName('test-skill')).toBe(true);
    expect(isValidSkillName('my-skill-123')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('skill')).toBe(true);
  });

  it('should reject uppercase names', () => {
    expect(isValidSkillName('TestSkill')).toBe(false);
    expect(isValidSkillName('SKILL')).toBe(false);
  });

  it('should reject names starting with numbers', () => {
    expect(isValidSkillName('123skill')).toBe(false);
    expect(isValidSkillName('9test')).toBe(false);
  });

  it('should reject names with invalid characters', () => {
    expect(isValidSkillName('test_skill')).toBe(false);
    expect(isValidSkillName('test skill')).toBe(false);
    expect(isValidSkillName('test@skill')).toBe(false);
    expect(isValidSkillName('test/skill')).toBe(false);
  });

  it('should reject names exceeding 51 characters', () => {
    const longName = 'a'.repeat(52);
    expect(isValidSkillName(longName)).toBe(false);

    const maxName = 'a'.repeat(51);
    expect(isValidSkillName(maxName)).toBe(true);
  });
});

describe('hasSkillRunner', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return true when run-skill.js exists', () => {
    setupTestProject(tempDir);
    expect(hasSkillRunner(tempDir)).toBe(true);
  });

  it('should return false when run-skill.js does not exist', () => {
    // Create .workflow/src/scripts but without run-skill.js
    const scriptsDir = path.join(tempDir, '.workflow', 'src', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    expect(hasSkillRunner(tempDir)).toBe(false);
  });

  it('should return false when .workflow directory does not exist', () => {
    expect(hasSkillRunner(tempDir)).toBe(false);
  });
});

describe('skillExists', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
    setupTestProject(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return true when skill directory exists', () => {
    createTestSkill(tempDir, 'test-skill', 'module.exports = () => {};');
    expect(skillExists(tempDir, 'test-skill')).toBe(true);
  });

  it('should return false when skill directory does not exist', () => {
    expect(skillExists(tempDir, 'nonexistent')).toBe(false);
  });

  it('should return false when skills directory does not exist', () => {
    const noSkillsDir = createTempDir();
    const workflowDir = path.join(noSkillsDir, '.workflow');
    fs.mkdirSync(workflowDir, { recursive: true });

    expect(skillExists(noSkillsDir, 'any-skill')).toBe(false);
    cleanupTempDir(noSkillsDir);
  });
});

describe('parseArtifacts', () => {
  it('should parse artifacts from standard marker', () => {
    const stdout = `Some output
---ARTIFACTS---
/path/to/file1.txt
/path/to/file2.json
`;
    const artifacts = parseArtifacts(stdout);
    expect(artifacts).toEqual(['/path/to/file1.txt', '/path/to/file2.json']);
  });

  it('should handle empty artifact list', () => {
    const stdout = `Some output
---ARTIFACTS---
`;
    const artifacts = parseArtifacts(stdout);
    expect(artifacts).toEqual([]);
  });

  it('should return empty array when marker is not present', () => {
    const stdout = 'Just some output without markers';
    const artifacts = parseArtifacts(stdout);
    expect(artifacts).toEqual([]);
  });

  it('should trim whitespace from artifact lines', () => {
    const stdout = `Output
---ARTIFACTS---
  /path/to/file1.txt
/path/to/file2.json

/path/to/file3.md
`;
    const artifacts = parseArtifacts(stdout);
    expect(artifacts).toEqual([
      '/path/to/file1.txt',
      '/path/to/file2.json',
      '/path/to/file3.md'
    ]);
  });

  it('should handle marker in the middle of output', () => {
    const stdout = `Before marker
---ARTIFACTS---
/artifact1.txt
/artifact2.txt
After artifact
`;
    const artifacts = parseArtifacts(stdout);
    expect(artifacts).toEqual(['/artifact1.txt', '/artifact2.txt', 'After artifact']);
  });
});

describe('runSkill', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
    setupTestProject(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return INVALID_SKILL_NAME for invalid skill names', async () => {
    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'Invalid-Skill',
      timeout_sec: 10
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_SKILL_NAME');
    expect(result.stderr).toContain('Invalid skill name');
  });

  it('should return SKILL_RUNNER_UNAVAILABLE when run-skill.js does not exist', async () => {
    // Create a project without run-skill.js
    const noRunnerDir = createTempDir();
    const scriptsDir = path.join(noRunnerDir, '.workflow', 'src', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    createTestSkill(noRunnerDir, 'test-skill', 'module.exports = () => {};');

    const result = await runSkill({
      projectPath: noRunnerDir,
      skillName: 'test-skill',
      timeout_sec: 10
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('SKILL_RUNNER_UNAVAILABLE');
    expect(result.stderr).toContain('run-skill.js');

    cleanupTempDir(noRunnerDir);
  });

  it('should return SKILL_NOT_FOUND when skill does not exist', async () => {
    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'nonexistent-skill',
      timeout_sec: 10
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('SKILL_NOT_FOUND');
    expect(result.stderr).toContain('not found');
  });

  it('should successfully run a valid skill and return exit_code 0', async () => {
    // Create a simple test skill
    const skillContent = `module.exports = function(args, context) {
  console.log('Skill executed successfully');
  return { success: true };
};`;
    createTestSkill(tempDir, 'test-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'test-skill',
      args: { key: 'value' },
      context: { user: 'test' },
      timeout_sec: 30
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Skill executed successfully');
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it('should parse artifacts from skill output', async () => {
    const skillContent = `module.exports = function(args, context) {
  console.log('Running skill');
  console.log('---ARTIFACTS---');
  console.log('/artifact1.txt');
  console.log('/artifact2.json');
  process.exit(0);
};`;
    createTestSkill(tempDir, 'test-artifact-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'test-artifact-skill',
      timeout_sec: 30
    });

    expect(result.exit_code).toBe(0);
    expect(result.artifacts).toEqual(['/artifact1.txt', '/artifact2.json']);
  });

  it('should handle skill failures with non-zero exit code', async () => {
    const skillContent = `module.exports = function(args, context) {
  console.error('Skill failed');
  process.exit(1);
};`;
    createTestSkill(tempDir, 'failing-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'failing-skill',
      timeout_sec: 30
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('SKILL_FAILED');
    expect(result.stderr).toContain('Skill failed');
  });

  it('should timeout when skill runs too long', async () => {
    const skillContent = `module.exports = function(args, context) {
  // Intentionally long-running skill
  const start = Date.now();
  while (Date.now() - start < 5000) {
    // Spin loop
  }
  console.log('Done');
  process.exit(0);
};`;
    createTestSkill(tempDir, 'slow-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'slow-skill',
      timeout_sec: 1 // 1 second timeout
    });

    expect(result.exit_code).toBe(124); // Standard timeout exit code
    expect(result.error_code).toBe('SKILL_TIMEOUT');
    expect(result.duration_ms).toBeGreaterThanOrEqual(1000);
  });

  it('should respect timeout_sec parameter', async () => {
    const skillContent = `module.exports = function(args, context) {
  // Quick skill
  console.log('Quick execution');
  process.exit(0);
};`;
    createTestSkill(tempDir, 'quick-skill', skillContent);

    const start = Date.now();
    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'quick-skill',
      timeout_sec: 30
    });
    const elapsed = Date.now() - start;

    expect(result.exit_code).toBe(0);
    expect(result.duration_ms).toBeLessThan(elapsed + 100); // Allow small overhead
  });

  it('should clamp timeout_sec to maximum of 1800', async () => {
    const skillContent = `module.exports = function(args, context) {
  console.log('Test');
  process.exit(0);
};`;
    createTestSkill(tempDir, 'test-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'test-skill',
      timeout_sec: 5000 // Exceeds max
    });

    // Skill should still succeed with clamped timeout
    expect(result.exit_code).toBe(0);
  });

  it('should pass args and context to skill', async () => {
    const skillContent = `module.exports = function(args, context) {
  if (args.testKey && context.testContext) {
    console.log('Args and context received correctly');
    process.exit(0);
  } else {
    console.error('Args or context missing');
    process.exit(1);
  }
};`;
    createTestSkill(tempDir, 'args-test-skill', skillContent);

    const result = await runSkill({
      projectPath: tempDir,
      skillName: 'args-test-skill',
      args: { testKey: 'testValue' },
      context: { testContext: 'value' },
      timeout_sec: 30
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Args and context received correctly');
  });
});
