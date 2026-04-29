/**
 * Pipeline Log Parser for workflow-ai
 * Parses structured pipeline runner logs into Step objects
 */

/**
 * @typedef {Object} Step
 * @property {number} step_number
 * @property {string} stage
 * @property {string} agent
 * @property {string} [skill]
 * @property {string} status - 'success' | 'error' | string
 * @property {number} exit_code
 * @property {string} started_at - ISO 8601
 * @property {string|null} completed_at - ISO 8601 or null
 * @property {number} duration_ms
 * @property {Record<string, string>} context
 * @property {Record<string, string>} result_block
 * @property {string|null} next_stage
 * @property {string} output_snippet
 */

/**
 * Sanitizes ANSI escape codes from a string
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  if (typeof str !== 'string') return str;
  // Remove ANSI escape sequences (\x1b[...m, \x1b[...;...m, etc.)
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parses a timestamp like [2026-04-25 13:37:22] into ISO 8601
 * @param {string} timestamp - e.g. "2026-04-25 13:37:22"
 * @returns {string} ISO 8601 format
 */
function parseTimestamp(timestamp) {
  // timestamp format: YYYY-MM-DD HH:mm:ss
  const dt = new Date(timestamp.replace(' ', 'T') + 'Z');
  return dt.toISOString();
}

/**
 * Extracts key-value pair from a line, stripping timestamp/prefix
 * Handles lines like: [2026-04-25 13:37:24] [INFO] [pick-first-task]   ticket_id: IMPL-1
 * @param {string} line
 * @returns {{key: string, value: string}|null}
 */
function extractKeyValue(line) {
  let sanitized = stripAnsi(line.trim());
  // Remove timestamp and prefix: [2026-04-25 13:37:24] [INFO] [pick-first-task]
  sanitized = sanitized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[\w+\] \[[\w-]+\]\s*/, '');
  // Remove leading whitespace
  sanitized = sanitized.trim();
  const colonIdx = sanitized.indexOf(':');
  if (colonIdx > 0) {
    const key = sanitized.slice(0, colonIdx).trim();
    const value = sanitized.slice(colonIdx + 1).trim();
    if (key && value) {
      return { key, value };
    }
  }
  return null;
}

/**
 * Extracts key-value pairs from context lines
 * Context lines look like: key: value
 * @param {string[]} contextLines
 * @returns {Record<string, string>}
 */
function parseContext(contextLines) {
  const context = {};
  for (const line of contextLines) {
    const keyValue = extractKeyValue(line);
    if (keyValue) {
      context[keyValue.key] = keyValue.value;
    }
  }
  return context;
}

/**
 * Parses a result block line into key-value pairs
 * @param {string[]} resultLines
 * @returns {Record<string, string>}
 */
function parseResultBlock(resultLines) {
  const result = {};
  for (const line of resultLines) {
    const keyValue = extractKeyValue(line);
    if (keyValue) {
      result[keyValue.key] = keyValue.value;
    }
  }
  return result;
}

/**
 * Extracts the last N non-empty lines for output_snippet
 * @param {string[]} outputLines
 * @param {number} n
 * @returns {string}
 */
function buildOutputSnippet(outputLines, n = 5) {
  const sanitized = outputLines.map(l => stripAnsi(l)).filter(l => l.trim());
  const lastN = sanitized.slice(-n);
  return lastN.join('\n');
}

/**
 * Parses a pipeline log into an array of Step objects
 * @param {string} text - The pipeline log text
 * @returns {Step[]}
 */
export function parsePipelineLog(text) {
  if (typeof text !== 'string') {
    return [];
  }

  const lines = text.split('\n');
  const steps = [];
  let currentStep = null;
  let currentOutput = [];
  let currentResultLines = [];
  let inResultBlock = false;
  let inContextBlock = false;
  let contextLines = [];
  let inOutputBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sanitized = stripAnsi(line);

    // Detect Step N marker: [timestamp] [INFO] [PipelineRunner] Step N
    const stepMatch = sanitized.match(/\[PipelineRunner\] Step (\d+)/);
    if (stepMatch) {
      // Save previous step if exists
      if (currentStep) {
        currentStep.output_snippet = buildOutputSnippet(currentOutput);
        if (contextLines.length > 0) {
          currentStep.context = parseContext(contextLines);
        }
        if (currentResultLines.length > 0) {
          currentStep.result_block = parseResultBlock(currentResultLines);
        }
        steps.push(currentStep);
      }

      const stepNum = parseInt(stepMatch[1], 10);
      const timestampMatch = sanitized.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
      const timestamp = timestampMatch ? parseTimestamp(timestampMatch[1]) : new Date().toISOString();

      currentStep = {
        step_number: stepNum,
        stage: '',
        agent: '',
        skill: undefined,
        status: 'running',
        exit_code: 0,
        started_at: timestamp,
        completed_at: null,
        duration_ms: 0,
        context: {},
        result_block: {},
        next_stage: null,
        output_snippet: ''
      };
      currentOutput = [];
      currentResultLines = [];
      inResultBlock = false;
      inContextBlock = false;
      contextLines = [];
      inOutputBlock = false;
      continue;
    }

    // Detect Current stage: ...
    const stageMatch = sanitized.match(/\[PipelineRunner\] Current stage: (\S+)/);
    if (stageMatch && currentStep) {
      currentStep.stage = stageMatch[1];
      continue;
    }

    // Detect START stage marker
    const startMatch = sanitized.match(/START stage="([^"]+)" agent="([^"]+)"(?: skill="([^"]+)")?/);
    if (startMatch && currentStep) {
      const [, stage, agent, skill] = startMatch;
      currentStep.stage = stage;
      currentStep.agent = agent;
      if (skill && skill !== 'undefined') {
        currentStep.skill = skill;
      }
      const tsMatch = sanitized.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
      if (tsMatch) {
        currentStep.started_at = parseTimestamp(tsMatch[1]);
      }
      continue;
    }

    // Detect Context: marker
    if (sanitized.includes('Context:')) {
      inContextBlock = true;
      contextLines = [];
      continue;
    }

    // Detect OUTPUT ↓ marker
    if (sanitized.includes('OUTPUT ↓')) {
      inOutputBlock = true;
      currentOutput = [];
      continue;
    }

    // Detect OUTPUT ↑ marker
    if (sanitized.includes('OUTPUT ↑')) {
      inOutputBlock = false;
      continue;
    }

    // Collect context lines (lines after Context: marker with key: value format)
    if (inContextBlock && currentStep) {
      const keyValue = extractKeyValue(sanitized);
      if (keyValue) {
        contextLines.push(sanitized);
        continue;
      } else {
        // End context block if we hit a marker (OUTPUT, RESULT, COMPLETE, etc)
        if (sanitized.includes('OUTPUT') || sanitized.includes('---RESULT---') ||
            sanitized.includes('COMPLETE') || sanitized.includes('GOTO') ||
            sanitized.includes('Step ')) {
          inContextBlock = false;
        } else {
          // Continue collecting context if line is empty or indented comment
          if (sanitized.trim()) {
            inContextBlock = false;
          }
          continue;
        }
      }
    }

    // Collect output lines (between OUTPUT ↓ and OUTPUT ↑)
    if (inOutputBlock && currentStep) {
      const outputLine = sanitized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[\w+\] \[[\w-]+\]\s*/, '');
      if (outputLine.trim() && !outputLine.includes('OUTPUT') && !outputLine.includes('---RESULT')) {
        currentOutput.push(outputLine);
      }
      continue;
    }

    // Detect result block: ---RESULT---
    if (sanitized.includes('---RESULT---')) {
      if (!inResultBlock) {
        // Start of result block
        inResultBlock = true;
        currentResultLines = [];
      } else {
        // End of result block - will be processed when saving the step
        inResultBlock = false;
      }
      continue;
    }

    // Collect result block lines
    if (inResultBlock && currentStep) {
      currentResultLines.push(sanitized);
      continue;
    }

    // Detect COMPLETE stage marker
    const completeMatch = sanitized.match(/COMPLETE stage="([^"]+)" status="([^"]+)" exitCode=(\d+)/);
    if (completeMatch && currentStep) {
      const [, stage, status, exitCode] = completeMatch;
      currentStep.status = status;
      currentStep.exit_code = parseInt(exitCode, 10);
      const tsMatch = sanitized.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
      if (tsMatch) {
        currentStep.completed_at = parseTimestamp(tsMatch[1]);
        const start = new Date(currentStep.started_at).getTime();
        const end = new Date(currentStep.completed_at).getTime();
        currentStep.duration_ms = end - start;
      }
      continue;
    }

    // Detect GOTO marker for next_stage
    const gotoMatch = sanitized.match(/GOTO\s+(\S+)\s+→\s+(\S+)/);
    if (gotoMatch && currentStep) {
      const [, from, to] = gotoMatch;
      currentStep.next_stage = to;
      continue;
    }
  }

  // Save last step
  if (currentStep) {
    if (currentStep.completed_at === null) {
      currentStep.status = 'running';
    }
    currentStep.output_snippet = buildOutputSnippet(currentOutput);
    if (contextLines.length > 0) {
      currentStep.context = parseContext(contextLines);
    }
    if (currentResultLines.length > 0) {
      currentStep.result_block = parseResultBlock(currentResultLines);
    }
    steps.push(currentStep);
  }

  return steps;
}
