/**
 * Smoke-тест: весь набор tools доезжает до клиента через настоящий
 * JSON-RPC handshake.
 *
 * Зачем отдельно от unit-тестов: один кривой `inputSchema` роняет сериализацию
 * всего списка на стороне SDK, и `tools/list` возвращает error вместо tools —
 * клиент не видит ни одного инструмента. Так и случилось с
 * `z.record(z.any())` в coach.mjs: все 24 tools стали невидимы, а unit-тесты
 * при этом оставались зелёными.
 *
 * Ожидаемый набор лежит в `server.tools-list.snapshot.json`. Новый tool —
 * осознанно дописать имя туда же.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
const SNAPSHOT = path.join(__dirname, 'server.tools-list.snapshot.json');

/**
 * Поднять сервер, отправить initialize → initialized → указанный метод,
 * вернуть разобранный ответ на него.
 */
async function requestList(method = 'tools/list') {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-tools-list-'));
  fs.mkdirSync(path.join(fixtureDir, '.workflow'), { recursive: true });

  const server = spawn(process.execPath, [path.join(rootDir, 'src/server.mjs')], {
    cwd: fixtureDir,
    // WORKFLOW_STATE_DIR держит каталог состояния внутри фикстуры: иначе
    // каждый прогон оставляет по каталогу в %LOCALAPPDATA%\workflow-mcp.
    env: { ...process.env, MCP_CWD: fixtureDir, WORKFLOW_STATE_DIR: path.join(fixtureDir, '.state') },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const send = (msg) => server.stdin.write(JSON.stringify(msg) + '\n');

  try {
    // Ответы приходят построчно; ждём тот, у которого совпал id.
    const waitFor = (id, timeoutMs = 15000) => new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Нет ответа на запрос id=${id} за ${timeoutMs} мс`));
      }, timeoutMs);

      const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) { continue; }
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // не JSON-RPC строка
          }
          if (msg.id === id) {
            cleanup();
            resolve(msg);
            return;
          }
        }
      };

      function cleanup() {
        clearTimeout(timer);
        server.stdout.removeListener('data', onData);
      }

      server.stdout.on('data', onData);
    });

    const initialized = waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tools-list-smoke', version: '1.0.0' }
      }
    });
    await initialized;

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = waitFor(2);
    send({ jsonrpc: '2.0', id: 2, method, params: {} });
    return await listed;
  } finally {
    server.kill('SIGKILL');
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // временная папка могла быть уже убрана
    }
  }
}

describe('tools/list через JSON-RPC', () => {
  it('отдаёт ровно те tools, что записаны в снапшоте', { timeout: 30000 }, async () => {
    const response = await requestList('tools/list');

    expect(response.error).toBeUndefined();
    expect(Array.isArray(response.result?.tools)).toBe(true);

    const actual = response.result.tools.map((t) => t.name).sort();
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).sort();

    expect(actual).toEqual(expected);
  });

  it('у каждого tool есть описание и JSON-Schema входа', { timeout: 30000 }, async () => {
    const response = await requestList('tools/list');

    for (const tool of response.result.tools) {
      expect(typeof tool.description, `${tool.name}: нет description`).toBe('string');
      expect(tool.description.length, `${tool.name}: пустой description`).toBeGreaterThan(0);
      expect(tool.inputSchema?.type, `${tool.name}: inputSchema не сериализовалась`).toBe('object');
    }
  });
});

describe('resources/list через JSON-RPC', () => {
  // Шаблоны и SKILL.md числятся в `resources_list()` и описаны в README,
  // но регистрации у них не было: `resources/list` отдавал 8 URI без них,
  // и починка пути к шаблонам лежала в недостижимом коде.
  it('отдаёт шаблоны и скилы', { timeout: 30000 }, async () => {
    const response = await requestList('resources/list');

    expect(response.error).toBeUndefined();
    const uris = (response.result?.resources ?? []).map((r) => r.uri);

    expect(uris).toEqual(expect.arrayContaining([
      'workflow://templates/ticket',
      'workflow://templates/plan',
      'workflow://templates/report'
    ]));
    expect(uris.filter((u) => /^workflow:\/\/skills\/.+\/SKILL\.md$/.test(u)).length).toBeGreaterThan(0);
  });
});
