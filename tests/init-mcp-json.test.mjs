import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.resolve(projectRoot, 'bin', 'server.mjs');

describe('CLI: --init-mcp-json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('TC-001: создаёт .mcp.json в пустой директории с корректной структурой', () => {
    const result = spawnSync('node', [cliPath, '--init-mcp-json'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const mcpJsonPath = path.resolve(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpJsonPath)).toBe(true);

    const content = fs.readFileSync(mcpJsonPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config).toHaveProperty('mcpServers');
    expect(config.mcpServers).toHaveProperty('workflow');
    expect(config.mcpServers.workflow).toHaveProperty('command', 'node');
    expect(config.mcpServers.workflow).toHaveProperty('args');
    expect(Array.isArray(config.mcpServers.workflow.args)).toBe(true);
    expect(config.mcpServers.workflow.args[0]).toContain('server.mjs');
  });

  it('TC-002: сохраняет существующие серверы при обновлении', () => {
    const mcpJsonPath = path.resolve(tmpDir, '.mcp.json');
    const existingConfig = {
      mcpServers: {
        other: {
          command: 'some-command',
          args: ['arg1'],
        },
      },
    };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(existingConfig, null, 2));

    const result = spawnSync('node', [cliPath, '--init-mcp-json'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const content = fs.readFileSync(mcpJsonPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.mcpServers.other).toEqual(existingConfig.mcpServers.other);
    expect(config.mcpServers.workflow).toBeDefined();
  });

  it('TC-003: генерирует валидный JSON без ошибок парсинга', () => {
    const result = spawnSync('node', [cliPath, '--init-mcp-json'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const mcpJsonPath = path.resolve(tmpDir, '.mcp.json');
    const content = fs.readFileSync(mcpJsonPath, 'utf-8');

    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('TC-004: args содержит абсолютный путь к bin/server.mjs', () => {
    const result = spawnSync('node', [cliPath, '--init-mcp-json'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const mcpJsonPath = path.resolve(tmpDir, '.mcp.json');
    const content = fs.readFileSync(mcpJsonPath, 'utf-8');
    const config = JSON.parse(content);

    const serverPath = config.mcpServers.workflow.args[0];
    // Проверяем что это абсолютный путь
    expect(serverPath.startsWith('/') || /^[A-Z]:/.test(serverPath)).toBe(true);
    expect(serverPath).toContain('server.mjs');
  });

  it.todo('TC-005: --target cursor создаёт .cursor/mcp.json вместо .mcp.json');
  it.todo('TC-006: повторный вызов без --force выдаёт FILE_ALREADY_EXISTS error');
  it.todo('TC-007: --force перезаписывает существующий файл');
  it.todo('TC-008: --dry-run выводит JSON на stdout без создания файла');
});
