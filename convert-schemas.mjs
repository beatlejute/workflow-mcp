#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function convertJsonSchemaToZod(jsonSchema) {
  if (!jsonSchema || typeof jsonSchema !== 'object') return null;

  let zodSchema = 'z.object({\n';

  const properties = jsonSchema.properties || {};
  const required = jsonSchema.required || [];

  for (const [key, prop] of Object.entries(properties)) {
    const isRequired = required.includes(key);
    let zodType = '';

    if (prop.type === 'string') {
      if (prop.enum) {
        zodType = `z.enum([${prop.enum.map(e => `'${e}'`).join(', ')}])`;
      } else {
        zodType = 'z.string()';
      }
    } else if (prop.type === 'number') {
      zodType = 'z.number()';
    } else if (prop.type === 'boolean') {
      zodType = 'z.boolean()';
    } else if (prop.type === 'array') {
      zodType = 'z.array(z.string())';
    } else {
      zodType = 'z.any()';
    }

    if (!isRequired) {
      zodType += '.optional()';
    }

    const description = prop.description ? `.describe('${prop.description.replace(/'/g, "\\'")}')}` : '';
    zodSchema += `  ${key}: ${zodType}${description},\n`;
  }

  zodSchema += '})';
  return zodSchema;
}

async function convertFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Check if file already has z import
  if (!content.includes("import { z } from 'zod'")) {
    // Add z import after existing imports
    const importMatch = content.match(/^(import[^;]*;)*\n*/m);
    if (importMatch) {
      content = content.replace(
        importMatch[0],
        importMatch[0] + "import { z } from 'zod';\n"
      );
    }
  }

  // Find and replace inputSchema patterns
  const pattern = /inputSchema:\s*\{[\s\S]*?\n\s*\},/;
  const matches = content.matchAll(new RegExp(pattern.source, 'g'));

  for (const match of matches) {
    const schemaStr = match[0];
    try {
      // Extract the JSON object
      const jsonStr = schemaStr.substring(schemaStr.indexOf('{'), schemaStr.lastIndexOf('}') + 1);
      const jsonSchema = eval('(' + jsonStr + ')');
      const zodSchema = convertJsonSchemaToZod(jsonSchema);

      if (zodSchema) {
        const newSchema = 'inputSchema: ' + zodSchema + ',';
        content = content.replace(schemaStr, newSchema);
        console.log(`✓ Converted schema in ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.error(`✗ Failed to convert schema in ${path.basename(filePath)}: ${err.message}`);
    }
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

async function main() {
  const toolsDir = path.join(__dirname, 'src', 'tools');
  const files = [
    'analytics.mjs',
    'coach.mjs',
    'diagnostics.mjs',
    'git.mjs',
    'pipeline.mjs',
    'reports.mjs',
    'search.mjs'
  ];

  for (const file of files) {
    const filePath = path.join(toolsDir, file);
    if (fs.existsSync(filePath)) {
      try {
        await convertFile(filePath);
      } catch (err) {
        console.error(`Error processing ${file}:`, err.message);
      }
    }
  }

  console.log('Conversion complete!');
}

main().catch(console.error);
