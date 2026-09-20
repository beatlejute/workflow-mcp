import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStageTimeout, getCounterLimit, getMcpConfig } from '../../src/health/thresholds.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('thresholds.mjs', () => {
  let testDir;
  let projectPath;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join('/tmp', 'thresholds-test-'));
    projectPath = testDir;

    // Create .workflow/config directory
    fs.mkdirSync(path.join(projectPath, '.workflow', 'config'), { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors
    }
  });

  describe('getStageTimeout', () => {
    it('should return correct timeout for existing stage', () => {
      // Create fixture pipeline.yaml with execute-task stage
      const pipelineYaml = `
pipeline:
  stages:
    execute-task:
      timeout: 600
    other-stage:
      timeout: 300
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      const timeout = getStageTimeout(projectPath, 'execute-task');
      expect(timeout).toBe(600);
    });

    it('should throw STAGE_NOT_FOUND for non-existing stage', () => {
      // Create fixture pipeline.yaml without the requested stage
      const pipelineYaml = `
pipeline:
  stages:
    some-stage:
      timeout: 300
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      expect(() => {
        getStageTimeout(projectPath, 'non-existing-stage');
      }).toThrow('STAGE_NOT_FOUND');
    });

    it('should use default timeout (300) if stage has no explicit timeout', () => {
      // Create fixture pipeline.yaml with stage but no timeout
      const pipelineYaml = `
pipeline:
  stages:
    execute-task:
      someProperty: value
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      const timeout = getStageTimeout(projectPath, 'execute-task');
      expect(timeout).toBe(300);
    });

    it('should use cached value when mtime has not changed', () => {
      // Create fixture pipeline.yaml
      const pipelineYaml = `
pipeline:
  stages:
    execute-task:
      timeout: 600
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      // First call
      const timeout1 = getStageTimeout(projectPath, 'execute-task');
      expect(timeout1).toBe(600);

      // Spy on readFileSync to verify cache is used
      const readFileSpy = vi.spyOn(fs, 'readFileSync');

      // Second call (should use cache)
      const timeout2 = getStageTimeout(projectPath, 'execute-task');
      expect(timeout2).toBe(600);

      // readFileSync should NOT be called (cache hit)
      expect(readFileSpy).not.toHaveBeenCalled();

      readFileSpy.mockRestore();
    });

    it('should invalidate cache when mtime changes', () => {
      // Create initial pipeline.yaml
      const pipelineYaml1 = `
pipeline:
  stages:
    execute-task:
      timeout: 600
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml1, 'utf8');

      // First call
      const timeout1 = getStageTimeout(projectPath, 'execute-task');
      expect(timeout1).toBe(600);

      // Wait a bit to ensure mtime changes
      const waitMs = 100;
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        // busy wait to ensure time passes
      }

      // Update file with different timeout
      const pipelineYaml2 = `
pipeline:
  stages:
    execute-task:
      timeout: 900
`;
      fs.writeFileSync(pipelinePath, pipelineYaml2, 'utf8');

      // Second call should read new value
      const timeout2 = getStageTimeout(projectPath, 'execute-task');
      expect(timeout2).toBe(900);
    });
  });

  describe('getCounterLimit', () => {
    it('should return correct limit for existing counter', () => {
      // Create fixture pipeline.yaml with counter
      const pipelineYaml = `
pipeline:
  counters:
    task_attempts:
      limit: 5
    other_counter:
      limit: 10
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      const limit = getCounterLimit(projectPath, 'task_attempts');
      expect(limit).toBe(5);
    });

    it('should return null when counter exists but has no limit', () => {
      // Create fixture pipeline.yaml with counter but no limit
      const pipelineYaml = `
pipeline:
  counters:
    task_attempts:
      someProperty: value
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      const limit = getCounterLimit(projectPath, 'task_attempts');
      expect(limit).toBeNull();
    });

    it('should return null for non-existing counter', () => {
      // Create fixture pipeline.yaml without the requested counter
      const pipelineYaml = `
pipeline:
  counters:
    other_counter:
      limit: 10
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      const limit = getCounterLimit(projectPath, 'task_attempts');
      expect(limit).toBeNull();
    });

    it('should return null when pipeline.yaml does not exist', () => {
      // Do not create pipeline.yaml
      const limit = getCounterLimit(projectPath, 'task_attempts');
      expect(limit).toBeNull();
    });

    it('should use cached value when mtime has not changed', () => {
      // Create fixture pipeline.yaml
      const pipelineYaml = `
pipeline:
  counters:
    task_attempts:
      limit: 5
`;
      const pipelinePath = path.join(projectPath, '.workflow', 'config', 'pipeline.yaml');
      fs.writeFileSync(pipelinePath, pipelineYaml, 'utf8');

      // First call
      const limit1 = getCounterLimit(projectPath, 'task_attempts');
      expect(limit1).toBe(5);

      // Spy on readFileSync to verify cache is used
      const readFileSpy = vi.spyOn(fs, 'readFileSync');

      // Second call (should use cache)
      const limit2 = getCounterLimit(projectPath, 'task_attempts');
      expect(limit2).toBe(5);

      // readFileSync should NOT be called (cache hit)
      expect(readFileSpy).not.toHaveBeenCalled();

      readFileSpy.mockRestore();
    });
  });

  describe('getMcpConfig', () => {
    it('should return all defaults when .workflow-mcp.yaml does not exist', () => {
      // Do not create .workflow-mcp.yaml
      const config = getMcpConfig(projectPath);

      expect(config).toEqual({
        enabled: true,
        tick_interval_sec: 15,
        stuck_headroom_sec: 60,
        blocked_accumulation_threshold: 5,
        ghost_execution_log_marker: '[GHOST-EXECUTION]',
        crash_mtime_freshness_sec: 60,
        dedup_fingerprint_ttl_sec: 3600,
        approval_pending_threshold_sec: 600,
        branch_diverged_max_behind: 10,
        branch_diverged_max_ahead: 30
      });
    });

    it('should return overridden values when .workflow-mcp.yaml exists', () => {
      // Create .workflow-mcp.yaml with custom health config
      const mcpYaml = `
health:
  tick_interval_sec: 30
  stuck_headroom_sec: 120
  blocked_accumulation_threshold: 10
`;
      const mcpConfigPath = path.join(projectPath, '.workflow-mcp.yaml');
      fs.writeFileSync(mcpConfigPath, mcpYaml, 'utf8');

      const config = getMcpConfig(projectPath);

      // Check overridden values
      expect(config.tick_interval_sec).toBe(30);
      expect(config.stuck_headroom_sec).toBe(120);
      expect(config.blocked_accumulation_threshold).toBe(10);

      // Check that defaults are still applied for missing keys
      expect(config.ghost_execution_log_marker).toBe('[GHOST-EXECUTION]');
      expect(config.crash_mtime_freshness_sec).toBe(60);
      expect(config.dedup_fingerprint_ttl_sec).toBe(3600);
    });

    it('should cache config when mtime has not changed', () => {
      // Create .workflow-mcp.yaml
      const mcpYaml = `
health:
  tick_interval_sec: 30
`;
      const mcpConfigPath = path.join(projectPath, '.workflow-mcp.yaml');
      fs.writeFileSync(mcpConfigPath, mcpYaml, 'utf8');

      // First call
      const config1 = getMcpConfig(projectPath);
      expect(config1.tick_interval_sec).toBe(30);

      // Spy on readFileSync to verify cache is used
      const readFileSpy = vi.spyOn(fs, 'readFileSync');

      // Second call (should use cache)
      const config2 = getMcpConfig(projectPath);
      expect(config2.tick_interval_sec).toBe(30);

      // readFileSync should NOT be called (cache hit)
      expect(readFileSpy).not.toHaveBeenCalled();

      readFileSpy.mockRestore();
    });

    it('should invalidate cache when mtime changes', () => {
      // Create initial .workflow-mcp.yaml
      const mcpYaml1 = `
health:
  tick_interval_sec: 30
`;
      const mcpConfigPath = path.join(projectPath, '.workflow-mcp.yaml');
      fs.writeFileSync(mcpConfigPath, mcpYaml1, 'utf8');

      // First call
      const config1 = getMcpConfig(projectPath);
      expect(config1.tick_interval_sec).toBe(30);

      // Wait a bit to ensure mtime changes
      const waitMs = 100;
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        // busy wait to ensure time passes
      }

      // Update file with different config
      const mcpYaml2 = `
health:
  tick_interval_sec: 45
`;
      fs.writeFileSync(mcpConfigPath, mcpYaml2, 'utf8');

      // Second call should read new value
      const config2 = getMcpConfig(projectPath);
      expect(config2.tick_interval_sec).toBe(45);
    });

    it('should return defaults when .workflow-mcp.yaml has no health section', () => {
      // Create .workflow-mcp.yaml without health section
      const mcpYaml = `
someOtherSection:
  foo: bar
`;
      const mcpConfigPath = path.join(projectPath, '.workflow-mcp.yaml');
      fs.writeFileSync(mcpConfigPath, mcpYaml, 'utf8');

      const config = getMcpConfig(projectPath);

      // All values should be defaults
      expect(config).toEqual({
        enabled: true,
        tick_interval_sec: 15,
        stuck_headroom_sec: 60,
        blocked_accumulation_threshold: 5,
        ghost_execution_log_marker: '[GHOST-EXECUTION]',
        crash_mtime_freshness_sec: 60,
        dedup_fingerprint_ttl_sec: 3600,
        approval_pending_threshold_sec: 600,
        branch_diverged_max_behind: 10,
        branch_diverged_max_ahead: 30
      });
    });

    it('should return defaults when .workflow-mcp.yaml has parsing error', () => {
      // Create invalid YAML
      const mcpYaml = `
invalid: [unclosed bracket
`;
      const mcpConfigPath = path.join(projectPath, '.workflow-mcp.yaml');
      fs.writeFileSync(mcpConfigPath, mcpYaml, 'utf8');

      const config = getMcpConfig(projectPath);

      // Should return defaults despite parsing error
      expect(config).toEqual({
        enabled: true,
        tick_interval_sec: 15,
        stuck_headroom_sec: 60,
        blocked_accumulation_threshold: 5,
        ghost_execution_log_marker: '[GHOST-EXECUTION]',
        crash_mtime_freshness_sec: 60,
        dedup_fingerprint_ttl_sec: 3600,
        approval_pending_threshold_sec: 600,
        branch_diverged_max_behind: 10,
        branch_diverged_max_ahead: 30
      });
    });
  });
});
