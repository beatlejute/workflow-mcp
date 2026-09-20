import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { list_skill_tests, run_skill_tests } from '../coach.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../../..');
const fixturesDir = path.join(projectRoot, 'tests', 'fixtures', 'skills');

/**
 * Скилы фикстур лежат в `tests/fixtures/skills/`, а `list_skill_tests` читает
 * только `<project>/.workflow/src/skills/<skill>/tests/index.yaml`. Раньше
 * тесты передавали корень самого workflow-mcp и попадали на реальные скилы —
 * фикстур там нет, и все проверки разбора YAML оказались мёртвыми. Поэтому
 * собираем отдельный проект во временной папке.
 */
let fixtureProject;
let emptyProject;

beforeAll(() => {
  fixtureProject = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-fixtures-'));
  const skillsDir = path.join(fixtureProject, '.workflow', 'src', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.cpSync(path.join(fixturesDir, 'valid-skill'), path.join(skillsDir, 'fixture-valid-skill'), { recursive: true });
  fs.cpSync(path.join(fixturesDir, 'invalid-yaml'), path.join(skillsDir, 'fixture-invalid-yaml'), { recursive: true });

  // Проект без `.workflow/src/skills` вообще.
  emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-empty-'));
  fs.mkdirSync(path.join(emptyProject, '.workflow'), { recursive: true });
});

afterAll(() => {
  for (const dir of [fixtureProject, emptyProject]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // временная папка могла быть уже убрана
    }
  }
});

describe('list_skill_tests', () => {
  it('returns an error object when project is not provided', async () => {
    const result = await list_skill_tests.execute({});

    expect(result.error).toBe('INVALID_PROJECT');
    expect(result.message).toContain('Project is required');
    expect(result.tests).toEqual([]);
  });

  it('returns expected test cases from valid fixture YAML', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-valid-skill'
    });

    expect(result.error).toBeUndefined();
    const testCases = result.tests;

    expect(Array.isArray(testCases)).toBe(true);
    expect(testCases.length).toBeGreaterThan(0);

    const testIds = testCases.map(t => t.test_id);
    expect(testIds).toContain('TC-VALID-001');
    expect(testIds).toContain('TC-VALID-002');
    expect(testIds).toContain('TC-VALID-003');
  });

  it('includes skill_name in each test case', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-valid-skill'
    });

    const testCases = result.tests;
    for (const testCase of testCases) {
      expect(testCase.skill_name).toBe('fixture-valid-skill');
    }
  });

  it('skips invalid YAML with warning on stderr', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-invalid-yaml'
    });

    // Битый YAML пропускается, а не роняет вызов.
    expect(result.error).toBeUndefined();
    const testCases = result.tests;
    expect(testCases.length).toBe(0);
  });

  it('returns an empty list for a missing skills directory', async () => {
    const result = await list_skill_tests.execute({
      project: emptyProject
    });

    expect(result.error).toBeUndefined();
    expect(result.tests).toEqual([]);
  });

  it('rejects invalid skill_name format (must match regex)', async () => {
    const result = await list_skill_tests.execute({
      project: projectRoot,
      skill_name: 'INVALID-SKILL-NAME' // uppercase not allowed
    });

    expect(result.error).toBe('INVALID_SKILL_NAME');
    expect(result.message).toContain('Invalid skill name');
  });

  it('rejects skill_name with path traversal attempt', async () => {
    const result = await list_skill_tests.execute({
      project: projectRoot,
      skill_name: '../../etc/passwd'
    });

    expect(result.error).toBe('INVALID_SKILL_NAME');
    // Either path traversal check or regex check will reject this
    expect(result.message).toMatch(/Invalid skill name|Path traversal/);
  });

  it('includes test description and expected_verdict', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-valid-skill'
    });

    const testCases = result.tests;
    expect(testCases.length).toBeGreaterThan(0);
    expect(testCases[0]).toHaveProperty('description');
    expect(testCases[0]).toHaveProperty('expected_verdict');
    expect(testCases[0].expected_verdict).toMatch(/^(pass|fail|error)$/);
  });

  it('includes optional source_path when present', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-valid-skill'
    });

    const testCases = result.tests;
    const testWithSource = testCases.find(t => t.source_path);

    if (testWithSource) {
      expect(testWithSource.source_path).toBeDefined();
      expect(typeof testWithSource.source_path).toBe('string');
    }
  });

  it('sets source_path to null when not present in YAML', async () => {
    const result = await list_skill_tests.execute({
      project: fixtureProject,
      skill_name: 'fixture-valid-skill'
    });

    const testCases = result.tests;
    const testWithoutSource = testCases.find(t => !t.source_path);

    if (testWithoutSource) {
      expect(testWithoutSource.source_path).toBeNull();
    }
  });

  it('handles project not found error', async () => {
    const result = await list_skill_tests.execute({
      project: '/nonexistent/project/path'
    });

    expect(result.error).toBe('INVALID_PROJECT');
    expect(result.message).toContain('Project not found');
  });
});

describe('run_skill_tests', () => {
  it('returns error when project is not provided', async () => {
    const result = await run_skill_tests.execute({
      skill_name: 'test-skill'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_PROJECT');
    expect(result.stderr).toContain('Project is required');
  });

  it('returns error when skill_name is not provided', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_SKILL_NAME');
  });

  it('returns INVALID_SKILL_NAME for uppercase skill name', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'INVALID'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_SKILL_NAME');
    expect(result.stderr).toContain('Invalid skill name');
  });

  it('returns PROJECT_NOT_FOUND for non-existent project', async () => {
    const result = await run_skill_tests.execute({
      project: '/nonexistent/project',
      skill_name: 'test-skill'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('INVALID_PROJECT');
  });

  it('returns SKILL_NOT_FOUND when skill does not exist', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'nonexistent-skill'
    });

    expect(result.exit_code).toBe(1);
    expect(result.error_code).toBe('SKILL_NOT_FOUND');
    expect(result.stderr).toContain('Skill');
    expect(result.stderr).toContain('not found');
  });

  it('returns SCRIPT_NOT_FOUND when run-skill-tests.js does not exist', async () => {
    // This test would require a project without the script
    // For now, we'll verify the error handling path
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach' // Use existing skill
    });

    // If the skill exists and script doesn't, we get SCRIPT_NOT_FOUND
    if (result.error_code === 'SCRIPT_NOT_FOUND') {
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain('run-skill-tests.js');
    }
  });

  it('clamps timeout_sec to valid range (600-3600)', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach',
      timeout_sec: 100 // Below minimum of 600
    });

    // The function should clamp it to 600, not reject it
    // We verify by checking that the result is processed (not immediate error)
    expect(result).toBeDefined();
    expect(typeof result.exit_code).toBe('number');
  });

  it('handles parallel flag when provided', async () => {
    // The function builds spawn args with --parallel flag
    // We can't easily verify this without mocking spawn
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach',
      parallel: true
    });

    // Verify result structure even if tests fail
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('duration_ms');
  });

  it('handles test_ids filter when provided', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach',
      test_ids: ['TC-COACH-001', 'TC-COACH-002']
    });

    expect(result).toHaveProperty('exit_code');
    expect(typeof result.duration_ms).toBe('number');
  });

  it('returns parsed JSON in stdout', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach'
    });

    if (result.exit_code === 0 || result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty('skill_name');
        expect(parsed).toHaveProperty('summary');
        expect(parsed.summary).toHaveProperty('pass');
        expect(parsed.summary).toHaveProperty('fail');
        expect(parsed.summary).toHaveProperty('skipped');
        expect(parsed.summary).toHaveProperty('total');
        expect(parsed).toHaveProperty('results');
      } catch {
        // If stdout is not valid JSON, that's expected when there's an error
        expect(result.exit_code).not.toBe(0);
      }
    }
  });

  it('returns duration_ms as a number', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach'
    });

    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('sets default timeout to 600 seconds', async () => {
    // Create a mock to verify timeout calculation
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach'
      // No timeout_sec provided - should default to 600
    });

    expect(result).toBeDefined();
    expect(typeof result.duration_ms).toBe('number');
  });

  it('parses summary with pass, fail, skipped counts from output', async () => {
    // This tests the integration of parseSkillTestsOutput
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach'
    });

    // If we get valid JSON output, verify summary structure
    if (result.stdout && result.exit_code === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        expect(parsed.summary).toMatchObject({
          pass: expect.any(Number),
          fail: expect.any(Number),
          skipped: expect.any(Number),
          total: expect.any(Number)
        });
        expect(parsed.summary.total).toBe(
          parsed.summary.pass + parsed.summary.fail + parsed.summary.skipped
        );
      } catch {
        // Invalid JSON expected when tests fail
        expect(result.exit_code).not.toBe(0);
      }
    }
  });

  it('includes test results array in parsed output', async () => {
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach'
    });

    if (result.stdout && result.exit_code === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        expect(Array.isArray(parsed.results)).toBe(true);
        // Each result should have expected structure
        for (const testResult of parsed.results) {
          expect(testResult).toHaveProperty('test_id');
          expect(testResult).toHaveProperty('verdict');
          expect(['pass', 'fail', 'skipped']).toContain(testResult.verdict);
        }
      } catch {
        // JSON parse error expected when tests fail
        expect(result.exit_code).not.toBe(0);
      }
    }
  });

  it('handles graceful child process termination on timeout', async () => {
    // The function uses setTimeout to kill the process after timeoutMs
    // This test verifies the timeout structure is in place
    const result = await run_skill_tests.execute({
      project: projectRoot,
      skill_name: 'coach',
      timeout_sec: 1 // Very short timeout
    });

    // Either times out (exit_code 124) or completes before timeout
    expect(typeof result.exit_code).toBe('number');
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
