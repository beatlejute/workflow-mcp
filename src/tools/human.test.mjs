import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve_human_ticket } from './human.mjs';
import { move_ticket } from './tickets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('resolve_human_ticket backward compatibility', () => {
  const testProjectRoot = path.join(__dirname, '../../.workflow/tmp-human-test');
  const ticketsDir = path.join(testProjectRoot, '.workflow/tickets');

  beforeEach(() => {
    // Create project structure
    if (!fs.existsSync(ticketsDir)) {
      fs.mkdirSync(ticketsDir, { recursive: true });
    }

    // Create status directories
    ['ready', 'in-progress', 'review', 'done'].forEach(status => {
      const statusDir = path.join(ticketsDir, status);
      if (!fs.existsSync(statusDir)) {
        fs.mkdirSync(statusDir, { recursive: true });
      }
    });
  });

  afterEach(() => {
    // Clean up test project
    if (fs.existsSync(testProjectRoot)) {
      fs.rmSync(testProjectRoot, { recursive: true });
    }
  });

  it('should reject invalid body when strict=true', async () => {
    // Create a HUMAN ticket with minimal body
    const ticketContent = `---
id: HUMAN-STRICT-001
title: Test Strict Validation
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket with short body requirement.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-STRICT-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-STRICT-001',
      target: 'in-progress'
    });

    // Try to resolve with invalid body and strict=true
    const invalidBody = 'short'; // Too short, < 50 chars
    try {
      await resolve_human_ticket({
        project: testProjectRoot,
        ticket_id: 'HUMAN-STRICT-001',
        decision: 'approved',
        result_body: invalidBody,
        next_status: 'done',
        strict: true
      });
      expect.fail('Should have thrown validation error');
    } catch (e) {
      expect(e.message).toContain('INVALID_HUMAN_RESULT');
      expect(e.message).toContain('less than minimum required');
    }
  });

  it('should accept invalid body when strict=false (backward compat)', async () => {
    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-COMPAT-001
title: Test Backward Compatibility
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket for backward compatibility.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-COMPAT-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-COMPAT-001',
      target: 'in-progress'
    });

    // Resolve with invalid body but strict=false
    const invalidBody = 'short'; // Too short for validation
    const result = await resolve_human_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-COMPAT-001',
      decision: 'approved',
      result_body: invalidBody,
      next_status: 'done',
      strict: false
    });

    expect(result.id).toBe('HUMAN-COMPAT-001');
    expect(result.new_status).toBe('done');

    // Verify ticket was moved and result was added
    const resolvedPath = path.join(ticketsDir, 'done', 'HUMAN-COMPAT-001.md');
    expect(fs.existsSync(resolvedPath)).toBe(true);

    const resolvedContent = fs.readFileSync(resolvedPath, 'utf8');
    expect(resolvedContent).toContain('## Результат');
    expect(resolvedContent).toContain('short');
  });

  it('should accept invalid body when strict parameter is not provided (default backward compat)', async () => {
    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-DEFAULT-001
title: Test Default Behavior
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket for default behavior.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-DEFAULT-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-DEFAULT-001',
      target: 'in-progress'
    });

    // Resolve with invalid body but NO strict parameter (should use default)
    const invalidBody = 'minimal'; // Less than 50 chars
    const result = await resolve_human_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-DEFAULT-001',
      decision: 'approved',
      result_body: invalidBody,
      next_status: 'done'
      // NO strict parameter - should default to config value (false)
    });

    expect(result.id).toBe('HUMAN-DEFAULT-001');
    expect(result.new_status).toBe('done');

    // Verify ticket was moved
    const resolvedPath = path.join(ticketsDir, 'done', 'HUMAN-DEFAULT-001.md');
    expect(fs.existsSync(resolvedPath)).toBe(true);
  });

  it('should accept valid body when strict=true', async () => {
    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-VALID-001
title: Test Valid Result
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket for valid results.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-VALID-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-VALID-001',
      target: 'in-progress'
    });

    // Resolve with valid body and strict=true
    const validBody = 'This is a valid result with sufficient length and includes a URL: https://example.com for reference.';
    const result = await resolve_human_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-VALID-001',
      decision: 'approved',
      result_body: validBody,
      next_status: 'done',
      strict: true
    });

    expect(result.id).toBe('HUMAN-VALID-001');
    expect(result.new_status).toBe('done');

    // Verify ticket was moved
    const resolvedPath = path.join(ticketsDir, 'done', 'HUMAN-VALID-001.md');
    expect(fs.existsSync(resolvedPath)).toBe(true);

    const resolvedContent = fs.readFileSync(resolvedPath, 'utf8');
    expect(resolvedContent).toContain('## Результат');
    expect(resolvedContent).toContain('https://example.com');
  });

  it('should reject body without evidence when strict=true and evidence_required=true', async () => {
    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-EVIDENCE-001
title: Test Evidence Requirement
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket for evidence requirement.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-EVIDENCE-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-EVIDENCE-001',
      target: 'in-progress'
    });

    // Resolve with sufficient length but no evidence
    const bodyWithoutEvidence = 'This is a long enough result but it does not contain any evidence like URLs or code blocks or paths.';
    try {
      await resolve_human_ticket({
        project: testProjectRoot,
        ticket_id: 'HUMAN-EVIDENCE-001',
        decision: 'approved',
        result_body: bodyWithoutEvidence,
        next_status: 'done',
        strict: true
      });
      expect.fail('Should have thrown validation error');
    } catch (e) {
      expect(e.message).toContain('INVALID_HUMAN_RESULT');
      expect(e.message).toContain('must contain evidence');
    }
  });

  it('should accept body with code block as evidence when strict=true', async () => {
    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-CODE-001
title: Test Code Block Evidence
type: human
created_at: "2026-04-28T00:00:00Z"
updated_at: "2026-04-28T00:00:00Z"
completed_at: ""
---
## Description
This is a test ticket for code block evidence.`;

    const ticketPath = path.join(ticketsDir, 'ready', 'HUMAN-CODE-001.md');
    fs.writeFileSync(ticketPath, ticketContent, 'utf8');

    // Move to in-progress first
    await move_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-CODE-001',
      target: 'in-progress'
    });

    // Resolve with valid body containing code block
    const bodyWithCode = `Result implementation:
\`\`\`javascript
function resolveTicket() {
  return { status: 'done', valid: true };
}
\`\`\`
This demonstrates the working implementation.`;

    const result = await resolve_human_ticket({
      project: testProjectRoot,
      ticket_id: 'HUMAN-CODE-001',
      decision: 'approved',
      result_body: bodyWithCode,
      next_status: 'done',
      strict: true
    });

    expect(result.id).toBe('HUMAN-CODE-001');
    expect(result.new_status).toBe('done');

    // Verify ticket was moved
    const resolvedPath = path.join(ticketsDir, 'done', 'HUMAN-CODE-001.md');
    expect(fs.existsSync(resolvedPath)).toBe(true);

    const resolvedContent = fs.readFileSync(resolvedPath, 'utf8');
    expect(resolvedContent).toContain('```javascript');
  });
});
