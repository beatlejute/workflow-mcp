import { describe, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(path.dirname(__dirname));

/**
 * Spawn the MCP server with a given fixture directory.
 * WORKFLOW_AI_RESOLVE_PATH redirects require.resolve() for workflow-ai
 * so tests can supply their own version without touching the real node_modules.
 */
function spawnServer(fixtureDir, extraEnv = {}) {
  return spawn('node', [path.join(rootDir, 'src/server.mjs')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      MCP_CWD: fixtureDir,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Create a minimal fixture directory that contains a fake workflow-ai package.
 * Used by TC-02 and TC-04 to test version mismatch behaviour.
 *
 * @param {string} version  semver string, e.g. '1.0.9' or '0.9.0'
 * @returns {string} path to the created fixture directory
 */
function createFakeWorkflowAiFixture(version) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-fake-'));
  fs.mkdirSync(path.join(fixtureDir, '.workflow'), { recursive: true });

  // Stub the exported file that server.mjs anchors on (workflow-ai/lib/find-root.mjs)
  const wfDir = path.join(fixtureDir, 'node_modules', 'workflow-ai');
  fs.mkdirSync(path.join(wfDir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(wfDir, 'src', 'lib', 'find-root.mjs'),
    'export function findRoot() { return process.cwd(); }\n'
  );

  // Package manifest — the exports map mirrors the real workflow-ai layout
  fs.writeFileSync(
    path.join(wfDir, 'package.json'),
    JSON.stringify({
      name: 'workflow-ai',
      version,
      exports: {
        './lib/find-root.mjs': './src/lib/find-root.mjs',
      },
    }, null, 2)
  );

  return fixtureDir;
}

/**
 * Remove a temp directory safely on Windows.
 * SIGKILL leaves open handles for a brief moment; a short delay lets them close.
 * EPERM during rmSync is non-fatal — the OS will eventually reclaim the temp dir.
 */
async function safeCleanup(dir) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Windows: ignore lock errors — OS reclaims temp directories on reboot/idle
  }
}

describe('Startup Guard - Dependency Version Drift Detection', () => {

  /**
   * TC-01: Правильная версия (1.1.0) установлена — сервер стартует без FATAL.
   *
   * Использует реальный workflow-ai из node_modules проекта (WORKFLOW_AI_RESOLVE_PATH не задан).
   * Сервер должен работать не менее 3 с без вывода FATAL в stderr.
   */
  it('TC-01: correct version (1.1.0+) installed — server starts without FATAL', { timeout: 10000 }, async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-ok-'));
    fs.mkdirSync(path.join(fixtureDir, '.workflow'), { recursive: true });

    const serverProcess = spawnServer(fixtureDir);
    let stderr = '';
    let settled = false;

    serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    const result = await new Promise((resolve, reject) => {
      // Give the server 3 seconds to prove it stays alive without FATAL
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        serverProcess.kill('SIGKILL');
        if (stderr.includes('FATAL')) {
          reject(new Error(
            `Server emitted FATAL during startup with correct version.\n` +
            `stderr: ${stderr.substring(0, 400)}`
          ));
        } else {
          resolve('timeout-ok: server ran for 3s without FATAL');
        }
      }, 3000);

      serverProcess.on('exit', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0 || stderr.includes('FATAL')) {
          reject(new Error(
            `Server exited prematurely (code=${code}) or emitted FATAL.\n` +
            `stderr: ${stderr.substring(0, 400)}`
          ));
        } else {
          resolve('exit-ok');
        }
      });
    });

    // Cleanup AFTER promise settled — avoids EPERM from in-flight file handles (DEFECT-3 fix)
    await safeCleanup(fixtureDir);
    // a11y: result contains "timeout-ok" or "exit-ok"
    return result;
  });

  /**
   * TC-02: Устаревшая версия (1.0.9, < 1.1.0) — WARNING в stderr, сервер продолжает работу.
   *
   * Использует WORKFLOW_AI_RESOLVE_PATH + fake workflow-ai@1.0.9 в fixture (DEFECT-4 fix).
   * semver: '1.0.9' не удовлетворяет '^1.1.0', major совпадает → WARNING + продолжение.
   */
  it('TC-02: old version (1.0.9 < 1.1.0) → WARNING on stderr, server continues', { timeout: 10000 }, async () => {
    const fixtureDir = createFakeWorkflowAiFixture('1.0.9');
    const serverProcess = spawnServer(fixtureDir, {
      WORKFLOW_AI_RESOLVE_PATH: fixtureDir,
    });
    let stderr = '';
    let settled = false;

    serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        serverProcess.kill('SIGKILL');
        if (stderr.includes('WARNING') && !stderr.includes('FATAL')) {
          resolve();
        } else {
          reject(new Error(
            `Expected WARNING in stderr and no FATAL, but got:\n` +
            `stderr: ${stderr.substring(0, 400)}`
          ));
        }
      }, 3000);

      serverProcess.on('exit', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Premature exit means server crashed — that's a FAIL for this TC
        reject(new Error(
          `Server exited prematurely (code=${code}); expected it to stay alive after WARNING.\n` +
          `stderr: ${stderr.substring(0, 400)}`
        ));
      });
    });

    await safeCleanup(fixtureDir);
  });

  /**
   * TC-03: Пакет workflow-ai недоступен — FATAL, exit code 1.
   *
   * Fixture не содержит workflow-ai в node_modules.
   * WORKFLOW_AI_RESOLVE_PATH = fixtureDir → require.resolve() бросает MODULE_NOT_FOUND.
   */
  it('TC-03: workflow-ai unavailable → server exits with FATAL and exit code 1', { timeout: 10000 }, async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-missing-'));
    fs.mkdirSync(path.join(fixtureDir, '.workflow'), { recursive: true });
    // Intentionally NO node_modules/workflow-ai in fixtureDir

    const serverProcess = spawnServer(fixtureDir, {
      WORKFLOW_AI_RESOLVE_PATH: fixtureDir,
    });
    let stderr = '';

    serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        serverProcess.kill('SIGKILL');
        reject(new Error(
          `Server did not exit within timeout.\n` +
          `Expected early FATAL exit but server kept running.\n` +
          `stderr: ${stderr.substring(0, 300)}`
        ));
      }, 5000);

      serverProcess.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    await safeCleanup(fixtureDir);

    // a11y assertion: exit code=1, stderr contains "FATAL" and "workflow-ai"
    if (code !== 1 || !stderr.includes('FATAL') || !stderr.includes('workflow-ai')) {
      throw new Error(
        `Expected exit(1) + "FATAL" + "workflow-ai" in stderr.\n` +
        `Got code=${code}.\nstderr: ${stderr.substring(0, 300)}`
      );
    }
  });

  /**
   * TC-04: Сообщение FATAL/WARNING содержит номера semver-версий.
   *
   * Использует fake workflow-ai@0.9.0 (major=0 vs expected major=1 → FATAL с версиями).
   * Проверяет что сообщение содержит и установленную (0.9.0), и ожидаемую (^1.1.0) версии.
   */
  it('TC-04: FATAL/WARNING message contains actual semver version numbers', { timeout: 10000 }, async () => {
    // Major mismatch: expected ^1.1.0, got 0.9.0 → FATAL with both versions in message
    const fixtureDir = createFakeWorkflowAiFixture('0.9.0');
    const serverProcess = spawnServer(fixtureDir, {
      WORKFLOW_AI_RESOLVE_PATH: fixtureDir,
    });
    let stderr = '';

    serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        serverProcess.kill('SIGKILL');
        reject(new Error(
          `Server did not exit within timeout.\n` +
          `Expected FATAL exit (major mismatch: ^1.1.0 vs 0.9.0) but server kept running.\n` +
          `stderr: ${stderr.substring(0, 300)}`
        ));
      }, 5000);

      serverProcess.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    await safeCleanup(fixtureDir);

    // a11y: stderr must contain a semver version in the 0.x.x or 1.x.x range
    // Pattern is narrow enough to exclude Node.js version (25.x.x) but wide enough for workflow-ai
    const hasSemanticVersion = /\b[01]\.\d+\.\d+\b/.test(stderr);
    if (!hasSemanticVersion || code !== 1) {
      throw new Error(
        `Expected FATAL (code=1) with semver versions in message.\n` +
        `Got code=${code}. No semver match in stderr:\n${stderr.substring(0, 400)}`
      );
    }
  });
});
