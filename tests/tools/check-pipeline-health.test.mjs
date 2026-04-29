/**
 * Tests for check_pipeline_health MCP tool
 * Tests the on-demand snapshot of pipeline health status
 */

import { strict as assert } from 'assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import checkPipelineHealthTool from '../../src/tools/pipeline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create a temporary project with pipeline structure
 * @param {Object} options
 * @returns {string} Path to temp project
 */
function createTempProject(options = {}) {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'test-project-'));

  // Create workflow structure
  const workflowDir = join(tempDir, '.workflow');
  const logsDir = join(workflowDir, 'logs');
  mkdirSync(logsDir, { recursive: true });

  // Create .runner-pids if needed
  if (options.pids) {
    const pidsContent = options.pids.map(pid => pid.toString()).join('\n');
    writeFileSync(join(logsDir, '.runner-pids'), pidsContent);
  }

  // Create pipeline log if needed
  if (options.log) {
    const logName = options.logName || `pipeline_2026-04-26_10-00-00.log`;
    writeFileSync(join(logsDir, logName), options.log);
  }

  return tempDir;
}

/**
 * Create a simple healthy pipeline log
 */
function createHealthyLog() {
  return `2026-04-26T10:00:00Z [STAGE_START] stage=prepare step=1 duration=0
2026-04-26T10:00:02Z [STAGE_COMPLETE] stage=prepare step=1 duration=2
2026-04-26T10:00:02Z [STAGE_START] stage=build step=2 duration=0`;
}

/**
 * Create a log with a stuck stage (no completion, old timestamp)
 */
function createStuckLog() {
  return `2026-04-26T10:00:00Z [STAGE_START] stage=prepare step=1 duration=0
2026-04-26T10:00:02Z [STAGE_COMPLETE] stage=prepare step=1 duration=2
2026-04-26T10:00:02Z [STAGE_START] stage=test step=2 duration=0
2026-04-26T10:30:00Z [LOG_LINE] running test...`;
}

/**
 * Test 1: Healthy project (no alerts)
 */
export async function test_healthy_project_returns_empty_alerts() {
  const projectPath = createTempProject({
    pids: [99999],
    log: createHealthyLog()
  });

  try {
    // Set environment to point to our test project
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result = await checkPipelineHealthTool.execute({});

    assert(result.running !== undefined, 'running should be defined');
    assert(Array.isArray(result.alerts), 'alerts should be an array');
    assert.equal(result.alerts.length, 0, 'healthy project should have no alerts');

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Test 2: Invalid project returns error
 */
export async function test_invalid_project_returns_error() {
  const projectPath = createTempProject({
    pids: [99999],
    log: createHealthyLog()
  });

  try {
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result = await checkPipelineHealthTool.execute({ project: 'nonexistent' });

    assert(result.error === 'INVALID_PROJECT', 'should return INVALID_PROJECT error');
    assert(result.message !== undefined, 'should include error message');

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Test 3: Running pipeline returns correct structure
 */
export async function test_running_pipeline_structure() {
  const projectPath = createTempProject({
    pids: [99999],
    log: createHealthyLog()
  });

  try {
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result = await checkPipelineHealthTool.execute({});

    assert(result.running !== undefined, 'should have running field');
    assert(Array.isArray(result.running), 'running should be array');

    // If there are running pipelines, check structure
    if (result.running.length > 0) {
      const running = result.running[0];
      assert(running.project !== undefined, 'running.project should be defined');
      assert(running.run_id !== undefined, 'running.run_id should be defined');
      assert(running.current_stage !== undefined, 'running.current_stage should be defined');
      assert(running.step_number !== undefined, 'running.step_number should be defined');
      assert(running.started_at !== undefined, 'running.started_at should be defined');
      assert(running.last_log_at !== undefined, 'running.last_log_at should be defined');
    }

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Test 4: Multiple calls return consistent results
 */
export async function test_consistency_multiple_calls() {
  const projectPath = createTempProject({
    pids: [99999],
    log: createHealthyLog()
  });

  try {
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result1 = await checkPipelineHealthTool.execute({});
    const result2 = await checkPipelineHealthTool.execute({});

    assert.deepEqual(result1, result2, 'multiple calls without changes should return identical results');

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Test 5: Empty project (no pids, no logs) returns empty arrays
 */
export async function test_empty_project_returns_empty_arrays() {
  const projectPath = createTempProject({});

  try {
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result = await checkPipelineHealthTool.execute({});

    assert.equal(result.running.length, 0, 'should have no running pipelines');
    assert.equal(result.alerts.length, 0, 'should have no alerts');

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Test 6: Log with stuck stage (for detector integration)
 * Note: Currently alerts are empty, but this test prepares for
 * when detectStuck is integrated into getCurrentAlerts
 */
export async function test_stuck_stage_log_structure() {
  const projectPath = createTempProject({
    pids: [99999],
    log: createStuckLog(),
    logName: 'pipeline_2026-04-26_10-00-00.log'
  });

  try {
    const oldCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = dirname(projectPath);

    const result = await checkPipelineHealthTool.execute({});

    assert(result.running !== undefined, 'should have running field');
    assert(Array.isArray(result.alerts), 'alerts should be an array');

    // Currently alerts are empty (detector integration pending)
    // When detectStuck is integrated, this should contain stuck alert
    // Expected future structure:
    // {
    //   type: 'stuck',
    //   project: <projectName>,
    //   severity: 'critical',
    //   stage: 'test',
    //   message: <message with duration>
    // }

    process.env.MCP_CWD = oldCwd;
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/**
 * Run all tests
 */
export async function runAllTests() {
  const tests = [
    { name: 'healthy_project_returns_empty_alerts', fn: test_healthy_project_returns_empty_alerts },
    { name: 'invalid_project_returns_error', fn: test_invalid_project_returns_error },
    { name: 'running_pipeline_structure', fn: test_running_pipeline_structure },
    { name: 'consistency_multiple_calls', fn: test_consistency_multiple_calls },
    { name: 'empty_project_returns_empty_arrays', fn: test_empty_project_returns_empty_arrays },
    { name: 'stuck_stage_log_structure', fn: test_stuck_stage_log_structure }
  ];

  const results = {
    passed: 0,
    failed: 0,
    errors: []
  };

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✓ test_${test.name}`);
      results.passed++;
    } catch (error) {
      console.error(`✗ test_${test.name}: ${error.message}`);
      results.failed++;
      results.errors.push({
        test: test.name,
        error: error.message
      });
    }
  }

  return results;
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runAllTests();
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed > 0 ? 1 : 0);
}
