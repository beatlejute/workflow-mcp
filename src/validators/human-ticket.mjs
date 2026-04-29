import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Default configuration for human ticket validation
 */
const DEFAULT_CONFIG = {
  strict_validation: false,
  min_result_length: 50,
  evidence_required: true
};

/**
 * Evidence patterns for validating result body
 * Checks for URL, file path, or code block
 */
const EVIDENCE_PATTERNS = [
  /https?:\/\/[^\s]+/,        // HTTP(S) URL
  /file:\/\/[^\s]+/,          // File URL
  /\/[a-zA-Z0-9_\-./]+/,      // Absolute path
  /\.[a-zA-Z0-9_\-\/]+\//,    // Relative path with extension
  /```[\s\S]*?```/,           // Code block
  /`[^`]+`/,                  // Inline code
  /\[.*\]\(.*\)/              // Markdown link
];

/**
 * Load custom validation rules from human-task-rules.md file
 * @param {string} projectPath - Path to the project
 * @returns {Array<{pattern: RegExp, type: string}>} Array of custom rules
 */
function loadCustomRules(projectPath) {
  const rulesFilePath = path.join(projectPath, 'human-task-rules.md');

  if (!fs.existsSync(rulesFilePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(rulesFilePath, 'utf8');
    const rules = [];

    // Simple parser for rules like:
    // - rule: pattern (as regex) | description
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('-')) {
        const match = line.match(/[-]\s*rule:\s*(.+?)\s*\|\s*(.+)/);
        if (match) {
          try {
            const pattern = new RegExp(match[1].trim());
            rules.push({
              pattern,
              type: match[2].trim()
            });
          } catch (e) {
            // Skip invalid regex patterns
          }
        }
      }
    }

    return rules;
  } catch (e) {
    // If error reading rules, return empty array
    return [];
  }
}

/**
 * Check if body contains evidence
 * @param {string} body - Result body
 * @param {Array<{pattern: RegExp, type: string}>} customRules - Custom validation rules
 * @returns {boolean} True if evidence found
 */
function hasEvidence(body, customRules = []) {
  // Check built-in patterns
  for (const pattern of EVIDENCE_PATTERNS) {
    if (pattern.test(body)) {
      return true;
    }
  }

  // Check custom rules
  for (const rule of customRules) {
    if (rule.pattern.test(body)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate human ticket result
 * @param {Object} ticket - Ticket object (with frontmatter fields)
 * @param {string} body - Result body content to validate
 * @param {Object} [config] - Configuration object
 * @param {number} [config.min_result_length] - Minimum length of result body (default 50)
 * @param {boolean} [config.evidence_required] - Whether evidence is required (default true)
 * @param {string} [config.projectPath] - Project path for loading custom rules
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
export function isValidHumanTicket(ticket, body, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Normalize body
  const normalizedBody = (body || '').trim();

  // Check minimum length
  if (normalizedBody.length < finalConfig.min_result_length) {
    return {
      valid: false,
      reason: `Result body length (${normalizedBody.length}) is less than minimum required (${finalConfig.min_result_length})`
    };
  }

  // Check for evidence if required
  if (finalConfig.evidence_required) {
    // Load custom rules if project path provided
    const customRules = finalConfig.projectPath
      ? loadCustomRules(finalConfig.projectPath)
      : [];

    if (!hasEvidence(normalizedBody, customRules)) {
      return {
        valid: false,
        reason: 'Result body must contain evidence (URL, file path, code block, or link)'
      };
    }
  }

  return { valid: true };
}

/**
 * Get default configuration for human ticket validation
 * @returns {Object} Default configuration
 */
export function getDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}

/**
 * Load configuration from project if available
 * @param {string} projectPath - Path to the project
 * @returns {Object} Merged configuration
 */
export function loadConfig(projectPath) {
  const config = { ...DEFAULT_CONFIG };

  // Try to load from .workflow-mcp.yaml if it exists
  const configPath = path.join(projectPath, '.workflow-mcp.yaml');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(content);

      if (parsed?.human_ticket) {
        Object.assign(config, parsed.human_ticket);
      }
    } catch (e) {
      // If config loading fails, continue with defaults
    }
  }

  return config;
}
