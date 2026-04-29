import { describe, it, expect } from 'vitest';
import { parseSkillTestsOutput, extractOutputExcerpt } from '../skill-tests-output.mjs';

describe('parseSkillTestsOutput', () => {
  it('returns empty summary when RESULT block is missing', () => {
    const stdout = 'Some output without RESULT block';
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'test-skill');

    expect(result).toEqual({
      skill_name: 'test-skill',
      summary: {
        pass: 0,
        fail: 0,
        skipped: 0,
        total: 0
      },
      results: []
    });
  });

  it('parses summary from RESULT block with passed, failed, skipped counts', () => {
    const stdout = `
Some test output here
---RESULT---
current_run.passed: 5
current_run.failed: 2
current_run.no_coverage: 1
---RESULT---
More output after
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.skill_name).toBe('coach');
    expect(result.summary).toEqual({
      pass: 5,
      fail: 2,
      skipped: 1,
      total: 8
    });
  });

  it('parses individual test results from stdout', () => {
    const stdout = `
TC-COACH-001: passed
TC-COACH-002: failed: Error in test
---RESULT---
current_run.passed: 1
current_run.failed: 1
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results).toHaveLength(2);
    expect(result.results).toContainEqual(expect.objectContaining({
      test_id: 'TC-COACH-001',
      verdict: 'passed'
    }));
    expect(result.results).toContainEqual(expect.objectContaining({
      test_id: 'TC-COACH-002',
      verdict: 'failed',
      output_excerpt: 'Error in test'
    }));
  });

  it('parses test results from stderr', () => {
    const stdout = `
---RESULT---
current_run.passed: 1
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = 'TC-EXECUTE-001: passed';
    const result = parseSkillTestsOutput(stdout, stderr, 'execute-task');

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      test_id: 'TC-EXECUTE-001',
      verdict: 'passed'
    });
  });

  it('converts error verdict to fail', () => {
    const stdout = `
TC-COACH-001: error: Something went wrong
---RESULT---
current_run.passed: 0
current_run.failed: 1
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results[0]).toMatchObject({
      test_id: 'TC-COACH-001',
      verdict: 'fail',
      output_excerpt: 'Something went wrong'
    });
  });

  it('parses skipped test results', () => {
    const stdout = `
TC-COACH-001: skipped
---RESULT---
current_run.passed: 0
current_run.failed: 0
current_run.no_coverage: 1
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results[0]).toMatchObject({
      test_id: 'TC-COACH-001',
      verdict: 'skipped'
    });
  });

  it('handles equals sign instead of colon in test verdict', () => {
    const stdout = `
TC-COACH-001 = passed
---RESULT---
current_run.passed: 1
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results).toHaveLength(1);
    expect(result.results[0].test_id).toBe('TC-COACH-001');
  });

  it('handles test IDs with multiple dashes and numbers', () => {
    const stdout = `
TC-COACH-001-A: passed
TC-DECOMPOSE-PLAN-005: failed
TC-EXECUTE-TASK-001: passed
---RESULT---
current_run.passed: 2
current_run.failed: 1
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'multi-test');

    expect(result.results).toHaveLength(3);
    expect(result.results.map(r => r.test_id)).toContain('TC-COACH-001-A');
    expect(result.results.map(r => r.test_id)).toContain('TC-DECOMPOSE-PLAN-005');
    expect(result.results.map(r => r.test_id)).toContain('TC-EXECUTE-TASK-001');
  });

  it('deduplicates test results (first occurrence wins)', () => {
    const stdout = `
TC-COACH-001: passed
TC-COACH-001: failed: duplicate should be ignored
---RESULT---
current_run.passed: 1
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results).toHaveLength(1);
    expect(result.results[0].verdict).toBe('passed');
  });

  it('handles RESULT block with no spacing', () => {
    const stdout = `---RESULT---
current_run.passed:3
current_run.failed:1
current_run.no_coverage:0
---RESULT---`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.summary).toEqual({
      pass: 3,
      fail: 1,
      skipped: 0,
      total: 4
    });
  });

  it('handles partial summary (missing counts)', () => {
    const stdout = `
---RESULT---
current_run.passed: 5
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.summary).toEqual({
      pass: 5,
      fail: 0,
      skipped: 0,
      total: 5
    });
  });

  it('handles non-integer values in summary gracefully', () => {
    const stdout = `
---RESULT---
current_run.passed: abc
current_run.failed: 2
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.summary.pass).toBe(0); // parseInt('abc') returns NaN, which becomes 0
    expect(result.summary.fail).toBe(2);
  });

  it('parses test results with multiline output excerpts', () => {
    const stdout = `
TC-COACH-001: failed: Line 1
of error message
TC-COACH-002: passed
---RESULT---
current_run.passed: 1
current_run.failed: 1
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results).toHaveLength(2);
    expect(result.results[0].output_excerpt).toBe('Line 1');
  });

  it('handles output with RESULT block at the beginning', () => {
    const stdout = `---RESULT---
current_run.passed: 2
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
TC-COACH-001: passed
TC-COACH-002: passed`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.summary.total).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it('handles multiple RESULT blocks (parses first one)', () => {
    const stdout = `---RESULT---
current_run.passed: 5
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
Some other output
---RESULT---
current_run.passed: 10
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    // Should parse the first RESULT block
    expect(result.summary.pass).toBe(5);
  });

  it('sets duration_ms to 0 by default', () => {
    const stdout = `
TC-COACH-001: passed
---RESULT---
current_run.passed: 1
current_run.failed: 0
current_run.no_coverage: 0
---RESULT---
`;
    const stderr = '';
    const result = parseSkillTestsOutput(stdout, stderr, 'coach');

    expect(result.results[0].duration_ms).toBe(0);
  });
});

describe('extractOutputExcerpt', () => {
  it('returns all lines when fewer than lineCount provided', () => {
    const output = 'Line 1\nLine 2\nLine 3';
    const result = extractOutputExcerpt(output, 10);

    expect(result).toBe(output);
  });

  it('returns last N lines when output is longer', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
    const result = extractOutputExcerpt(lines, 10);
    const resultLines = result.split('\n');

    expect(resultLines).toHaveLength(10);
    expect(resultLines[0]).toBe('Line 91');
    expect(resultLines[9]).toBe('Line 100');
  });

  it('uses default lineCount of 50', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
    const result = extractOutputExcerpt(lines);
    const resultLines = result.split('\n');

    expect(resultLines).toHaveLength(50);
    expect(resultLines[0]).toBe('Line 51');
  });

  it('handles empty output', () => {
    const result = extractOutputExcerpt('', 10);
    expect(result).toBe('');
  });

  it('handles single line output', () => {
    const result = extractOutputExcerpt('Single line', 10);
    expect(result).toBe('Single line');
  });

  it('handles lineCount of 0', () => {
    const output = 'Line 1\nLine 2\nLine 3';
    const result = extractOutputExcerpt(output, 0);
    expect(result).toBe('');
  });

  it('handles lineCount of 1', () => {
    const output = 'Line 1\nLine 2\nLine 3';
    const result = extractOutputExcerpt(output, 1);
    expect(result).toBe('Line 3');
  });

  it('preserves whitespace in output lines', () => {
    const output = '  Indented line 1\n\tTabbed line 2\nNormal line 3';
    const result = extractOutputExcerpt(output, 10);
    expect(result).toBe(output);
  });

  it('handles output with trailing newline', () => {
    const output = 'Line 1\nLine 2\nLine 3\n';
    const result = extractOutputExcerpt(output, 2);

    // Result is last 2 lines: 'Line 3\n'
    expect(result).toBe('Line 3\n');
  });
});
