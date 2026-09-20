/**
 * E2E: служба здоровья на живом сервере.
 *
 * Unit-тесты проверяют цепочку по кускам и подменяют проверку pid. Этого мало:
 * когда цепочку впервые собрали, unit-тесты были зелёными, а настоящий сервер
 * не поднимал ни одного алерта. Два места, которые видно только здесь:
 * `isProcessAlive` на Windows считал живым любой мёртвый pid (искал в выводе
 * `tasklist` подстроку, которой там нет), а уведомления падали с
 * `server.sendResourceUpdated is not a function`.
 *
 * Тест поднимает настоящий процесс сервера и разговаривает с ним по JSON-RPC
 * через stdio — как это делает клиент.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.resolve(__dirname, '../../src/server.mjs');

const DEAD_PID = 999999;

describe('E2E: алерты здоровья доходят до клиента', () => {
  let workspace;
  let stateDir;
  let child;
  let nextId = 1;

  const responses = new Map();
  const notifications = [];
  const stderrChunks = [];

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  }

  function waitForResponse(id, timeoutMs = 15000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (responses.has(id)) return resolve(responses.get(id));
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for response ${id}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** Ждёт выполнения условия или сдаётся по таймауту. */
  function waitUntil(predicate, timeoutMs = 15000) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (predicate()) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function readAlerts() {
    const response = await waitForResponse(send('resources/read', { uri: 'workflow://alerts' }));
    const text = response.result?.contents?.[0]?.text ?? '[]';
    return JSON.parse(text);
  }

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'health-e2e-'));
    stateDir = path.join(workspace, '.state');
    const project = path.join(workspace, 'demo');
    const logsDir = path.join(project, '.workflow', 'logs');

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Раннер умер, а лог свежий — ровно условие алерта `crashed`.
    // `started_by: cli` намеренно: служба здоровья смотрит за всеми запусками,
    // а не только за своими.
    fs.writeFileSync(
      path.join(logsDir, '.pipeline.lock'),
      JSON.stringify({
        pid: DEAD_PID,
        run_id: 'e2e-run',
        started_by: 'cli',
        started_at: new Date().toISOString()
      })
    );
    fs.writeFileSync(path.join(logsDir, 'pipeline_e2e-run.log'), 'stage log\n');

    fs.writeFileSync(
      path.join(workspace, '.workflow-mcp.yaml'),
      `state:\n  dir: "${stateDir.replace(/\\/g, '/')}"\nhealth:\n  tick_interval_sec: 1\n`
    );

    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, MCP_CWD: workspace },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) responses.set(message.id, message);
          else notifications.push(message);
        } catch {
          // не JSON-RPC — игнорируем
        }
      }
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));

    await waitForResponse(send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { resources: { subscribe: true } },
      clientInfo: { name: 'health-e2e', version: '1.0.0' }
    }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }, 60000);

  afterAll(async () => {
    if (child) {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('resources/subscribe принимается сервером', async () => {
    // `McpServer` из SDK подписку не реализует: без своих обработчиков сервер
    // отвечал «Method not found» на ресурс, помеченный как subscribable.
    const response = await waitForResponse(send('resources/subscribe', { uri: 'workflow://alerts' }));

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  it('мёртвый раннер поднимает алерт crashed в workflow://alerts', async () => {
    // Тик раз в секунду; ждём появления алерта, а не фиксированную паузу.
    let alerts = [];
    const started = Date.now();
    while (Date.now() - started < 15000) {
      alerts = await readAlerts();
      if (alerts.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const crashed = alerts.find(a => a.type === 'crashed');
    expect(crashed, `алертов: ${JSON.stringify(alerts)}`).toBeDefined();
    expect(crashed.pid).toBe(DEAD_PID);
    expect(crashed.run_id).toBe('e2e-run');
    expect(crashed.project).toBe('demo');
  }, 30000);

  it('история алертов записана в каталог состояния', () => {
    expect(fs.existsSync(path.join(stateDir, 'alerts-history.jsonl'))).toBe(true);
  });

  it('клиент получил notifications/resources/updated', async () => {
    const got = await waitUntil(() => notifications.some(
      n => n.method === 'notifications/resources/updated' && n.params?.uri === 'workflow://alerts'
    ), 15000);

    expect(got, `уведомления: ${JSON.stringify(notifications.map(n => n.method))}`).toBe(true);
  }, 30000);

  it('повторные тики не размножают алерт', async () => {
    const before = await readAlerts();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after = await readAlerts();

    // Раннер мёртв всё это время: детектор срабатывает каждый тик, дедуп
    // оставляет одну запись.
    expect(after.length).toBe(before.length);
  }, 30000);

  it('stderr сервера не засоряется каждый тик', () => {
    const stderr = stderrChunks.join('');

    // Каждая из этих строк печаталась по разу на тик на проект.
    expect(stderr).not.toContain('server alive');
    expect(stderr).not.toContain('not a git repository');
    expect(stderr).not.toContain('[retry_loop]');
    expect(stderr).not.toContain('[blocked_accumulation]');
    expect(stderr).not.toContain('is not a function');
  });
});
