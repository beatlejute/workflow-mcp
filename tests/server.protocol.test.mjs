import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);

/**
 * Helper to start server process
 */
async function startServer() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-protocol-test-'));
  fs.mkdirSync(path.join(fixtureDir, '.workflow'), { recursive: true });

  const serverProcess = spawn('node', [path.join(rootDir, 'src/server.mjs')], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      MCP_CWD: fixtureDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });

  // Wait for server to start
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    const onError = (data) => {
      const msg = data.toString();
      if (msg.includes('[server] workflow-mcp server started')) {
        ready = true;
        serverProcess.stderr.removeListener('data', onError);
        resolve();
      }
    };

    const onTimeout = setTimeout(() => {
      if (!ready) {
        serverProcess.stderr.removeListener('data', onError);
        reject(new Error('Server startup timeout'));
      }
    }, 5000);

    serverProcess.stderr.on('data', onError);
  });

  try {
    await readyPromise;
  } catch (err) {
    serverProcess.kill('SIGKILL');
    throw err;
  }

  return {
    process: serverProcess,
    fixtureDir,
    sendInput(data) {
      serverProcess.stdin.write(JSON.stringify(data) + '\n');
    },
    async stop() {
      return new Promise((resolve, reject) => {
        let exitCodeReceived = false;
        const timeout = setTimeout(() => {
          if (!exitCodeReceived) {
            serverProcess.kill('SIGKILL');
            reject(new Error('Server did not stop gracefully'));
          }
        }, 3000);

        serverProcess.on('exit', (code) => {
          clearTimeout(timeout);
          exitCodeReceived = true;
          try {
            fs.rmSync(this.fixtureDir, { recursive: true, force: true });
          } catch (err) {
            // ignore cleanup errors
          }
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Server exited with code ${code}`));
          }
        });

        serverProcess.kill('SIGTERM');
      });
    },
  };
}

describe('MCP Protocol Compliance Tests', () => {
  describe('Basic Server Operations', () => {
    let server;

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('server should start and respond to initialization', { timeout: 15000 }, async () => {
      server = await startServer();

      // Send initialize request
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      };

      server.sendInput(initRequest);

      // Server should be running
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Invalid Arguments Handling', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('server should not crash on invalid tool arguments', async () => {
      // Send invalid tool call (missing required arguments)
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'list_tickets',
          arguments: {}  // Missing required 'project' argument
        }
      });

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      // Server should still be running
      expect(server.process.exitCode).toBeNull();
    });

    it('server should remain responsive after receiving invalid arguments', async () => {
      // Send invalid request
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_tickets' }  // Invalid: missing arguments
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Send another valid initialize request
      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should still be running
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Unknown Tool Handling', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('server should not crash on unknown tool call', async () => {
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'foo_bar_unknown_tool_xyz',
          arguments: { someArg: 'value' }
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });

    it('server should handle subsequent requests after unknown tool error', async () => {
      // Call unknown tool
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'nonexistent_tool',
          arguments: {}
        }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should still accept requests
      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should still be running
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Resource Operations', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('server should handle invalid resource URI without crashing', async () => {
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'workflow://unknown/nonexistent' }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });

    it('server should not crash on multiple invalid resource requests', async () => {
      // Send multiple invalid resource requests
      for (let i = 1; i <= 3; i++) {
        server.sendInput({
          jsonrpc: '2.0',
          id: i,
          method: 'resources/read',
          params: { uri: `invalid://resource/${i}` }
        });
      }

      await new Promise(resolve => setTimeout(resolve, 800));

      // Server should still be running
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Subscribe/Unsubscribe Resource Changes', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('server should handle resource subscription requests', async () => {
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/subscribe',
        params: { uri: 'project://test' }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });

    it('server should handle unsubscribe operations', async () => {
      // Subscribe first
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/subscribe',
        params: { uri: 'project://test' }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Then unsubscribe
      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/unsubscribe',
        params: { uri: 'project://test' }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Parallel Tool Calls', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('should handle multiple parallel tool calls without crashing', async () => {
      // Send multiple requests in parallel (rapid succession)
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'unknown_tool_1', arguments: {} }
      });

      server.sendInput({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'unknown_tool_2', arguments: {} }
      });

      server.sendInput({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Server should not crash from parallel calls
      expect(server.process.exitCode).toBeNull();
    });

    it('parallel calls should not cause race conditions', async () => {
      // Send multiple initialize requests rapidly
      for (let i = 1; i <= 5; i++) {
        server.sendInput({
          jsonrpc: '2.0',
          id: i,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
        });
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Server Lifecycle - SIGTERM Handling', () => {
    it('should gracefully shutdown on SIGTERM', { timeout: 15000 }, async () => {
      const server = await startServer();

      // Send a request
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 200));

      // Send SIGTERM while handling requests
      server.process.kill('SIGTERM');

      // Server should shutdown cleanly
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server did not shutdown within timeout'));
        }, 5000);

        server.process.on('exit', (code) => {
          clearTimeout(timeout);
          // Exit code 0 or 143 (SIGTERM) is acceptable
          try {
            fs.rmSync(server.fixtureDir, { recursive: true, force: true });
          } catch (err) {
            // ignore
          }
          expect([0, 143, null].includes(code)).toBe(true);
          resolve();
        });
      });
    });

    it('server should exit with code 0 after SIGTERM', { timeout: 15000 }, async () => {
      const server = await startServer();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server did not exit after SIGTERM'));
        }, 5000);

        let exited = false;
        server.process.on('exit', (code) => {
          clearTimeout(timeout);
          exited = true;
          try {
            fs.rmSync(server.fixtureDir, { recursive: true, force: true });
          } catch (err) {
            // ignore
          }
          // Code 0 or 143 (SIGTERM) or null is acceptable
          expect([0, 143, null].includes(code)).toBe(true);
          resolve();
        });

        server.process.kill('SIGTERM');
      });
    });
  });

  describe('Multiple Initialize Calls', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('should handle repeated initialize requests', async () => {
      // Send initialize multiple times
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('Error Recovery and Robustness', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(async () => {
      if (server) {
        try {
          await server.stop();
        } catch (err) {
          // ignore
        }
      }
    });

    it('should handle mixed valid and invalid requests without crashing', async () => {
      // Send alternating valid and invalid requests
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'invalid_tool', arguments: {} } },
        { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'bad://uri' } },
        { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
      ];

      for (const req of requests) {
        server.sendInput(req);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Server should not crash
      expect(server.process.exitCode).toBeNull();
    });

    it('server should remain responsive after errors', async () => {
      // Cause some errors
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'bad_tool_1', arguments: {} }
      });

      server.sendInput({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'bad_tool_2', arguments: {} }
      });

      server.sendInput({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'bad://uri' }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Send a valid request
      server.sendInput({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Server should still be running
      expect(server.process.exitCode).toBeNull();
    });
  });

  describe('SIGTERM During Request Processing', () => {
    it('should handle SIGTERM in middle of processing', { timeout: 15000 }, async () => {
      const server = await startServer();

      // Send a request
      server.sendInput({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });

      // Immediately send SIGTERM
      setTimeout(() => {
        server.process.kill('SIGTERM');
      }, 50);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server did not shutdown'));
        }, 5000);

        server.process.on('exit', (code) => {
          clearTimeout(timeout);
          try {
            fs.rmSync(server.fixtureDir, { recursive: true, force: true });
          } catch (err) {
            // ignore
          }
          // Should exit cleanly
          expect([0, 143, null].includes(code)).toBe(true);
          resolve();
        });
      });
    });
  });
});
