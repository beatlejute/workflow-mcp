import fs from 'fs';
import path from 'path';

/**
 * Sanity check: ensure PII is not present in fixture files
 * Checks for: HOME paths, email patterns, API keys
 */
export function checkFixtureSafety(text) {
  const issues = [];

  // Check for common PII patterns (redacted in this example)
  const patterns = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    apiKey: /(api[_-]?key|token|secret)[\s:=]+\S{20,}/gi,
    homePath: /\/home\/\w+|\/Users\/\w+/g,
    windowsPath: /C:\\Users\\\w+/gi
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    const matches = text.match(pattern);
    if (matches) {
      issues.push({ type, count: matches.length, samples: matches.slice(0, 2) });
    }
  }

  return issues;
}

/**
 * Validates fixture files for safety
 */
export function validateFixtures(fixturesDir) {
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.log'));
  const results = {};

  for (const file of files) {
    const filePath = path.join(fixturesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = checkFixtureSafety(content);
    results[file] = {
      safe: issues.length === 0,
      issues
    };
  }

  return results;
}

export default { checkFixtureSafety, validateFixtures };
