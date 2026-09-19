/**
 * Схемы всех инструментов должны переживать сериализацию в JSON Schema.
 *
 * История: `coach.mjs` объявлял `args: z.record(z.any())`. На zod 4 такая форма
 * роняет конвертер SDK, и весь ответ `tools/list` превращался в
 * `{"error":{"code":-32603,"message":"Cannot read properties of undefined (reading '_zod')"}}`.
 * Клиент не видел НИ ОДНОГО инструмента — при том, что каждый из них был
 * реализован и покрыт собственными тестами. Ошибка воспроизводилась только в
 * живой сессии клиента.
 *
 * Здесь та же дорожка проходится локально: каждый инструмент прогоняется через
 * `normalizeObjectSchema` + `toJsonSchemaCompat` SDK ровно с теми опциями, что
 * использует `McpServer`. Плюс набор сверяется со снимком `tools/list`, чтобы
 * тест не начал молча проверять меньше инструментов, чем зарегистрировано.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
const toolsDir = path.join(rootDir, '..', 'src', 'tools');

const SNAPSHOT = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'server.tools-list.snapshot.json'), 'utf-8')
);

/** Тот же предикат, по которому инструменты отбирает `loadTools()` в server.mjs. */
function isValidTool(obj) {
  return obj
    && typeof obj === 'object'
    && typeof obj.name === 'string'
    && typeof obj.description === 'string'
    && typeof obj.execute === 'function'
    && obj.inputSchema;
}

async function discoverTools() {
  const tools = [];
  const seen = new Set();

  const collect = (value) => {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (isValidTool(item) && !seen.has(item.name)) {
        seen.add(item.name);
        tools.push(item);
      }
    }
  };

  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(toolsDir, file)).href);
    for (const value of Object.values(module)) collect(value);
  }
  return tools;
}

const tools = await discoverTools();

describe('набор инструментов', () => {
  it('совпадает со снимком tools/list', () => {
    // Иначе тест ниже может проходить, проверяя половину инструментов.
    expect(tools.map((t) => t.name).sort()).toEqual([...SNAPSHOT].sort());
  });
});

describe('сериализация inputSchema через конвертер SDK', () => {
  it.each(tools.map((t) => [t.name, t]))('%s', (_name, tool) => {
    const normalized = normalizeObjectSchema(tool.inputSchema);
    expect(normalized, 'схема не распознана как объектная').toBeTruthy();

    // Те же опции, что McpServer передаёт при ответе на tools/list.
    const jsonSchema = toJsonSchemaCompat(normalized, {
      strictUnions: true,
      pipeStrategy: 'input'
    });

    expect(jsonSchema).toBeTruthy();
    expect(jsonSchema.type).toBe('object');
    // Результат обязан пережить обход и укладку в ответ по проводу.
    expect(() => JSON.stringify(jsonSchema)).not.toThrow();
  });
});

describe('сериализация outputSchema, где она объявлена', () => {
  const withOutput = tools.filter((t) => t.outputSchema);

  it('инструменты без outputSchema не мешают', () => {
    expect(withOutput.length).toBeLessThanOrEqual(tools.length);
  });

  it.each(withOutput.map((t) => [t.name, t]))('%s', (_name, tool) => {
    const normalized = normalizeObjectSchema(tool.outputSchema);
    expect(normalized).toBeTruthy();
    const jsonSchema = toJsonSchemaCompat(normalized, {
      strictUnions: true,
      pipeStrategy: 'output'
    });
    expect(() => JSON.stringify(jsonSchema)).not.toThrow();
  });
});
