import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isValidSkillName, skillExists } from './validation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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
  const skillsDir = path.join(projectRoot, '.workflow', 'src', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  return { skillsDir };
}

/**
 * Helper: Create a test skill — skillExists смотрит только на каталог
 */
function createTestSkill(projectRoot, skillName) {
  const skillDir = path.join(projectRoot, '.workflow', 'src', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
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
    createTestSkill(tempDir, 'test-skill');
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
