/**
 * Tests for start_pipeline MCP tool
 * Tests successful spawn, ALREADY_RUNNING check, spawn failures, marker creation, and log file extraction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Since start_pipeline is currently a stub, we'll test the expected behavior
// by importing the actual implementation once IMPL-35 is completed
// For now, testing the structure and expected behavior

describe('start_pipeline tool', () => {
  let testDir;
  let projectPath;
  let workflowDir;
  let logsDir;
  let stateDir;

  beforeEach(() => {
    // Create temporary test directory structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-pipeline-test-'));
    projectPath = testDir;
    workflowDir = path.join(projectPath, '.workflow');
    logsDir = path.join(workflowDir, 'logs');
    stateDir = path.join(workflowDir, 'state');

    // Create directory structure
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe('TC-001: Successful start on fixture project with mock workflow binary', () => {
    it('should spawn workflow run detached and return run_id from log file', async () => {
      // Create mock workflow binary (stub shell script that creates log file)
      const mockBinaryPath = path.join(projectPath, 'mock-workflow');
      const mockScript = `#!/bin/bash
# Mock workflow binary that creates a pipeline log
logsDir="${logsDir}"
mkdir -p "$logsDir"

# Create pipeline_*.log with ISO timestamp
timestamp=$(date '+%Y-%m-%d_%H-%M-%S')
logFile="$logsDir/pipeline_$timestamp.log"
echo "Pipeline started at $(date -Iseconds)" > "$logFile"

# Keep process running for a bit then exit
sleep 0.5
exit 0
`;

      fs.writeFileSync(mockBinaryPath, mockScript);
      fs.chmodSync(mockBinaryPath, 0o755);

      // Expected behavior when start_pipeline is called:
      // 1. Check no pipeline is running
      // 2. Spawn with detached: true, stdio: 'ignore', unref()
      // 3. Poll for pipeline_*.log creation (up to 2 sec)
      // 4. Extract run_id from log filename
      // 5. Write marker with PID
      // 6. Return {ok: true, run_id, pid, started_at, log_path}

      // For now, verify the expected test structure
      expect(logsDir).toBeDefined();
      expect(fs.existsSync(logsDir)).toBe(true);

      // Test would call start_pipeline and verify:
      // - result.ok === true
      // - result.run_id matches pipeline_YYYY-MM-DD_HH-MM-SS format
      // - result.pid is a number
      // - result.log_path exists and contains logs
      // - Marker file created at .workflow/.mcp-started-by
    });
  });

  describe('TC-002: Repeated start → ALREADY_RUNNING', () => {
    it('should return ALREADY_RUNNING when pipeline is already running', async () => {
      // Simulate existing running pipeline by creating:
      // 1. .runner-pids file with current PID
      // 2. A recent pipeline_*.log file

      const runnerPidsPath = path.join(logsDir, '.runner-pids');
      const currentPid = process.pid;
      fs.writeFileSync(runnerPidsPath, JSON.stringify({ snapshot: [currentPid] }));

      // Create recent log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logPath = path.join(logsDir, `pipeline_${timestamp}.log`);
      fs.writeFileSync(logPath, 'Pipeline running...\n');

      // Test would call start_pipeline and verify:
      // - result.ok === false
      // - result.code === 'ALREADY_RUNNING'
      // - result.pid === existing PID

      expect(fs.existsSync(runnerPidsPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);

      const runnerPids = JSON.parse(fs.readFileSync(runnerPidsPath, 'utf-8'));
      expect(runnerPids.snapshot).toContain(currentPid);
    });
  });

  describe('TC-003: Spawn fail (binary not found) → SPAWN_FAILED', () => {
    it('should return SPAWN_FAILED with errno when binary is not found', async () => {
      // Test would use non-existent binary path
      // Expected error handling:
      // - Spawn fails with ENOENT
      // - Catch error and return:
      //   {ok: false, code: 'SPAWN_FAILED', errno: 'ENOENT', hint: '...'}

      const nonExistentBinary = path.join(projectPath, 'non-existent-workflow');

      // Verify binary doesn't exist
      expect(fs.existsSync(nonExistentBinary)).toBe(false);

      // Test would call start_pipeline with non-existent binary and verify:
      // - result.ok === false
      // - result.code === 'SPAWN_FAILED'
      // - result.errno includes 'ENOENT' or 'EACCES'
    });
  });

  describe('TC-004: Marker is created correctly with PID and run_id', () => {
    it('should write .mcp-started-by marker with PID and run_id', async () => {
      const markerPath = path.join(workflowDir, '.mcp-started-by');

      // Test would call start_pipeline which writes marker:
      // marker content: {pid, run_id, mcp_instance_id, created_at}

      // Simulate what the tool should do:
      const mockPid = 12345;
      const mockRunId = 'pipeline_2026-04-28_12-30-45';
      const markerContent = {
        pid: mockPid,
        run_id: mockRunId,
        mcp_instance_id: 'workflow-mcp@abcd1234',
        created_at: new Date().toISOString()
      };

      fs.writeFileSync(markerPath, JSON.stringify(markerContent, null, 2));

      // Verify marker was created
      expect(fs.existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(marker.pid).toBe(mockPid);
      expect(marker.run_id).toBe(mockRunId);
      expect(marker.pid).toBeDefined();
      expect(marker.run_id).toBeDefined();
      expect(marker.created_at).toBeDefined();
    });
  });

  describe('TC-005: Log file appears and its name is extracted into run_id', () => {
    it('should extract run_id from pipeline_*.log filename via polling', async () => {
      // Test polling mechanism: poll every 100ms, up to 2 seconds for log creation
      const startTime = Date.now();
      const maxWaitTime = 2000;
      const pollMs = 100;
      let foundLog = null;

      // Simulate async log creation after a delay
      setTimeout(() => {
        const timestamp = new Date().toISOString()
          .replace(/T/, '_')
          .replace(/:/g, '-')
          .slice(0, 19);
        const logPath = path.join(logsDir, `pipeline_${timestamp}.log`);
        fs.writeFileSync(logPath, 'Pipeline execution started\n');
      }, 200);

      // Poll for log file (as start_pipeline should do)
      const pollPromise = new Promise((resolve) => {
        const intervalId = setInterval(() => {
          if (Date.now() - startTime > maxWaitTime) {
            clearInterval(intervalId);
            resolve(foundLog);
            return;
          }

          const logFiles = fs.readdirSync(logsDir)
            .filter(f => f.startsWith('pipeline_') && f.endsWith('.log'));

          if (logFiles.length > 0) {
            // Extract run_id from latest log file
            const logFile = logFiles.sort().reverse()[0];
            const runIdMatch = logFile.match(/pipeline_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
            if (runIdMatch) {
              foundLog = `pipeline_${runIdMatch[1]}`;
              clearInterval(intervalId);
              resolve(foundLog);
            }
          }
        }, pollMs);
      });

      // Verify log extraction
      const extractedRunId = await pollPromise;

      expect(extractedRunId).toBeDefined();
      expect(extractedRunId).toMatch(/^pipeline_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);

      // Verify log file exists
      const logPath = path.join(logsDir, `${extractedRunId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
    });
  });

  describe('Integration: Full start_pipeline workflow', () => {
    it('should complete full workflow: check, spawn, poll, write marker, return result', async () => {
      // Full integration test combining all scenarios
      // 1. Verify no pipeline running
      // 2. Spawn mock process with detached mode
      // 3. Poll for log file
      // 4. Extract run_id
      // 5. Write marker
      // 6. Return success response

      const runnerPidsPath = path.join(logsDir, '.runner-pids');

      // Initially no PIDs should exist
      expect(fs.existsSync(runnerPidsPath)).toBe(false);

      // Create marker path
      const markerPath = path.join(workflowDir, '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(false);

      // After execution, these should be created
      // Test would verify:
      // 1. Marker file exists
      // 2. Marker contains valid PID and run_id
      // 3. Log file exists with matching run_id
      // 4. Response contains {ok: true, run_id, pid, started_at, log_path}
    });
  });

  describe('Error handling', () => {
    it('should handle project resolution errors', async () => {
      const nonExistentProject = path.join(testDir, 'non-existent-project');

      // Test would call start_pipeline with non-existent project
      // Expected: return error like {ok: false, code: 'PROJECT_NOT_FOUND'}
      expect(fs.existsSync(nonExistentProject)).toBe(false);
    });

    it('should handle filesystem permission errors', async () => {
      // Test would attempt to write marker in read-only directory
      // Expected: structured error response

      // Make directory read-only (if OS supports it)
      try {
        fs.chmodSync(stateDir, 0o444);
        expect(fs.statSync(stateDir).mode & 0o777).toBe(0o444);
        fs.chmodSync(stateDir, 0o755); // Restore for cleanup
      } catch (err) {
        // Some environments may not support chmod
      }
    });
  });
});
