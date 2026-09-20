/**
 * `list_skill_tests` и формат `tests/index.yaml`.
 *
 * Канонический индекс в workflowAi (`src/skills/*\/tests/index.yaml`) имеет
 * форму `cases:` с полями id/file/tags/severity. Схема здесь была написана под
 * другую, более раннюю форму — `tests:` с test_id/description/expected_verdict,
 * — и валидация молча отбрасывала каждый скил канона: инструмент отдавал `[]`
 * для всех десяти, а предупреждение уходило в stderr, которого никто не читает.
 * Поддерживаются обе формы; эти тесты держат обе.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { list_skill_tests } from '../../src/tools/coach.mjs';

let workspace;
let prevCwd;

/** Создаёт проект со скилом и его `tests/index.yaml`. */
function createSkill(projectName, skillName, indexYaml) {
  const projectPath = path.join(workspace, projectName);
  const skillDir = path.join(projectPath, '.workflow', 'src', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  if (indexYaml !== null) {
    const testsDir = path.join(skillDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'index.yaml'), indexYaml, 'utf-8');
  }
  return projectPath;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tests-index-'));
  prevCwd = process.env.MCP_CWD;
  process.env.MCP_CWD = workspace;
});

afterEach(() => {
  if (prevCwd === undefined) delete process.env.MCP_CWD;
  else process.env.MCP_CWD = prevCwd;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('list_skill_tests: канонический index.yaml (cases:)', () => {
  const CANON = `version: 1
skill: coach
execution:
  target_agents:
    - claude-sonnet
  judge_agent: claude-opus
cases:
  - id: TC-COACH-001
    file: cases/TC-COACH-001-evidence-based.yaml
    origin_chg: [CHG-032]
    tags: [evidence-based, log-analysis]
    severity: critical
  - id: TC-COACH-002
    file: cases/TC-COACH-002-root-cause-first.yaml
    tags: [root-cause]
    severity: major
`;

  it('возвращает кейсы канонического индекса, а не пустой список', async () => {
    createSkill('proj', 'coach', CANON);

    const result = await list_skill_tests.execute({ project: 'proj', skill_name: 'coach' });
    const cases = result.tests;

    expect(result.error).toBeUndefined();
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.test_id)).toEqual(['TC-COACH-001', 'TC-COACH-002']);
  });

  it('раскладывает поля канона по выходному контракту', async () => {
    createSkill('proj', 'coach', CANON);

    const [first] = (await list_skill_tests.execute({ project: 'proj', skill_name: 'coach' })).tests;

    expect(first).toEqual({
      skill_name: 'coach',
      test_id: 'TC-COACH-001',
      // Описания и вердикта в индексе нет — они внутри файла кейса.
      description: null,
      expected_verdict: null,
      source_path: 'cases/TC-COACH-001-evidence-based.yaml',
      tags: ['evidence-based', 'log-analysis'],
      severity: 'critical'
    });
  });

  it('собирает кейсы по всем скилам, когда skill_name не задан', async () => {
    createSkill('proj', 'coach', CANON);
    createSkill('proj', 'review-result', `version: 1
cases:
  - id: TC-RR-001
    file: cases/TC-RR-001.yaml
`);

    const cases = (await list_skill_tests.execute({ project: 'proj' })).tests;

    expect(cases.map((c) => c.test_id).sort()).toEqual(['TC-COACH-001', 'TC-COACH-002', 'TC-RR-001']);
    expect(new Set(cases.map((c) => c.skill_name))).toEqual(new Set(['coach', 'review-result']));
  });
});

describe('list_skill_tests: прежний формат (tests:)', () => {
  const LEGACY = `tests:
  - test_id: TC-OLD-001
    description: Старый формат всё ещё читается
    expected_verdict: pass
    source_path: cases/old.yaml
`;

  it('продолжает читаться без изменений', async () => {
    createSkill('proj', 'coach', LEGACY);

    const [only] = (await list_skill_tests.execute({ project: 'proj', skill_name: 'coach' })).tests;

    expect(only).toEqual({
      skill_name: 'coach',
      test_id: 'TC-OLD-001',
      description: 'Старый формат всё ещё читается',
      expected_verdict: 'pass',
      source_path: 'cases/old.yaml',
      tags: null,
      severity: null
    });
  });
});

describe('list_skill_tests: устойчивость', () => {
  it('скил без index.yaml даёт предупреждение, а не падение', async () => {
    createSkill('proj', 'coach', null);

    const result = await list_skill_tests.execute({ project: 'proj', skill_name: 'coach' });

    expect(result.error).toBeUndefined();
    expect(result.tests).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/No index\.yaml/);
  });

  it('индекс неизвестной формы не роняет остальные скилы', async () => {
    createSkill('proj', 'coach', 'какая-то: ерунда\n');
    createSkill('proj', 'review-result', `cases:
  - id: TC-RR-001
`);

    const cases = (await list_skill_tests.execute({ project: 'proj' })).tests;

    expect(cases.map((c) => c.test_id)).toEqual(['TC-RR-001']);
  });
});
