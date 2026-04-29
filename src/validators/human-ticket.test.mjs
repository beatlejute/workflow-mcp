import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isValidHumanTicket, getDefaultConfig, loadConfig } from './human-ticket.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('isValidHumanTicket', () => {
  const validTicket = { id: 'HUMAN-1', title: 'Test' };

  it('should reject body shorter than min_result_length', () => {
    const result = isValidHumanTicket(validTicket, 'short', {
      min_result_length: 50,
      evidence_required: false
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('less than minimum required');
  });

  it('should accept body longer than min_result_length', () => {
    const longBody = 'a'.repeat(51);
    const result = isValidHumanTicket(validTicket, longBody, {
      min_result_length: 50,
      evidence_required: false
    });

    expect(result.valid).toBe(true);
  });

  it('should reject body without evidence when evidence_required is true', () => {
    const bodyWithoutEvidence = 'This is a long description but without any URLs or paths or code blocks';
    const result = isValidHumanTicket(validTicket, bodyWithoutEvidence, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('must contain evidence');
  });

  it('should accept body with URL as evidence', () => {
    const bodyWithUrl = 'Here is a link: https://example.com/path with more text to meet minimum length requirement for the test.';
    const result = isValidHumanTicket(validTicket, bodyWithUrl, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should accept body with file:// URL as evidence', () => {
    const bodyWithFileUrl = 'Reference file://usr/local/src/file.txt with additional text to reach minimum length for validation.';
    const result = isValidHumanTicket(validTicket, bodyWithFileUrl, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should accept body with absolute path as evidence', () => {
    const bodyWithPath = 'The file is located at /usr/local/bin/script.sh and that is all we need to know about this.';
    const result = isValidHumanTicket(validTicket, bodyWithPath, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should accept body with code block as evidence', () => {
    const bodyWithCode = `Result is: \`\`\`javascript
function test() { return true; }
\`\`\` and that proves the point with sufficient length.`;
    const result = isValidHumanTicket(validTicket, bodyWithCode, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should accept body with inline code as evidence', () => {
    const bodyWithInlineCode = 'The function `processData()` returns the result we expected, meeting the minimum length requirement.';
    const result = isValidHumanTicket(validTicket, bodyWithInlineCode, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should accept body with markdown link as evidence', () => {
    const bodyWithLink = 'See [this report](https://example.com/report) for details, which provides the evidence needed.';
    const result = isValidHumanTicket(validTicket, bodyWithLink, {
      min_result_length: 50,
      evidence_required: true
    });

    expect(result.valid).toBe(true);
  });

  it('should trim whitespace before validation', () => {
    const bodyWithWhitespace = '  ' + 'a'.repeat(50) + '  ';
    const result = isValidHumanTicket(validTicket, bodyWithWhitespace, {
      min_result_length: 50,
      evidence_required: false
    });

    expect(result.valid).toBe(true);
  });

  it('should accept empty config and use defaults', () => {
    const longBody = 'a'.repeat(51) + ' https://example.com';
    const result = isValidHumanTicket(validTicket, longBody);

    expect(result.valid).toBe(true);
  });

  it('should reject short body with default config', () => {
    const result = isValidHumanTicket(validTicket, 'short');

    expect(result.valid).toBe(false);
  });
});

describe('getDefaultConfig', () => {
  it('should return default configuration', () => {
    const config = getDefaultConfig();

    expect(config.strict_validation).toBe(false);
    expect(config.min_result_length).toBe(50);
    expect(config.evidence_required).toBe(true);
  });

  it('should not affect original defaults when modifying returned config', () => {
    const config1 = getDefaultConfig();
    config1.min_result_length = 100;

    const config2 = getDefaultConfig();
    expect(config2.min_result_length).toBe(50);
  });
});

describe('loadConfig', () => {
  const tmpDir = path.join(__dirname, '../../.workflow/tmp-validator-test');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('should return default config when no config file exists', () => {
    const config = loadConfig(tmpDir);

    expect(config.strict_validation).toBe(false);
    expect(config.min_result_length).toBe(50);
  });

  it('should load config from .workflow-mcp.yaml if exists', () => {
    const configPath = path.join(tmpDir, '.workflow-mcp.yaml');
    const yaml = `human_ticket:
  strict_validation: true
  min_result_length: 100
  evidence_required: false
`;
    fs.writeFileSync(configPath, yaml, 'utf8');

    const config = loadConfig(tmpDir);

    expect(config.strict_validation).toBe(true);
    expect(config.min_result_length).toBe(100);
    expect(config.evidence_required).toBe(false);
  });

  it('should merge loaded config with defaults', () => {
    const configPath = path.join(tmpDir, '.workflow-mcp.yaml');
    const yaml = `human_ticket:
  min_result_length: 75
`;
    fs.writeFileSync(configPath, yaml, 'utf8');

    const config = loadConfig(tmpDir);

    expect(config.min_result_length).toBe(75);
    expect(config.strict_validation).toBe(false); // default value
  });

  it('should handle missing human_ticket section gracefully', () => {
    const configPath = path.join(tmpDir, '.workflow-mcp.yaml');
    const yaml = `other_config: value`;
    fs.writeFileSync(configPath, yaml, 'utf8');

    const config = loadConfig(tmpDir);

    expect(config.min_result_length).toBe(50); // default
  });

  it('should handle invalid YAML gracefully', () => {
    const configPath = path.join(tmpDir, '.workflow-mcp.yaml');
    fs.writeFileSync(configPath, 'invalid: yaml: content:', 'utf8');

    const config = loadConfig(tmpDir);

    expect(config.min_result_length).toBe(50); // default
  });
});

describe('isValidHumanTicket with custom rules', () => {
  const tmpDir = path.join(__dirname, '../../.workflow/tmp-custom-rules-test');
  const validTicket = { id: 'HUMAN-1', title: 'Test' };

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('should apply custom rules from human-task-rules.md', () => {
    const rulesPath = path.join(tmpDir, 'human-task-rules.md');
    const rulesContent = `# Custom Rules

- rule: TICKET-[0-9]+ | ticket reference
- rule: @[a-zA-Z0-9_]+ | user mention
`;
    fs.writeFileSync(rulesPath, rulesContent, 'utf8');

    // Body with custom rule match (TICKET-123)
    const bodyWithCustomRule = 'This is a long description mentioning TICKET-123 as reference for the implementation.';
    const result = isValidHumanTicket(validTicket, bodyWithCustomRule, {
      min_result_length: 50,
      evidence_required: true,
      projectPath: tmpDir
    });

    expect(result.valid).toBe(true);
  });

  it('should still reject body without any evidence when custom rules exist', () => {
    const rulesPath = path.join(tmpDir, 'human-task-rules.md');
    const rulesContent = `# Custom Rules

- rule: TICKET-[0-9]+ | ticket reference
`;
    fs.writeFileSync(rulesPath, rulesContent, 'utf8');

    // Body without any evidence or custom rule match
    const bodyWithoutEvidence = 'This is a long description without any references or URLs or code blocks.';
    const result = isValidHumanTicket(validTicket, bodyWithoutEvidence, {
      min_result_length: 50,
      evidence_required: true,
      projectPath: tmpDir
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('must contain evidence');
  });

  it('should handle malformed custom rules gracefully', () => {
    const rulesPath = path.join(tmpDir, 'human-task-rules.md');
    const rulesContent = `# Custom Rules

- rule: [invalid-regex | description
- rule: (?P<invalid>regex) | invalid group syntax
`;
    fs.writeFileSync(rulesPath, rulesContent, 'utf8');

    // Should fall back to built-in patterns
    const bodyWithUrl = 'Check this: https://example.com for details, with enough length here.';
    const result = isValidHumanTicket(validTicket, bodyWithUrl, {
      min_result_length: 50,
      evidence_required: true,
      projectPath: tmpDir
    });

    expect(result.valid).toBe(true);
  });

  it('should not fail if human-task-rules.md does not exist', () => {
    const bodyWithUrl = 'Refer to https://example.com for more information with sufficient length.';
    const result = isValidHumanTicket(validTicket, bodyWithUrl, {
      min_result_length: 50,
      evidence_required: true,
      projectPath: tmpDir
    });

    expect(result.valid).toBe(true);
  });
});
