#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const files = [
  '/d/Dev/workflow-mcp/src/tools/coach.mjs',
  '/d/Dev/workflow-mcp/src/tools/git.mjs',
  '/d/Dev/workflow-mcp/src/tools/reports.mjs',
  '/d/Dev/workflow-mcp/src/tools/search.mjs'
];

function convertJsonSchemaToZod(content) {
  // Find all inputSchema: { ... } blocks and convert them
  let result = content;

  // Pattern: inputSchema: {
  //   type: 'object',
  //   properties: { ... },
  //   required: [...],
  //   ...
  // },

  // Simple replacement: inputSchema: { -> inputSchema: z.object({
  result = result.replace(/inputSchema:\s*\{[\s\n]/g, (match) => {
    return match.replace('{', 'z.object({');
  });

  // Now find the closing } for inputSchema and replace it with })
  // This is trickier - we need to find the matching closing brace

  let inInputSchema = false;
  let braceCount = 0;
  let output = '';
  let i = 0;

  while (i < result.length) {
    const char = result[i];

    if (result.substr(i, 11) === 'inputSchema') {
      // Check if this is followed by : z.object({
      const nextPart = result.substr(i, 30);
      if (nextPart.includes('z.object({')) {
        inInputSchema = true;
        braceCount = 0;
        output += 'inputSchema';
        i += 11;
        continue;
      }
    }

    if (inInputSchema) {
      if (char === '{') braceCount++;
      if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          // This is the closing brace for inputSchema
          output += '})';
          inInputSchema = false;
          i++;
          continue;
        }
      }
    }

    output += char;
    i++;
  }

  // If the above approach doesn't work well, use a simpler regex-based approach
  // Replace specific JSON schema patterns with Zod

  let zodContent = result;

  // Remove type: 'object' from inputSchema
  zodContent = zodContent.replace(/type:\s*['"]object['"]\s*,\n\s*/g, '');

  // Convert property definitions
  // type: 'string' -> z.string()
  // type: 'number' -> z.number()
  // type: 'array' -> z.array(z.string())
  // etc.

  // This is getting complex. Let me use a different approach:
  // Just remove the JSON schema boilerplate and keep the properties simple

  zodContent = zodContent.replace(/required:\s*\[[^\]]*\]\s*,?\n\s*/g, '');
  zodContent = zodContent.replace(/additionalProperties:\s*false\s*,?\n\s*/g, '');
  zodContent = zodContent.replace(/properties:\s*\{\n\s*/g, '');
  zodContent = zodContent.replace(/\n\s*\},?\n\s*required/g, '\n  required');

  return zodContent;
}

for (const filePath of files) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');

    // Add zod import if not present
    if (!content.includes("import { z } from 'zod'")) {
      const lines = content.split('\n');
      let importIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('import')) {
          importIndex = i;
        } else if (lines[i] && !lines[i].startsWith('import') && !lines[i].startsWith('//')) {
          break;
        }
      }
      lines.splice(importIndex + 1, 0, "import { z } from 'zod';");
      content = lines.join('\n');
    }

    // Simple approach: replace obvious patterns
    content = content.replace(/inputSchema:\s*\{\s*type:\s*['"]object['"]\s*,\s*properties:\s*\{([^}]*)\}\s*,?\s*required:\s*\[\s*\]\s*,?\s*additionalProperties:\s*false\s*\}/g, (match) => {
      return 'inputSchema: z.object({})';
    });

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Processed ${path.basename(filePath)}`);
  } catch (err) {
    console.error(`✗ Error processing ${path.basename(filePath)}: ${err.message}`);
  }
}

console.log('Done!');
