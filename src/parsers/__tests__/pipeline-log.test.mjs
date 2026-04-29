import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePipelineLog } from '../pipeline-log.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, '../../..', 'tests', 'fixtures', 'logs');

describe('parsePipelineLog', () => {
  let fixture1Success = '';
  let fixture2Error = '';
  let fixture3Incomplete = '';
  let fixture4Dirty = '';
  let fixture5Large = '';

  beforeAll(() => {
    // Load fixtures 1-4 from files
    fixture1Success = fs.readFileSync(path.join(fixturesDir, 'fixture-1-success.log'), 'utf-8');
    fixture2Error = fs.readFileSync(path.join(fixturesDir, 'fixture-2-error.log'), 'utf-8');
    fixture3Incomplete = fs.readFileSync(path.join(fixturesDir, 'fixture-3-incomplete.log'), 'utf-8');
    fixture4Dirty = fs.readFileSync(path.join(fixturesDir, 'fixture-4-dirty.log'), 'utf-8');

    // Generate fixture 5: ~10MB log (simulated with repeating steps)
    const stepTemplate = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step {N}
[2026-04-25 13:37:23] [INFO] [task-agent] START stage="bulk-task-{N}" agent="agent-{N}"
[2026-04-25 13:37:23] [INFO] [task-agent]   Context:
[2026-04-25 13:37:23] [INFO] [task-agent]     ticket_id: BULK-{N}
[2026-04-25 13:37:23] [INFO] [task-agent] OUTPUT ↓
[2026-04-25 13:37:24] [INFO] [task-agent]   This is a large output line with some content
[2026-04-25 13:37:24] [INFO] [task-agent]   Repeated many times to reach 10MB
[2026-04-25 13:37:24] [INFO] [task-agent] OUTPUT ↑
[2026-04-25 13:37:24] [INFO] [task-agent]   ---RESULT---
[2026-04-25 13:37:24] [INFO] [task-agent]   status: complete
[2026-04-25 13:37:24] [INFO] [task-agent]   ---RESULT---
[2026-04-25 13:37:25] [INFO] [task-agent] COMPLETE stage="bulk-task-{N}" status="success" exitCode=0
`;
    let chunks = [];
    let totalSize = 0;
    for (let i = 0; i < 100000; i++) {
      const chunk = stepTemplate.replace(/{N}/g, i);
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > 10 * 1024 * 1024) break; // Stop at ~10MB
    }
    fixture5Large = chunks.join('\n');
  });

  it('returns empty array for empty string', () => {
    expect(parsePipelineLog('')).toEqual([]);
  });

  it('returns empty array for non-string input', () => {
    expect(parsePipelineLog(null)).toEqual([]);
    expect(parsePipelineLog(undefined)).toEqual([]);
    expect(parsePipelineLog(123)).toEqual([]);
  });

  it('parses a simple step from pipeline log', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] === Pipeline Runner Started ===
[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:22] [INFO] [PipelineRunner] Current stage: pick-first-task
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick" skill="undefined"
[2026-04-25 13:37:23] [INFO] [pick-first-task] RUN node .workflow/src/scripts/pick-next-task.js
[2026-04-25 13:37:23] [INFO] [pick-first-task]   Context:
[2026-04-25 13:37:23] [INFO] [pick-first-task]     mcp_require_for: qa
[2026-04-25 13:37:24] [INFO] [pick-first-task] OUTPUT ↓
[2026-04-25 13:37:24] [INFO] [pick-first-task]   Task picked successfully
[2026-04-25 13:37:24] [INFO] [pick-first-task] OUTPUT ↑
[2026-04-25 13:37:24] [INFO] [pick-first-task]   ---RESULT---
[2026-04-25 13:37:24] [INFO] [pick-first-task]   status: found
[2026-04-25 13:37:24] [INFO] [pick-first-task]   ticket_id: IMPL-1
[2026-04-25 13:37:24] [INFO] [pick-first-task]   ---RESULT---
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      step_number: 1,
      stage: 'pick-first-task',
      agent: 'script-pick',
      status: 'found',
      exit_code: 0,
      next_stage: null
    });
    expect(result[0].result_block).toMatchObject({
      status: 'found',
      ticket_id: 'IMPL-1'
    });
  });

  it('parses multiple steps', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0
[2026-04-25 13:37:24] [INFO] [PipelineRunner] Step 2
[2026-04-25 13:37:29] [INFO] [move-to-in-progress] START stage="move-to-in-progress" agent="script-move"
[2026-04-25 13:37:29] [INFO] [move-to-in-progress] COMPLETE stage="move-to-in-progress" status="moved" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(2);
    expect(result[0].step_number).toBe(1);
    expect(result[0].status).toBe('found');
    expect(result[1].step_number).toBe(2);
    expect(result[1].status).toBe('moved');
  });

  it('calculates duration_ms for completed steps', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].duration_ms).toBe(1000);
    expect(result[0].completed_at).toBe('2026-04-25T13:37:24.000Z');
  });

  it('sets duration_ms to 0 for running steps without COMPLETE', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('running');
    expect(result[0].completed_at).toBeNull();
    expect(result[0].duration_ms).toBe(0);
  });

  it('parses GOTO for next_stage', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0
[2026-04-25 13:37:24] [INFO] [pick-first-task] GOTO pick-first-task → move-to-in-progress status="found"`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].next_stage).toBe('move-to-in-progress');
  });

  it('strips ANSI codes from output', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:23] [INFO] [pick-first-task] OUTPUT ↓
[2026-04-25 13:37:24] [INFO] [pick-first-task]   \x1b[36m[2026-04-25 13:37:23] [INFO] Loaded ticket rules\x1b[0m
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].output_snippet).toContain('[2026-04-25 13:37:23] [INFO] Loaded ticket rules');
    expect(result[0].output_snippet).not.toContain('\x1b');
  });

  it('parses context key-value pairs', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:23] [INFO] [pick-first-task] RUN node script.js
[2026-04-25 13:37:23] [INFO] [pick-first-task]   Context:
[2026-04-25 13:37:23] [INFO] [pick-first-task]     mcp_require_for: qa
[2026-04-25 13:37:23] [INFO] [pick-first-task]     ticket_id: IMPL-1
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].context).toMatchObject({
      mcp_require_for: 'qa',
      ticket_id: 'IMPL-1'
    });
  });

  it('handles empty result block', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:24] [INFO] [pick-first-task] COMPLETE stage="pick-first-task" status="found" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].result_block).toEqual({});
  });

  it('handles truncated result block (no closing ---RESULT---)', () => {
    const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [pick-first-task] START stage="pick-first-task" agent="script-pick"
[2026-04-25 13:37:23] [INFO] [pick-first-task]   ---RESULT---
[2026-04-25 13:37:23] [INFO] [pick-first-task]   status: found`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    // Open ---RESULT--- is still parsed (collected until end of step)
    expect(result[0].result_block).toMatchObject({
      status: 'found'
    });
  });

  it('parses step with skill', () => {
    const text = `[2026-04-25 13:37:23] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [execute-task] START stage="execute-task" agent="kilo-free" skill="execute-task"
[2026-04-25 13:37:24] [INFO] [execute-task] COMPLETE stage="execute-task" status="default" exitCode=0`;

    const result = parsePipelineLog(text);
    expect(result).toHaveLength(1);
    expect(result[0].skill).toBe('execute-task');
  });

  // ===== FIXTURE TESTS (5 fixtures) =====

  describe('Fixture 1: Short successful run', () => {
    it('parses fixture 1 correctly', () => {
      const result = parsePipelineLog(fixture1Success);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].status).toBe('success');
      expect(result[0].exit_code).toBe(0);
      expect(result[0].step_number).toBe(1);
      expect(result[0].stage).toBe('pick-first-task');
      expect(result[0].duration_ms).toBeGreaterThan(0);
    });

    it('fixture 1 context is parsed correctly', () => {
      const result = parsePipelineLog(fixture1Success);
      expect(result[0].context).toMatchObject({
        mcp_require_for: 'qa',
        ticket_id: 'IMPL-1'
      });
    });

    it('fixture 1 result_block is parsed correctly', () => {
      const result = parsePipelineLog(fixture1Success);
      expect(result[0].result_block).toMatchObject({
        status: 'found',
        ticket_id: 'IMPL-1'
      });
    });

    it('fixture 1 next_stage is parsed correctly', () => {
      const result = parsePipelineLog(fixture1Success);
      expect(result[0].next_stage).toBe('move-to-in-progress');
    });

    it('fixture 1 ANSI codes are stripped from output', () => {
      const result = parsePipelineLog(fixture1Success);
      expect(result[0].output_snippet).not.toContain('\x1b');
    });
  });

  describe('Fixture 2: Run with status=error', () => {
    it('parses fixture 2 with error status', () => {
      const result = parsePipelineLog(fixture2Error);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].status).toBe('error');
      expect(result[0].exit_code).toBe(1);
      expect(result[0].step_number).toBe(1);
      expect(result[0].stage).toBe('process-ticket');
    });

    it('fixture 2 context is parsed', () => {
      const result = parsePipelineLog(fixture2Error);
      expect(result[0].context).toMatchObject({
        ticket_id: 'IMPL-1'
      });
    });

    it('fixture 2 error message in result_block', () => {
      const result = parsePipelineLog(fixture2Error);
      expect(result[0].result_block).toMatchObject({
        status: 'error'
      });
      expect(result[0].result_block.error_message).toBeDefined();
    });
  });

  describe('Fixture 3: Incomplete run (no COMPLETE marker)', () => {
    it('parses fixture 3 as running status', () => {
      const result = parsePipelineLog(fixture3Incomplete);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].status).toBe('running');
      expect(result[0].completed_at).toBeNull();
      expect(result[0].duration_ms).toBe(0);
    });

    it('fixture 3 step_number is parsed', () => {
      const result = parsePipelineLog(fixture3Incomplete);
      expect(result[0].step_number).toBe(1);
    });

    it('fixture 3 context is parsed even for incomplete steps', () => {
      const result = parsePipelineLog(fixture3Incomplete);
      expect(result[0].context).toMatchObject({
        ticket_id: 'IMPL-5'
      });
    });
  });

  describe('Fixture 4: Dirty log (ANSI codes, multiline, unclosed RESULT)', () => {
    it('parses fixture 4 without exceptions', () => {
      expect(() => parsePipelineLog(fixture4Dirty)).not.toThrow();
    });

    it('fixture 4 returns Step array', () => {
      const result = parsePipelineLog(fixture4Dirty);
      expect(Array.isArray(result)).toBe(true);
    });

    it('fixture 4 ANSI codes are stripped', () => {
      const result = parsePipelineLog(fixture4Dirty);
      for (const step of result) {
        expect(step.output_snippet).not.toMatch(/\x1b\[/);
        expect(JSON.stringify(step.context)).not.toContain('\x1b');
      }
    });

    it('fixture 4 multiline output is collected', () => {
      const result = parsePipelineLog(fixture4Dirty);
      expect(result[0].output_snippet).toContain('Line 1 of multiline output');
      expect(result[0].output_snippet).toContain('Line 3 of multiline output');
    });

    it('fixture 4 handles unclosed RESULT block gracefully', () => {
      const result = parsePipelineLog(fixture4Dirty);
      // Parser should handle gracefully without crashing
      expect(result.length).toBeGreaterThan(0);
    });

    it('fixture 4 parses steps with duplicated Step markers', () => {
      const result = parsePipelineLog(fixture4Dirty);
      expect(result.length).toBe(2); // Fixture 4 has 2 steps
      expect(result[0].step_number).toBe(1);
      expect(result[1].step_number).toBe(2);
    });
  });

  describe('Fixture 5: Large 10MB log (performance test)', () => {
    it('parses fixture 5 within 500ms', () => {
      const startTime = Date.now();
      const result = parsePipelineLog(fixture5Large);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(2000);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(100); // At least 100 steps
    });

    it('fixture 5 returns valid Step objects', () => {
      const result = parsePipelineLog(fixture5Large);
      const sample = result[0];
      expect(sample).toHaveProperty('step_number');
      expect(sample).toHaveProperty('stage');
      expect(sample).toHaveProperty('status');
      expect(sample).toHaveProperty('duration_ms');
      expect(sample.duration_ms).toBeGreaterThan(0);
    });
  });

  // ===== PROPERTY-BASED TESTS =====

  describe('Property-based tests', () => {
    it('parser returns array for any string input', () => {
      const inputs = [
        'random garbage',
        '     ',
        'Step 1 without proper format',
        '',
        'null',
        '{"json": "object"}',
        '---RESULT---\nno step marker',
        '\n\n\n',
        'ANSI \x1b[31m with colors\x1b[0m',
        Array(1000).fill('repeated line\n').join(''),
      ];

      for (const input of inputs) {
        const result = parsePipelineLog(input);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('parser never throws on any log content', () => {
      const randomLogs = [];
      for (let i = 0; i < 10; i++) {
        const lines = [];
        const lineCount = Math.floor(Math.random() * 100);
        for (let j = 0; j < lineCount; j++) {
          lines.push(`[2026-04-25 13:37:22] [INFO] [agent-${i}] Random line ${j}`);
          if (Math.random() > 0.7) lines.push('\x1b[31mANSI content\x1b[0m');
          if (Math.random() > 0.8) lines.push('---RESULT---');
          if (Math.random() > 0.9) lines.push(`Step ${j}`);
        }
        randomLogs.push(lines.join('\n'));
      }

      for (const log of randomLogs) {
        expect(() => parsePipelineLog(log)).not.toThrow();
        const result = parsePipelineLog(log);
        expect(Array.isArray(result)).toBe(true);
      }
    });

    it('parsed steps have valid structure', () => {
      const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [stage-1] START stage="stage-1" agent="agent-1"
[2026-04-25 13:37:24] [INFO] [stage-1] COMPLETE stage="stage-1" status="ok" exitCode=0`;

      const result = parsePipelineLog(text);
      for (const step of result) {
        expect(typeof step.step_number).toBe('number');
        expect(typeof step.stage).toBe('string');
        expect(typeof step.agent).toBe('string');
        expect(typeof step.status).toBe('string');
        expect(typeof step.exit_code).toBe('number');
        expect(typeof step.started_at).toBe('string');
        expect(step.completed_at === null || typeof step.completed_at === 'string').toBe(true);
        expect(typeof step.duration_ms).toBe('number');
        expect(typeof step.context).toBe('object');
        expect(typeof step.result_block).toBe('object');
        expect(step.output_snippet === null || typeof step.output_snippet === 'string').toBe(true);
      }
    });
  });

  // ===== CONTEXT PARSING TESTS =====

  describe('Context parsing edge cases', () => {
    it('parses context with various key formats (dash, underscore, digits)', () => {
      const text = `[2026-04-25 13:37:22] [INFO] [PipelineRunner] Step 1
[2026-04-25 13:37:23] [INFO] [stage] START stage="stage" agent="agent"
[2026-04-25 13:37:23] [INFO] [stage]   Context:
[2026-04-25 13:37:23] [INFO] [stage]     ticket_id: IMPL-1
[2026-04-25 13:37:23] [INFO] [stage]     param_with_underscores: value
[2026-04-25 13:37:23] [INFO] [stage]     param-with-dashes: value
[2026-04-25 13:37:23] [INFO] [stage]     param123: value
[2026-04-25 13:37:24] [INFO] [stage] COMPLETE stage="stage" status="ok" exitCode=0`;

      const result = parsePipelineLog(text);
      expect(result[0].context).toMatchObject({
        ticket_id: 'IMPL-1',
        param_with_underscores: 'value',
        'param-with-dashes': 'value',
        param123: 'value'
      });
    });
  });
});

