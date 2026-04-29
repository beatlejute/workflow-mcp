/**
 * Parser for run-skill-tests.js output
 *
 * Parses structured output from run-skill-tests.js into a JSON object.
 * Extracts test results, summary statistics, and individual test details.
 */

/**
 * Parse run-skill-tests.js output into structured JSON
 * @param {string} stdout - Standard output from run-skill-tests.js
 * @param {string} stderr - Standard error from run-skill-tests.js
 * @returns {object} Parsed result with structure: {skill_name, summary: {pass, fail, skipped, total}, results: [...]}
 */
export function parseSkillTestsOutput(stdout, stderr, skillName) {
  const result = {
    skill_name: skillName,
    summary: {
      pass: 0,
      fail: 0,
      skipped: 0,
      total: 0
    },
    results: []
  };

  // Parse the RESULT block
  const resultMatch = stdout.match(/---RESULT---([\s\S]*?)---RESULT---/);
  if (!resultMatch) {
    // No result block found - treat as error
    return result;
  }

  const resultBlock = resultMatch[1];
  const lines = resultBlock.split('\n').filter(l => l.trim());

  // Parse key-value pairs
  const parsed = {};
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length > 0) {
      const value = valueParts.join(':').trim();
      parsed[key.trim()] = value;
    }
  }

  // Extract summary from parsed data
  if (parsed['current_run.passed']) {
    result.summary.pass = parseInt(parsed['current_run.passed'], 10) || 0;
  }
  if (parsed['current_run.failed']) {
    result.summary.fail = parseInt(parsed['current_run.failed'], 10) || 0;
  }
  if (parsed['current_run.no_coverage']) {
    result.summary.skipped = parseInt(parsed['current_run.no_coverage'], 10) || 0;
  }

  // Calculate total
  result.summary.total = result.summary.pass + result.summary.fail + result.summary.skipped;

  // Parse individual test results from the output
  // Look for test case patterns in stderr/stdout
  const testLines = stderr.split('\n').concat(stdout.split('\n'));
  const testResults = {};

  for (const line of testLines) {
    // Match patterns like "TC-COACH-001: passed" or "TC-COACH-001: failed: error message"
    const testMatch = line.match(/^.*?(TC-[A-Z0-9-]+)\s*[:=]\s*(passed|failed|error|skipped)(?:\s*:\s*(.*))?/i);
    if (testMatch) {
      const testId = testMatch[1];
      const verdict = testMatch[2].toLowerCase();
      const detail = testMatch[3] || '';

      if (!testResults[testId]) {
        testResults[testId] = {
          test_id: testId,
          verdict: verdict === 'error' ? 'fail' : verdict,
          duration_ms: 0,
          output_excerpt: detail
        };
      }
    }
  }

  // Add parsed test results
  result.results = Object.values(testResults);

  return result;
}

/**
 * Extract last N lines from output
 * @param {string} output - Output string
 * @param {number} lineCount - Number of lines to extract (default 50)
 * @returns {string} Last N lines joined with newline
 */
export function extractOutputExcerpt(output, lineCount = 50) {
  const lines = output.split('\n');
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}
