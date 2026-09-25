import { describe, it, expect } from 'vitest';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'server.mjs');

// timeout: если флаг не разобран как справка, запускается сам сервер и ждёт
// stdio — тест должен упасть, а не повиснуть.
function runCli(args) {
  return spawnSync('node', [cliPath, ...args], { encoding: 'utf-8', timeout: 10000, input: '' });
}

describe('CLI: справка и неизвестные флаги', () => {
  // `--help` и `-h` стояли в usage, но не в options parseArgs со strict: true —
  // оба падали ERR_PARSE_ARGS_UNKNOWN_OPTION со стеком Node вместо справки.
  it.each([['--help'], ['-h']])('%s печатает справку и выходит с 0', (flag) => {
    const result = runCli([flag]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: workflow-mcp');
    expect(result.stderr).not.toContain('ERR_PARSE_ARGS');
  });

  // Справка обещала `.workflow-mcp.json`, а --init-mcp-json пишет `.mcp.json`.
  it('справка называет файл, который пишет --init-mcp-json', () => {
    const result = runCli(['--help']);

    expect(result.stdout).toContain('.mcp.json');
    expect(result.stdout).not.toContain('.workflow-mcp.json');
  });

  it('неизвестный флаг — сообщение и справка в stderr, код 1, без стека Node', () => {
    const result = runCli(['--bogus']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--bogus');
    expect(result.stderr).toContain('Usage: workflow-mcp');
    expect(result.stderr).not.toContain('node:internal');
  });
});
