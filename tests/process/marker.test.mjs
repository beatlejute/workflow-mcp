import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeMarker, readMarker, validateMarker, removeMarker } from '../../src/process/marker.mjs';
import { mcpInstanceId, legacyMcpInstanceId, acceptedInstanceIds } from '../../src/lib/project-root.mjs';

// Идентификатор берётся у самого кода, а не пересчитывается здесь: копия
// формулы в тесте разошлась с оригиналом, как только тот стал гасить регистр
// пути, и тест ловил расхождение теста с самим собой, а не поломку контракта.
const getMcpInstanceIdForPath = (cwd) => mcpInstanceId(cwd);

// Create a temporary directory for test
function createTempProjectDir() {
  const baseTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'));
  return baseTemp;
}

// Clean up temporary directory
function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

describe('src/process/marker.mjs', () => {
  let projectPath;
  let originalCwd;

  let originalMcpCwd;

  beforeEach(() => {
    projectPath = createTempProjectDir();
    originalCwd = process.cwd();
    // Change to temp directory to control mcp_instance_id
    process.chdir(projectPath);
    // `writeMarker` считает идентификатор от `mcpCwd()`, а `MCP_CWD` старше
    // рабочего каталога процесса: без этой строки набор зависел от того, что
    // стоит в окружении запускающего.
    originalMcpCwd = process.env.MCP_CWD;
    process.env.MCP_CWD = projectPath;
    // Clean up env var
    delete process.env.WORKFLOW_MCP_FORCE_FOREIGN;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalMcpCwd === undefined) delete process.env.MCP_CWD;
    else process.env.MCP_CWD = originalMcpCwd;
    cleanupTempDir(projectPath);
  });

  describe('write/read round-trip', () => {
    it('should write marker and read back with correct data', () => {
      const testPid = 12345;
      const testRunId = 'pipeline_2026-04-27_12-00-00';
      const payload = {
        pid: testPid,
        run_id: testRunId,
      };

      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const marker = readMarker(projectPath);
      expect(marker).not.toBeNull();
      expect(marker.version).toBe(1);
      expect(marker.pid).toBe(testPid);
      expect(marker.run_id).toBe(testRunId);
      expect(marker.mcp_instance_id).toBeDefined();
      expect(marker.started_at).toBeDefined();
      expect(new Date(marker.started_at)).toBeInstanceOf(Date);
    });

    it('should create .workflow/logs directory if it does not exist', () => {
      const payload = { pid: 123, run_id: 'test' };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(true);
    });
  });

  describe('переходная сверка идентификатора', () => {
    it('список принимаемых пропускает маркер прежнего формата', () => {
      // Маркер прогона, запущенного сервером до 2.0.0: идентификатор считался
      // с регистром пути.
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        version: 1,
        mcp_instance_id: legacyMcpInstanceId(projectPath),
        started_at: new Date().toISOString(),
        pid: 4242
      }), 'utf8');

      const validation = validateMarker(projectPath, 4242, acceptedInstanceIds(projectPath));
      expect(validation.valid).toBe(true);
    });

    it('чужой идентификатор не принимается, даже когда сверяют списком', () => {
      // Прежняя переходная ветка сверяла маркер с идентификатором текущего
      // `mcpCwd()` мимо переданного ожидания: на POSIX, где оба правила дают
      // один хеш, проверка принимала любой местный маркер.
      writeMarker(projectPath, { pid: 4242 });

      const validation = validateMarker(projectPath, 4242, ['workflow-mcp@aaaaaaaaaaaa', 'workflow-mcp@bbbbbbbbbbbb']);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('INSTANCE_MISMATCH');
    });

    it('маркер прежнего формата не проходит по чужому списку', () => {
      // Регрессия на дыру 2.0.0: та ветка сверяла маркер с
      // `legacyMcpInstanceId()` от текущего `mcpCwd()` мимо переданного
      // ожидания. Проверка с маркером текущего формата ловит её только на
      // POSIX (там оба ключа равны); здесь маркер прежнего формата и заведомо
      // чужой список — расхождение видно на обеих платформах.
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        version: 1,
        mcp_instance_id: legacyMcpInstanceId(projectPath),
        started_at: new Date().toISOString(),
        pid: 4242
      }), 'utf8');

      const validation = validateMarker(projectPath, 4242, ['workflow-mcp@aaaaaaaaaaaa']);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('INSTANCE_MISMATCH');
    });

    it('список идентификаторов считается от переданного корня', () => {
      const ids = acceptedInstanceIds(projectPath);
      expect(ids[0]).toBe(mcpInstanceId(projectPath));
      if (process.platform === 'win32') {
        // Регистр пути гасится только на Windows, поэтому второй ключ есть
        // лишь там — и только когда путь не в нижнем регистре.
        expect(ids).toContain(legacyMcpInstanceId(projectPath));
      } else {
        expect(ids).toHaveLength(1);
      }
    });
  });

  describe('validateMarker', () => {
    it('should return valid=true for correct PID and instance ID', () => {
      const testPid = 54321;
      const payload = { pid: testPid, run_id: 'test' };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const currentInstanceId = getMcpInstanceIdForPath(projectPath);
      const validation = validateMarker(projectPath, testPid, currentInstanceId);
      expect(validation.valid).toBe(true);
      expect(validation.override).toBeUndefined();
    });

    it('should return valid=false with reason=MISSING when marker file does not exist', () => {
      const validation = validateMarker(projectPath, 123, 'any-id');
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('MISSING');
    });

    it('should return valid=false with reason=PID_MISMATCH when PID does not match', () => {
      const payload = { pid: 111, run_id: 'test' };
      writeMarker(projectPath, payload);

      const currentInstanceId = getMcpInstanceIdForPath(projectPath);
      const validation = validateMarker(projectPath, 999, currentInstanceId);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('PID_MISMATCH');
    });

    it('should return valid=false with reason=INSTANCE_MISMATCH when instance ID does not match', () => {
      const payload = { pid: 123, run_id: 'test' };
      writeMarker(projectPath, payload);

      const wrongInstanceId = 'wrong-id';
      const validation = validateMarker(projectPath, 123, wrongInstanceId);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('INSTANCE_MISMATCH');
    });

    it('should return valid=false with reason=UNSUPPORTED_VERSION for version !== 1', () => {
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const markerData = {
        version: 2,
        mcp_instance_id: 'test',
        pid: 123,
        run_id: 'test',
        started_at: new Date().toISOString(),
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerData), 'utf8');

      const validation = validateMarker(projectPath, 123, 'test');
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('UNSUPPORTED_VERSION');
    });

    it('should return valid=false with reason=PARSE_ERROR for invalid JSON', () => {
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, 'invalid json {]', 'utf8');

      const validation = validateMarker(projectPath, 123, 'test');
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('PARSE_ERROR');
    });
  });

  describe('env override WORKFLOW_MCP_FORCE_FOREIGN=1', () => {
    it('should return valid=true with override=true when WORKFLOW_MCP_FORCE_FOREIGN=1', () => {
      process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';

      // Marker doesn't exist, but with override it should be valid=true
      const validation = validateMarker(projectPath, 999, 'wrong-id');
      expect(validation.valid).toBe(true);
      expect(validation.override).toBe(true);
    });

    it('should ignore marker validation checks when override is set', () => {
      process.env.WORKFLOW_MCP_FORCE_FOREIGN = '1';

      // Even with a bad marker file, override should take precedence
      const payload = { pid: 111, run_id: 'test' };
      writeMarker(projectPath, payload);

      const validation = validateMarker(projectPath, 999, 'completely-wrong');
      expect(validation.valid).toBe(true);
      expect(validation.override).toBe(true);
    });

    it('should not return valid=true when WORKFLOW_MCP_FORCE_FOREIGN is not "1"', () => {
      process.env.WORKFLOW_MCP_FORCE_FOREIGN = 'something-else';

      const validation = validateMarker(projectPath, 999, 'wrong-id');
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('MISSING');
    });
  });

  describe('race condition', () => {
    it('should handle two parallel writeMarker calls — one wins, second fails or overwrites', async () => {
      const payload1 = { pid: 111, run_id: 'run-1' };
      const payload2 = { pid: 222, run_id: 'run-2' };

      // Launch two writes in parallel
      const [result1, result2] = await Promise.all([
        Promise.resolve(writeMarker(projectPath, payload1)),
        Promise.resolve(writeMarker(projectPath, payload2)),
      ]);

      // Both should technically succeed due to temp+rename or O_EXCL fallback,
      // but the final marker should contain one of them
      const finalMarker = readMarker(projectPath);
      expect(finalMarker).not.toBeNull();
      expect([111, 222]).toContain(finalMarker.pid);
      expect([payload1.run_id, payload2.run_id]).toContain(finalMarker.run_id);
    });
  });

  describe('removeMarker idempotency', () => {
    it('should remove marker file successfully', () => {
      const payload = { pid: 123, run_id: 'test' };
      writeMarker(projectPath, payload);

      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(true);

      const removeResult = removeMarker(projectPath);
      expect(removeResult.ok).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('should be idempotent — removing non-existent marker returns ok=true', () => {
      const removeResult1 = removeMarker(projectPath);
      expect(removeResult1.ok).toBe(true);

      // Second remove should also be ok=true (idempotent)
      const removeResult2 = removeMarker(projectPath);
      expect(removeResult2.ok).toBe(true);
    });

    it('should not throw when removing marker multiple times', () => {
      const payload = { pid: 123, run_id: 'test' };
      writeMarker(projectPath, payload);

      const remove1 = removeMarker(projectPath);
      expect(remove1.ok).toBe(true);

      const remove2 = removeMarker(projectPath);
      expect(remove2.ok).toBe(true);

      const remove3 = removeMarker(projectPath);
      expect(remove3.ok).toBe(true);
    });
  });

  describe('unsupported version', () => {
    it('should reject version=2 as UNSUPPORTED_VERSION', () => {
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const markerData = {
        version: 2,
        mcp_instance_id: getMcpInstanceIdForPath(projectPath),
        pid: 123,
        run_id: 'test',
        started_at: new Date().toISOString(),
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerData), 'utf8');

      const validation = validateMarker(projectPath, 123, getMcpInstanceIdForPath(projectPath));
      expect(validation.reason).toBe('UNSUPPORTED_VERSION');
    });

    it('should reject version=null or missing version', () => {
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const markerData = {
        // version intentionally missing
        mcp_instance_id: getMcpInstanceIdForPath(projectPath),
        pid: 123,
        run_id: 'test',
        started_at: new Date().toISOString(),
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerData), 'utf8');

      const validation = validateMarker(projectPath, 123, getMcpInstanceIdForPath(projectPath));
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('UNSUPPORTED_VERSION');
    });

    it('should accept version=1 explicitly', () => {
      const payload = { pid: 123, run_id: 'test' };
      writeMarker(projectPath, payload);

      const marker = readMarker(projectPath);
      expect(marker.version).toBe(1);

      const validation = validateMarker(
        projectPath,
        123,
        getMcpInstanceIdForPath(projectPath)
      );
      expect(validation.valid).toBe(true);
    });
  });

  describe('JSON format and atomicity', () => {
    it('should write valid JSON that can be parsed', () => {
      const payload = { pid: 999, run_id: 'atomic-test' };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      const content = fs.readFileSync(markerPath, 'utf8');
      // Should not throw on parse
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('pid');
    });

    it('should handle special characters in run_id', () => {
      const runId = 'pipeline_2026-04-27_12-00-00.000Z_special-chars_@#$%';
      const payload = { pid: 123, run_id: runId };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const marker = readMarker(projectPath);
      expect(marker.run_id).toBe(runId);
    });
  });

  describe('edge cases', () => {
    it('should handle very large PID numbers', () => {
      const largePid = 2147483647; // Max 32-bit signed int
      const payload = { pid: largePid, run_id: 'large-pid-test' };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const validation = validateMarker(
        projectPath,
        largePid,
        getMcpInstanceIdForPath(projectPath)
      );
      expect(validation.valid).toBe(true);
    });

    it('should handle negative PID (unusual but should store)', () => {
      const negativePid = -999;
      const payload = { pid: negativePid, run_id: 'negative-pid' };
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      const marker = readMarker(projectPath);
      expect(marker.pid).toBe(negativePid);
    });

    it('should preserve timestamps in ISO format', () => {
      const payload = { pid: 123, run_id: 'test' };
      const beforeWrite = new Date();
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);
      const afterWrite = new Date();

      const marker = readMarker(projectPath);
      const markerTime = new Date(marker.started_at);
      expect(markerTime >= beforeWrite).toBe(true);
      expect(markerTime <= afterWrite).toBe(true);
    });
  });

  describe('error scenarios', () => {
    it('should handle write when directory permissions allow', () => {
      // This test verifies normal write path with proper permissions
      const newProjectPath = path.join(projectPath, 'new-project');
      fs.mkdirSync(newProjectPath);

      const payload = { pid: 123, run_id: 'test' };
      const result = writeMarker(newProjectPath, payload);
      expect(result.ok).toBe(true);

      const marker = readMarker(newProjectPath);
      expect(marker.pid).toBe(123);
    });

    it('should overwrite existing marker when writing again', () => {
      const payload1 = { pid: 111, run_id: 'first' };
      const payload2 = { pid: 222, run_id: 'second' };

      writeMarker(projectPath, payload1);
      const firstMarker = readMarker(projectPath);
      expect(firstMarker.pid).toBe(111);

      writeMarker(projectPath, payload2);
      const secondMarker = readMarker(projectPath);
      expect(secondMarker.pid).toBe(222);
    });

    it('should add mcp_instance_id automatically if not in payload', () => {
      const payload = { pid: 123, run_id: 'test' };
      // Don't include mcp_instance_id in payload
      writeMarker(projectPath, payload);

      const marker = readMarker(projectPath);
      expect(marker.mcp_instance_id).toBeDefined();
      expect(marker.mcp_instance_id.startsWith('workflow-mcp@')).toBe(true);
    });

    it('should preserve mcp_instance_id from payload if provided', () => {
      const customInstanceId = 'custom-instance-123';
      const payload = { pid: 123, run_id: 'test', mcp_instance_id: customInstanceId };
      writeMarker(projectPath, payload);

      const marker = readMarker(projectPath);
      expect(marker.mcp_instance_id).toBe(customInstanceId);
    });

    it('should handle readMarker on non-existent file gracefully', () => {
      const marker = readMarker(projectPath);
      expect(marker).toBeNull();
    });

    it('should handle readMarker on malformed JSON', () => {
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '{invalid json}', 'utf8');

      expect(() => {
        readMarker(projectPath);
      }).toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should support full lifecycle: write → validate → remove', () => {
      const testPid = 54321;
      const payload = { pid: testPid, run_id: 'lifecycle-test' };

      // Write
      const writeResult = writeMarker(projectPath, payload);
      expect(writeResult.ok).toBe(true);

      // Validate
      const currentInstanceId = getMcpInstanceIdForPath(projectPath);
      const validation = validateMarker(projectPath, testPid, currentInstanceId);
      expect(validation.valid).toBe(true);

      // Remove
      const removeResult = removeMarker(projectPath);
      expect(removeResult.ok).toBe(true);

      // Verify removed
      const markerPath = path.join(projectPath, '.workflow', 'logs', '.mcp-started-by');
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('should detect PID mismatch after marker is written', () => {
      const originalPid = 111;
      const payload = { pid: originalPid, run_id: 'test' };
      writeMarker(projectPath, payload);

      const currentInstanceId = getMcpInstanceIdForPath(projectPath);

      // Validate with correct PID
      const correctValidation = validateMarker(projectPath, originalPid, currentInstanceId);
      expect(correctValidation.valid).toBe(true);

      // Validate with different PID
      const wrongValidation = validateMarker(projectPath, 999, currentInstanceId);
      expect(wrongValidation.valid).toBe(false);
      expect(wrongValidation.reason).toBe('PID_MISMATCH');
    });

    it('should work with multiple projects', () => {
      const projectPath1 = path.join(projectPath, 'project1');
      const projectPath2 = path.join(projectPath, 'project2');
      fs.mkdirSync(projectPath1, { recursive: true });
      fs.mkdirSync(projectPath2, { recursive: true });

      const payload1 = { pid: 111, run_id: 'project1-run' };
      const payload2 = { pid: 222, run_id: 'project2-run' };

      writeMarker(projectPath1, payload1);
      writeMarker(projectPath2, payload2);

      const marker1 = readMarker(projectPath1);
      const marker2 = readMarker(projectPath2);

      expect(marker1.pid).toBe(111);
      expect(marker2.pid).toBe(222);
    });
  });
});
