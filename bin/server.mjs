#!/usr/bin/env node

import { parseArgs } from 'util';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';

const usage = `
Usage: workflow-mcp [options]

Options:
  --root <path>        Override current working directory
  --init-mcp-json      Initialize .workflow-mcp.json (CLI mode)
  -h, --help           Show this help message
`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcServerPath = resolve(__dirname, '..', 'src', 'server.mjs');

const options = {
  root: { type: 'string', default: process.cwd() },
  'init-mcp-json': { type: 'boolean', default: false },
};

const { values, positionals } = parseArgs({
  options,
  strict: true,
  allowPositionals: true,
});

if (values.help || positionals.includes('-h') || positionals.includes('--help')) {
  console.log(usage);
  process.exit(0);
}

// Handle --init-mcp-json flag
if (values['init-mcp-json']) {
  const mcpJsonPath = resolve(process.cwd(), '.mcp.json');
  const serverPath = resolve(__dirname, 'server.mjs');

  // Read existing .mcp.json or create empty structure
  let mcpConfig = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      const content = readFileSync(mcpJsonPath, 'utf-8');
      mcpConfig = JSON.parse(content);
      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
    } catch (err) {
      console.error(`Error reading ${mcpJsonPath}:`, err.message);
      process.exit(1);
    }
  }

  // Add/update workflow server entry
  mcpConfig.mcpServers.workflow = {
    command: 'node',
    args: [serverPath],
  };

  // Write updated config
  try {
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`Initialized ${mcpJsonPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`Error writing ${mcpJsonPath}:`, err.message);
    process.exit(1);
  }
}

// Override cwd if --root is provided
if (values.root !== process.cwd()) {
  process.chdir(values.root);
}

// Call the main server module
const serverProcess = spawn('node', [srcServerPath], {
  stdio: 'inherit',
});

serverProcess.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

serverProcess.on('close', (code) => {
  process.exit(code);
});