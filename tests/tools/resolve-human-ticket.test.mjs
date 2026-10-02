import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { workflowAiRoot } from '../../src/lib/workflow-ai.mjs';
import {
  resolve_human_ticket, list_human_queue, get_human_context_tool, resolve_human_ticket_tool, TICKET_TRANSITIONS
} from '../../src/tools/human.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { moveTicket } from 'workflow-ai/lib/operations/tickets.mjs';
import { invalidate as invalidateCache } from '../../src/caches/frontmatter-cache.mjs';

let testDir = null;
let projectPath = null;
const originalCwd = process.cwd();

beforeEach(() => {
  // Create temporary directory for test fixtures
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-resolve-test-'));
  projectPath = path.join(testDir, 'test-project');

  // Create project directory with workflow structure
  fs.mkdirSync(projectPath);
  const workflowDir = path.join(projectPath, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');

  // Create all status directories
  const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];
  for (const status of statuses) {
    fs.mkdirSync(path.join(ticketsDir, status), { recursive: true });
  }

  // Change to test directory for relative path resolution
  process.chdir(testDir);
});

afterEach(() => {
  // Restore original working directory
  process.chdir(originalCwd);

  // Clean up test fixture
  if (testDir && fs.existsSync(testDir)) {
    // Invalidate cache entries
    const ticketsDir = path.join(projectPath, '.workflow', 'tickets');
    if (fs.existsSync(ticketsDir)) {
      const walkDir = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            walkDir(filePath);
          } else if (file.endsWith('.md')) {
            invalidateCache(filePath);
          }
        }
      };
      walkDir(ticketsDir);
    }

    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Helper: Create a ticket file with frontmatter and body
 */
function createTicket(status, ticketId, options = {}) {
  const {
    type = 'human',
    title = `Test ${ticketId}`,
    priority = 1,
    dependencies = [],
    parent_plan = ''
  } = options;

  let frontmatter = `---
id: ${ticketId}
type: ${type}
title: "${title}"
priority: ${priority}
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
completed_at: ""
`;

  if (dependencies.length > 0) {
    frontmatter += `dependencies:\n`;
    for (const dep of dependencies) {
      frontmatter += `  - ${dep}\n`;
    }
  }

  if (parent_plan) {
    frontmatter += `parent_plan: "${parent_plan}"\n`;
  }

  frontmatter += '---';

  const body = `## Описание

Тестовый тикет ${ticketId}
`;

  const ticketPath = path.join(projectPath, '.workflow', 'tickets', status, `${ticketId}.md`);
  fs.writeFileSync(ticketPath, frontmatter + '\n' + body);
  return ticketPath;
}

describe('resolve_human_ticket', () => {
  describe('Core functionality', () => {
    it('should resolve a HUMAN ticket in review status and move it to done/', async () => {
      // Setup: Create a HUMAN ticket in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-1', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-1',
        decision: 'approved',
        result_body: '## Решение\n\nТикет одобрен и выполнен.'
      });

      // Assert: Return value contains expected fields
      expect(result.id).toBe('HUMAN-1');
      expect(result.new_status).toBe('done');

      // Assert: Ticket is now in done/
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-1.md');
      expect(fs.existsSync(donePath)).toBe(true);

      // Assert: Original location is empty
      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-1.md');
      expect(fs.existsSync(reviewPath)).toBe(false);
    });

    it('should add completed_at and resolution to frontmatter when resolved', async () => {
      // Setup: Create a HUMAN ticket in in-progress/ (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-2', { type: 'human' });

      // Act: Resolve the ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-2',
        decision: 'rejected',
        result_body: '## Причина отклонения\n\nТикет не соответствует требованиям.'
      });

      // Assert: Check frontmatter contains review_log
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-2.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter.review_log).toBeDefined();
      expect(Array.isArray(frontmatter.review_log)).toBe(true);
      expect(frontmatter.review_log[0]).toMatchObject({
        action: 'resolved',
        decision: 'rejected'
      });
      expect(frontmatter.review_log[0].date).toBeDefined();
    });

    it('should add Result section to ticket body when resolved', async () => {
      // Setup: Create a HUMAN ticket in in-progress/ (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-3', { type: 'human' });

      // Act: Resolve the ticket
      const resultBody = '## Детали решения\n\nВсе критерии выполнены успешно.';
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-3',
        decision: 'approved',
        result_body: resultBody
      });

      // Assert: Check that ticket has review_log entry with the decision
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-3.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Verify the decision is recorded in review_log
      expect(frontmatter.review_log).toBeDefined();
      expect(frontmatter.review_log[0].decision).toBe('approved');
      expect(frontmatter.review_log[0].action).toBe('resolved');

      // Verify the ticket was moved to done/
      expect(fs.existsSync(donePath)).toBe(true);
    });
  });

  // ListeningGlass HUMAN-001, 2026-09-30: результат дописывался секцией в конец, штатная
  // «## Результат выполнения» оставалась пустой, DoD — без отметок, и verify-artifacts
  // отклонял сданную работу (result_filled=false, dod_completion_pct=0).
  describe('Ticket template', () => {
    function createTemplateTicket(status, ticketId) {
      const content = `---
id: ${ticketId}
type: human
title: "Test ${ticketId}"
priority: 1
---
## Описание

Проверка на устройстве

## Критерии готовности (Definition of Done)

- [ ] В RESULT.md записан результат
  - check: \`git grep -q --untracked "Результат:" -- RESULT.md\`, expect: \`exit 0\`
- [ ] Записана версия браузера

---

## Результат выполнения

### Summary

### Изменённые файлы

### Время выполнения

- Started:
- Completed:

## История работы
| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
`;
      const ticketPath = path.join(projectPath, '.workflow', 'tickets', status, `${ticketId}.md`);
      fs.writeFileSync(ticketPath, content);
      return ticketPath;
    }

    function section(body, heading) {
      const start = body.indexOf(heading) + heading.length;
      const next = body.indexOf('\n## ', start);
      return body.substring(start, next === -1 ? body.length : next);
    }

    it('fills the template result section instead of appending a second one', async () => {
      createTemplateTicket('ready', 'HUMAN-T1');

      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-T1',
        decision: 'оба пути работают',
        result_body: '### Summary\n\nПроверено на телефоне.\n\n### Изменённые файлы\n\n- `RESULT.md`',
        next_status: 'review'
      });

      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-T1.md');
      expect(result.path).toBe(reviewPath);
      const { body } = parseFrontmatter(fs.readFileSync(reviewPath, 'utf8'));

      expect(body.match(/^##[ \t]*(Результат выполнения|Результат|Result)[ \t]*$/gm)).toEqual(['## Результат выполнения']);
      const resultSection = section(body, '## Результат выполнения');
      expect(resultSection).toContain('**Решение:** оба пути работают');
      expect(resultSection).toContain('Проверено на телефоне.');
      expect(resultSection).not.toContain('- Started:');
      expect(body).toContain('## История работы');
    });

    it('ticks DoD items when moving to review', async () => {
      createTemplateTicket('ready', 'HUMAN-T2');

      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-T2',
        decision: 'done',
        result_body: 'Проверено.',
        next_status: 'review'
      });

      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-T2.md');
      const dod = section(fs.readFileSync(reviewPath, 'utf8'), '## Критерии готовности (Definition of Done)');
      expect(dod.match(/\[x\]/g)).toHaveLength(2);
      expect(dod).not.toContain('[ ]');
      expect(dod).toContain('- check: `git grep');
    });

    it('leaves DoD items unticked when the ticket is blocked', async () => {
      createTemplateTicket('in-progress', 'HUMAN-T3');

      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-T3',
        decision: 'нет телефона',
        result_body: 'Проверка не проведена.',
        next_status: 'blocked'
      });

      const blockedPath = path.join(projectPath, '.workflow', 'tickets', 'blocked', 'HUMAN-T3.md');
      const content = fs.readFileSync(blockedPath, 'utf8');
      expect(section(content, '## Критерии готовности (Definition of Done)').match(/\[ \]/g)).toHaveLength(2);
      expect(section(content, '## Результат выполнения')).toContain('Проверка не проведена.');
    });

    // Безусловная отметка закрыла ListeningGlass HUMAN-002 (2026-09-30) с обоими пунктами
    // «записан результат по каждому сайту и сценарию» отмеченными, хотя в решении сказано
    // «youtube-nocookie и 70-минутный сценарий не проверены». Параметр dod_confirmed лечит
    // это, но вызовы без него работают как прежде: сервер обновляется раньше клиентов.
    describe('DoD confirmation', () => {
      const DOD_HEADING = '## Критерии готовности (Definition of Done)';
      const ticketFile = (status, id) => path.join(projectPath, '.workflow', 'tickets', status, `${id}.md`);
      const dodOf = (file) => section(fs.readFileSync(file, 'utf8'), DOD_HEADING);
      const resolveTo = (id, extra) => resolve_human_ticket({
        project: 'test-project',
        ticket_id: id,
        decision: 'проверено частично',
        result_body: 'Часть проверена.',
        next_status: 'review',
        ...extra
      });
      const tickOne = (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ]', '- [x]'));

      /** Тикет с DoD из заданных строк; секция результата — ниже DoD (как в шаблоне) или выше. */
      function createCustomTicket(status, id, { dod, resultFirst = false }) {
        const result = '## Результат выполнения\n\n### Summary\n\n';
        const dodSection = `## Критерии готовности (Definition of Done)\n\n${dod.join('\n')}\n\n`;
        fs.writeFileSync(
          ticketFile(status, id),
          `---\nid: ${id}\ntype: human\ntitle: "Test ${id}"\npriority: 1\n---\n## Описание\n\nПроверка\n\n`
          + `${resultFirst ? result + dodSection : dodSection + result}## История работы\n`
        );
      }
      const DOD_H2 = /^## Критерии готовности \(Definition of Done\)$/m;
      /** Настоящая секция DoD: по строке-заголовку H2, а не по подстроке — «###» содержит её же. */
      function realDodOf(file) {
        const text = fs.readFileSync(file, 'utf8');
        const at = text.search(DOD_H2);
        const end = text.indexOf('\n## ', at + 1);
        return text.slice(at, end === -1 ? undefined : end);
      }

      /** Отказ не должен ни сдвинуть тикет, ни изменить его, ни оставить .lock. */
      async function expectRefusedUntouched(id, extra, pattern) {
        const file = ticketFile('ready', id);
        const before = fs.readFileSync(file, 'utf8');
        // Отказ — до захвата lock'а: файл тикета не переименовывают даже на время.
        const rename = vi.spyOn(fs, 'renameSync');
        try {
          await expect(resolveTo(id, extra)).rejects.toThrow(pattern);
          expect(rename).not.toHaveBeenCalled();
        } finally {
          rename.mockRestore();
        }
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
        expect(fs.existsSync(ticketFile('review', id))).toBe(false);
        expect(fs.existsSync(ticketFile('done', id))).toBe(false);
      }

      describe('without dod_confirmed (the behavior before the parameter)', () => {
        it('review ticks every item and the answer has no dod_unticked', async () => {
          createTemplateTicket('ready', 'HUMAN-L1');

          const result = await resolveTo('HUMAN-L1', {});

          const dod = dodOf(ticketFile('review', 'HUMAN-L1'));
          expect(dod.match(/\[x\]/g)).toHaveLength(2);
          expect(dod).not.toContain('[ ]');
          expect(result.new_status).toBe('review');
          expect(result).not.toHaveProperty('dod_unticked');
        });

        it('done, the default status, ticks every item too', async () => {
          createTemplateTicket('in-progress', 'HUMAN-L2');

          const result = await resolve_human_ticket({
            project: 'test-project', ticket_id: 'HUMAN-L2', decision: 'ok', result_body: 'Готово.'
          });

          const dod = dodOf(ticketFile('done', 'HUMAN-L2'));
          expect(dod.match(/\[x\]/g)).toHaveLength(2);
          expect(dod).not.toContain('[ ]');
          expect(result.new_status).toBe('done');
          expect(result).not.toHaveProperty('dod_unticked');
        });

        it('null is the same as omitted, and an already ticked item stays ticked', async () => {
          const file = createTemplateTicket('ready', 'HUMAN-L3');
          tickOne(file);

          await resolveTo('HUMAN-L3', { dod_confirmed: null });

          const dod = dodOf(ticketFile('review', 'HUMAN-L3'));
          expect(dod.match(/\[x\]/g)).toHaveLength(2);
          expect(dod).not.toContain('[ ]');
        });

        it('a ticket without a DoD section is resolved as before', async () => {
          createTicket('review', 'HUMAN-L4', { type: 'human' });

          const result = await resolve_human_ticket({
            project: 'test-project', ticket_id: 'HUMAN-L4', decision: 'ok', result_body: 'Готово.'
          });

          expect(result.new_status).toBe('done');
          expect(fs.existsSync(ticketFile('done', 'HUMAN-L4'))).toBe(true);
        });
      });

      describe('with dod_confirmed', () => {
        // Частично подтверждённую работу сдают не в review/done: подтверждённые пункты
        // отмечаются и при других статусах, остальные остаются неотмеченными.
        const resolveToBlocked = (id, extra) => resolveTo(id, { next_status: 'blocked', ...extra });

        it('ticks only the confirmed items and reports the rest', async () => {
          createTemplateTicket('in-progress', 'HUMAN-D1');

          const result = await resolveToBlocked('HUMAN-D1', { dod_confirmed: [1] });

          const dod = dodOf(ticketFile('blocked', 'HUMAN-D1'));
          expect(dod).toContain('- [x] В RESULT.md записан результат');
          expect(dod).toContain('- [ ] Записана версия браузера');
          expect(dod.match(/\[x\]/g)).toHaveLength(1);
          expect(result.dod_unticked).toEqual(['Записана версия браузера']);
        });

        it('finds an item by its text, ignoring case, and by a unique substring', async () => {
          createTemplateTicket('in-progress', 'HUMAN-D2');
          createTemplateTicket('in-progress', 'HUMAN-D2b');

          await resolveToBlocked('HUMAN-D2', { dod_confirmed: ['ЗАПИСАНА   версия Браузера'] });
          await resolveToBlocked('HUMAN-D2b', { dod_confirmed: ['RESULT.md'] });

          expect(dodOf(ticketFile('blocked', 'HUMAN-D2'))).toMatch(/- \[ \] В RESULT\.md[^\n]*\n[\s\S]*- \[x\] Записана версия браузера/);
          const second = dodOf(ticketFile('blocked', 'HUMAN-D2b'));
          expect(second).toContain('- [x] В RESULT.md записан результат');
          expect(second).toContain('- [ ] Записана версия браузера');
        });

        it('accepts item numbers passed as digit strings', async () => {
          createTemplateTicket('in-progress', 'HUMAN-D3');

          await resolveToBlocked('HUMAN-D3', { dod_confirmed: ['2'] });

          const dod = dodOf(ticketFile('blocked', 'HUMAN-D3'));
          expect(dod).toContain('- [ ] В RESULT.md записан результат');
          expect(dod).toContain('- [x] Записана версия браузера');
        });

        it('refuses an unknown or ambiguous reference and leaves the ticket untouched', async () => {
          createTemplateTicket('ready', 'HUMAN-D4');

          await expectRefusedUntouched('HUMAN-D4', { dod_confirmed: [3] }, /DOD_ITEM_NOT_FOUND/);
          await expectRefusedUntouched('HUMAN-D4', { dod_confirmed: ['нет такого пункта'] }, /DOD_ITEM_NOT_FOUND/);
          // «записан» входит в оба пункта: «записан результат» и «Записана версия».
          await expectRefusedUntouched('HUMAN-D4', { dod_confirmed: ['записан'] }, /DOD_ITEM_AMBIGUOUS/);
        });

        it('refuses review while an item is neither ticked nor confirmed, and names the unconfirmed ones', async () => {
          createTemplateTicket('ready', 'HUMAN-D5');

          await expectRefusedUntouched(
            'HUMAN-D5',
            { dod_confirmed: [1] },
            /DOD_NOT_CONFIRMED[\s\S]*another next_status[\s\S]*Unconfirmed: "Записана версия браузера"\. /
          );
          // Подтверждённый пункт в «Unconfirmed» не попадает.
          const error = await resolveTo('HUMAN-D5', { dod_confirmed: [1] }).catch((e) => e);
          expect(error.message).toMatch(/Unconfirmed: "Записана версия браузера"\. DoD items: 1\) В RESULT\.md/);
        });

        it('an empty dod_confirmed confirms nothing: review is refused, blocked ticks nothing', async () => {
          createTemplateTicket('ready', 'HUMAN-D6');
          createTemplateTicket('in-progress', 'HUMAN-D6b');

          await expectRefusedUntouched('HUMAN-D6', { dod_confirmed: [] }, /DOD_NOT_CONFIRMED/);
          const result = await resolveToBlocked('HUMAN-D6b', { dod_confirmed: [] });

          const dod = dodOf(ticketFile('blocked', 'HUMAN-D6b'));
          expect(dod.match(/\[ \]/g)).toHaveLength(2);
          expect(dod).not.toContain('[x]');
          expect(result.dod_unticked).toHaveLength(2);
        });

        it('refuses done, the default status, in the same way', async () => {
          createTemplateTicket('ready', 'HUMAN-D5b');
          const file = ticketFile('ready', 'HUMAN-D5b');
          const before = fs.readFileSync(file, 'utf8');

          await expect(resolve_human_ticket({
            project: 'test-project', ticket_id: 'HUMAN-D5b', decision: 'ok', result_body: 'Готово.', dod_confirmed: [2]
          })).rejects.toThrow(/DOD_NOT_CONFIRMED.*moving HUMAN-D5b to done/);

          expect(fs.readFileSync(file, 'utf8')).toBe(before);
          expect(fs.existsSync(ticketFile('done', 'HUMAN-D5b'))).toBe(false);
        });

        it('moves to review when every item is confirmed, by number or by text', async () => {
          createTemplateTicket('ready', 'HUMAN-D11');

          const result = await resolveTo('HUMAN-D11', { dod_confirmed: [1, 'записана версия'] });

          const dod = dodOf(ticketFile('review', 'HUMAN-D11'));
          expect(dod.match(/\[x\]/g)).toHaveLength(2);
          expect(dod).not.toContain('[ ]');
          expect(result.new_status).toBe('review');
          expect(result).not.toHaveProperty('dod_unticked');
        });

        it('does not require listing items that are already ticked', async () => {
          const file = createTemplateTicket('ready', 'HUMAN-D12');
          tickOne(file);

          const result = await resolveTo('HUMAN-D12', { dod_confirmed: [2] });

          expect(result.new_status).toBe('review');
          expect(dodOf(ticketFile('review', 'HUMAN-D12')).match(/\[x\]/g)).toHaveLength(2);
        });

        it('needs no confirmation when every item is already ticked, even with an empty list', async () => {
          const file = createTemplateTicket('ready', 'HUMAN-D7');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'));

          const result = await resolveTo('HUMAN-D7', { dod_confirmed: [] });

          expect(result.new_status).toBe('review');
          expect(result).not.toHaveProperty('dod_unticked');
        });

        it('ticks the confirmed items at blocked and leaves the rest when there is no list', async () => {
          createTemplateTicket('in-progress', 'HUMAN-D8');
          createTemplateTicket('in-progress', 'HUMAN-D8b');

          await resolveToBlocked('HUMAN-D8', { dod_confirmed: [2] });
          const withoutList = await resolveToBlocked('HUMAN-D8b', {});

          const blocked = dodOf(ticketFile('blocked', 'HUMAN-D8'));
          expect(blocked).toContain('- [ ] В RESULT.md записан результат');
          expect(blocked).toContain('- [x] Записана версия браузера');
          expect(dodOf(ticketFile('blocked', 'HUMAN-D8b')).match(/\[ \]/g)).toHaveLength(2);
          // Без списка ответ прежний: поле dod_unticked появляется только вместе с dod_confirmed.
          expect(withoutList).not.toHaveProperty('dod_unticked');
        });

        it('refuses a dod_confirmed that is not a list, so "all" cannot tick everything by accident', async () => {
          createTemplateTicket('ready', 'HUMAN-D10');

          await expectRefusedUntouched('HUMAN-D10', { dod_confirmed: 'all' }, /DOD_CONFIRMED_INVALID/);
        });

        it('refuses dod_confirmed for a ticket that has no DoD section', async () => {
          createTicket('review', 'HUMAN-D9', { type: 'human' });

          await expect(resolve_human_ticket({
            project: 'test-project', ticket_id: 'HUMAN-D9', decision: 'ok', result_body: 'Готово.', dod_confirmed: [1]
          })).rejects.toThrow(/DOD_ITEM_NOT_FOUND.*no DoD section/);
          expect(fs.existsSync(ticketFile('review', 'HUMAN-D9'))).toBe(true);
        });

        // Тикет человека ждёт в ready, а по таблице переходов workflow-ai из ready можно только
        // в in-progress, review и backlog: «сдайте в blocked» вело бы в отказ move_ticket, а
        // in-progress пайплайн считает работой агента (pick-next-task не различает типы тикетов).
        it('offers only statuses reachable from the current one, never in-progress', async () => {
          createTemplateTicket('ready', 'HUMAN-P1');
          createTemplateTicket('in-progress', 'HUMAN-P2');
          createTemplateTicket('review', 'HUMAN-P3');
          createTemplateTicket('backlog', 'HUMAN-P4');

          const hint = async (id) => (await resolveTo(id, { dod_confirmed: [1] }).catch((e) => e)).message;

          expect(await hint('HUMAN-P1')).toMatch(/another next_status reachable from ready \(backlog\) and say what is left/);
          expect(await hint('HUMAN-P2')).toMatch(/another next_status reachable from in-progress \(blocked\) and say what is left/);
          expect(await hint('HUMAN-P3')).toMatch(/another next_status reachable from review \(ready, blocked\) and say what is left/);
          expect(await hint('HUMAN-P4')).toMatch(/another next_status reachable from backlog \(ready, blocked\) and say what is left/);
        });

        it('a partial hand-over from ready, the way the hint says, lands in backlog with the confirmed item ticked', async () => {
          createTemplateTicket('ready', 'HUMAN-P5');

          const result = await resolveTo('HUMAN-P5', { dod_confirmed: [1], next_status: 'backlog' });

          expect(result.new_status).toBe('backlog');
          expect(result.dod_unticked).toEqual(['Записана версия браузера']);
          const dod = dodOf(ticketFile('backlog', 'HUMAN-P5'));
          expect(dod).toContain('- [x] В RESULT.md записан результат');
          expect(dod).toContain('- [ ] Записана версия браузера');
          expect(fs.existsSync(ticketFile('ready', 'HUMAN-P5'))).toBe(false);
        });

        it('refuses a transition the board does not allow before taking the lock, and lists the allowed ones', async () => {
          createTemplateTicket('ready', 'HUMAN-P6');
          const file = ticketFile('ready', 'HUMAN-P6');
          const before = fs.readFileSync(file, 'utf8');
          const calls = [
            ['blocked', () => resolveToBlocked('HUMAN-P6', { dod_confirmed: [1] })],
            // done — статус по умолчанию; из ready в него тоже нельзя
            ['done', () => resolve_human_ticket({ project: 'test-project', ticket_id: 'HUMAN-P6', decision: 'ok', result_body: 'Готово.' })]
          ];

          const rename = vi.spyOn(fs, 'renameSync');
          try {
            for (const [target, call] of calls) {
              const error = await call().catch((e) => e);
              expect(error.code).toBe('INVALID_TRANSITION');
              expect(error.message).toBe(
                `Invalid transition for HUMAN-P6: ready → ${target}. From ready the ticket can move to: in-progress, review, backlog `
                + '(not in-progress: the pipeline takes a human ticket there for agent work)'
              );
            }
            expect(rename).not.toHaveBeenCalled();
          } finally {
            rename.mockRestore();
          }
          expect(fs.readFileSync(file, 'utf8')).toBe(before);
          expect(fs.existsSync(`${file}.lock`)).toBe(false);
          expect(fs.existsSync(ticketFile('blocked', 'HUMAN-P6'))).toBe(false);
          expect(fs.existsSync(ticketFile('done', 'HUMAN-P6'))).toBe(false);
        });

        // Пустая ссылка после нормализации — подстрока любого пункта. Ссылка из пробелов проходила
        // схему и молча подтверждала единственный пункт DoD, ничего не называя.
        it('refuses a blank or non-text reference instead of matching every item', async () => {
          const file = createTemplateTicket('ready', 'HUMAN-B1');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ] Записана версия браузера\n', ''));
          expect(dodOf(file).match(/\[ \]/g)).toHaveLength(1);

          for (const ref of ['   ', '', ' \t ']) {
            await expectRefusedUntouched('HUMAN-B1', { dod_confirmed: [ref] }, /DOD_CONFIRMED_INVALID/);
          }
          await expectRefusedUntouched('HUMAN-B1', { dod_confirmed: [1, '  '] }, /DOD_CONFIRMED_INVALID/);
          await expectRefusedUntouched('HUMAN-B1', { dod_confirmed: [null] }, /DOD_CONFIRMED_INVALID/);
        });

        // verify-artifacts считает любой «[ ]» и «[x]» секции; пункты здесь — строки списка с
        // чекбоксом любого маркера, иначе «при review/done отмечен каждый пункт» неверно для
        // «1. [ ]» и «+ [ ]».
        describe('list markers', () => {
          const MARKED = ['- [ ] A', '1. [ ] B numbered', '+ [ ] C plus', '* [ ] D star', '2) [ ] E paren'];

          it('numbered, plus and star items are items: named when unconfirmed, ticked when confirmed', async () => {
            createCustomTicket('ready', 'HUMAN-M1', { dod: MARKED });
            createCustomTicket('ready', 'HUMAN-M2', { dod: MARKED });
            createCustomTicket('ready', 'HUMAN-M3', { dod: MARKED });

            await expectRefusedUntouched('HUMAN-M1', { dod_confirmed: [1] }, /Unconfirmed: "B numbered"; "C plus"; "D star"; "E paren"\. /);

            await resolveTo('HUMAN-M2', {});
            const all = dodOf(ticketFile('review', 'HUMAN-M2'));
            expect(all.match(/\[x\]/g)).toHaveLength(5);
            expect(all).not.toContain('[ ]');

            await resolveTo('HUMAN-M3', { dod_confirmed: [1, 'b numbered', 'c plus', 'd star', 'e paren'] });
            expect(dodOf(ticketFile('review', 'HUMAN-M3')).match(/\[x\]/g)).toHaveLength(5);
          });

          it('a [ ] written inside an item text is not an item and stays as written', async () => {
            createCustomTicket('ready', 'HUMAN-M4', { dod: ['- [ ] Разметка `- [ ]` в тексте', '- [ ] Второй'] });

            await resolveTo('HUMAN-M4', { dod_confirmed: [1, 2] });

            const dod = dodOf(ticketFile('review', 'HUMAN-M4'));
            expect(dod).toContain('- [x] Разметка `- [ ]` в тексте');
            expect(dod).toContain('- [x] Второй');
          });
        });
      });

      // Секция результата в шаблоне стоит ниже DoD, но не в каждом тикете. Заголовок DoD из текста
      // результата, вставленный выше настоящего, перехватывал отметки и проверку: под lock'ом
      // пункты искались в нём («DOD_ITEM_NOT_FOUND: no DoD item number 2» при проверке до lock'а,
      // прошедшей по настоящему DoD), а без dod_confirmed отмечался его пункт, не настоящие.
      describe('a DoD heading inside the result text, result section above the DoD', () => {
        const INJECTED = '### Summary\n\nСделано.\n\n## Критерии готовности (Definition of Done)\n\n- [ ] injected\n';
        const REAL = ['- [ ] Первый', '- [ ] Второй'];
        const h2Count = (file) => fs.readFileSync(file, 'utf8').match(/^##[ \t]*Критерии готовности/gm).length;

        it('with dod_confirmed ticks the real items and keeps the injected text as H3', async () => {
          createCustomTicket('ready', 'HUMAN-H1', { dod: REAL, resultFirst: true });

          const result = await resolveTo('HUMAN-H1', { dod_confirmed: [1, 2], result_body: INJECTED });

          const file = ticketFile('review', 'HUMAN-H1');
          expect(result.new_status).toBe('review');
          expect(realDodOf(file).match(/\[x\]/g)).toHaveLength(2);
          expect(h2Count(file)).toBe(1);
          const text = fs.readFileSync(file, 'utf8');
          expect(text).toContain('### Критерии готовности (Definition of Done)');
          expect(text).toContain('- [ ] injected');
        });

        it('without dod_confirmed ticks the real items, not the injected one', async () => {
          createCustomTicket('ready', 'HUMAN-H2', { dod: REAL, resultFirst: true });

          await resolveTo('HUMAN-H2', { result_body: INJECTED });

          const file = ticketFile('review', 'HUMAN-H2');
          expect(realDodOf(file).match(/\[x\]/g)).toHaveLength(2);
          expect(fs.readFileSync(file, 'utf8')).toContain('- [ ] injected');
        });

        it('the same holds for a heading inside the decision', async () => {
          createCustomTicket('ready', 'HUMAN-H3', { dod: REAL, resultFirst: true });

          await resolveTo('HUMAN-H3', { dod_confirmed: [1, 2], decision: 'ok\n## Критерии готовности\n\n- [ ] from decision' });

          const file = ticketFile('review', 'HUMAN-H3');
          expect(realDodOf(file).match(/\[x\]/g)).toHaveLength(2);
          expect(h2Count(file)).toBe(1);
        });
      });

      // Контракт с verify-artifacts workflow-ai: он считает только отмеченные пункты и без
      // отметок возвращает failed (0% DoD) — так HUMAN-001 ушёл на лишний круг. Тест гоняет
      // настоящий скрипт из установленного workflow-ai, чтобы расхождение заголовков или
      // регулярок при обновлении пакета всплыло сразу.
      describe('verify-artifacts contract', () => {
        function verify(ticketPath) {
          const script = path.join(workflowAiRoot(), 'src', 'skills', 'review-result', 'scripts', 'verify-artifacts.js');
          const run = spawnSync(process.execPath, [script, ticketPath], { cwd: projectPath, encoding: 'utf8', timeout: 60000 });
          const block = /---RESULT---\r?\n([\s\S]*?)---RESULT---/.exec(run.stdout);
          if (!block) throw new Error(`no RESULT block: ${run.stdout}\n${run.stderr}`);
          return Object.fromEntries(block[1].split(/\r?\n/).filter(Boolean).map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at), line.slice(at + 1).trim()];
          }));
        }

        it('reads the filled result section and the ticked DoD of a resolved ticket', { timeout: 60000 }, async () => {
          createTemplateTicket('ready', 'HUMAN-V1');

          await resolveTo('HUMAN-V1', { dod_confirmed: [1, 2], result_body: '### Summary\n\nПроверено на телефоне.' });

          const verdict = verify(ticketFile('review', 'HUMAN-V1'));
          expect(verdict.result_filled).toBe('true');
          expect(Number(verdict.dod_completion_pct)).toBe(100);
        });

        it('a call without dod_confirmed reads the same in verify-artifacts', { timeout: 60000 }, async () => {
          createTemplateTicket('ready', 'HUMAN-V3');

          await resolveTo('HUMAN-V3', { result_body: '### Summary\n\nПроверено на телефоне.' });

          const verdict = verify(ticketFile('review', 'HUMAN-V3'));
          expect(verdict.result_filled).toBe('true');
          expect(Number(verdict.dod_completion_pct)).toBe(100);
        });

        it('a partial confirmation is partial in verify-artifacts too', { timeout: 60000 }, async () => {
          createTemplateTicket('in-progress', 'HUMAN-V2');

          await resolveTo('HUMAN-V2', { dod_confirmed: [1], next_status: 'blocked', result_body: '### Summary\n\nПроверено частично.' });

          const verdict = verify(ticketFile('blocked', 'HUMAN-V2'));
          expect(verdict.result_filled).toBe('true');
          expect(Number(verdict.dod_completion_pct)).toBe(50);
        });

        it('numbered, plus and star items count the same: all confirmed is 100%, one of five is 20%', { timeout: 60000 }, async () => {
          const dod = ['- [ ] A', '1. [ ] B', '+ [ ] C', '* [ ] D', '2) [ ] E'];
          createCustomTicket('ready', 'HUMAN-V4', { dod });
          createCustomTicket('in-progress', 'HUMAN-V5', { dod });

          await resolveTo('HUMAN-V4', { dod_confirmed: [1, 2, 3, 4, 5] });
          await resolveTo('HUMAN-V5', { dod_confirmed: [2], next_status: 'blocked' });

          expect(Number(verify(ticketFile('review', 'HUMAN-V4')).dod_completion_pct)).toBe(100);
          expect(Number(verify(ticketFile('blocked', 'HUMAN-V5')).dod_completion_pct)).toBe(20);
        });

        it('a DoD heading inside result_body does not replace the ticket DoD above which the result stands', { timeout: 60000 }, async () => {
          createCustomTicket('ready', 'HUMAN-V6', { dod: ['- [ ] Первый', '- [ ] Второй'], resultFirst: true });

          await resolveTo('HUMAN-V6', {
            dod_confirmed: [1, 2],
            result_body: '### Summary\n\nСделано.\n\n## Критерии готовности (Definition of Done)\n\n- [ ] injected\n'
          });

          const verdict = verify(ticketFile('review', 'HUMAN-V6'));
          expect(verdict.result_filled).toBe('true');
          expect(Number(verdict.dod_completion_pct)).toBe(100);
        });
      });
    });

    it('does not nest a result heading passed in result_body', async () => {
      createTicket('review', 'HUMAN-T4', { type: 'human' });

      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-T4',
        decision: 'approved',
        result_body: '## Результат\n\nТест пройден.'
      });

      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-T4.md');
      const { body } = parseFrontmatter(fs.readFileSync(donePath, 'utf8'));
      expect(body.match(/^##[ \t]*(Результат выполнения|Результат|Result)[ \t]*$/gm)).toEqual(['## Результат выполнения']);
      expect(body).toContain('Тест пройден.');
    });
  });

  // ListeningGlass HUMAN-001 и HUMAN-002 (2026-09-30): decision.substring(0, 100) оставил в
  // review_log «…динамически» и «…останав» — обрыв посреди слова.
  describe('review_log decision summary', () => {
    async function loggedDecision(id, decision) {
      createTicket('review', id, { type: 'human' });
      await resolve_human_ticket({ project: 'test-project', ticket_id: id, decision, result_body: 'Готово.' });
      const done = path.join(projectPath, '.workflow', 'tickets', 'done', `${id}.md`);
      const { frontmatter, body } = parseFrontmatter(fs.readFileSync(done, 'utf8'));
      return { logged: frontmatter.review_log[0].decision, body };
    }

    it('cuts a long decision at a word boundary and marks the cut with an ellipsis', async () => {
      const decision = 'Оба пути внедрения работают в Яндекс Браузере 26.8.6.59 на Android 13: статический — да, '
        + 'динамически после перезагрузки вкладки не проверялся, остальное без замечаний';

      const { logged, body } = await loggedDecision('HUMAN-S1', decision);

      expect(Array.from(logged).length).toBeLessThanOrEqual(100);
      expect(logged.endsWith('…')).toBe(true);
      const kept = logged.slice(0, -1);
      expect(decision.startsWith(kept)).toBe(true);
      // Следом в оригинале — пробел: слово цело.
      expect(decision[kept.length]).toBe(' ');
      expect(kept.endsWith(' ')).toBe(false);
      // Полный текст решения лежит в секции результата.
      expect(body).toContain(`**Решение:** ${decision}`);
    });

    it('keeps a decision of up to 100 characters as it is', async () => {
      const exactly100 = `${'слово '.repeat(16)}слов`;
      expect(Array.from(exactly100)).toHaveLength(100);

      const { logged } = await loggedDecision('HUMAN-S2', exactly100);

      expect(logged).toBe(exactly100);
    });

    it('cuts a single overlong word by code points, never inside a surrogate pair', async () => {
      const decision = '😀'.repeat(150);

      const { logged } = await loggedDecision('HUMAN-S3', decision);

      const chars = Array.from(logged);
      expect(chars.length).toBeLessThanOrEqual(100);
      expect(chars.at(-1)).toBe('…');
      expect(chars.slice(0, -1).every((c) => c === '😀')).toBe(true);
      expect(logged).not.toMatch(/[�-�](?![�-�])|(?<![�-�])[�-�]/);
    });
  });

  describe('Ticket removal from queue', () => {
    it('should remove resolved ticket from list_human_queue result', async () => {
      // Setup: Create two HUMAN tickets in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-4', { type: 'human' });
      createTicket('review', 'HUMAN-5', { type: 'human' });

      // Assert: Both tickets are in queue before resolution
      let queueBefore = await list_human_queue({ project: 'test-project', status: 'review' });
      expect(queueBefore.map(t => t.id)).toContain('HUMAN-4');
      expect(queueBefore.map(t => t.id)).toContain('HUMAN-5');

      // Act: Resolve one ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-4',
        decision: 'approved',
        result_body: '## Решение принято'
      });

      // Assert: Resolved ticket is no longer in review queue
      let queueAfter = await list_human_queue({ project: 'test-project', status: 'review' });
      expect(queueAfter.map(t => t.id)).not.toContain('HUMAN-4');
      expect(queueAfter.map(t => t.id)).toContain('HUMAN-5');

      // Assert: Resolved ticket appears in done queue
      let doneQueue = await list_human_queue({ project: 'test-project', status: 'done' });
      expect(doneQueue.map(t => t.id)).toContain('HUMAN-4');
    });
  });

  describe('Error handling', () => {
    it('should throw TICKET_NOT_FOUND when ticket does not exist', async () => {
      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-NONEXISTENT',
          decision: 'approved',
          result_body: 'Test'
        })
      ).rejects.toThrow(/TICKET_NOT_FOUND/);
    });

    it('should throw NOT_HUMAN_TICKET when trying to resolve non-HUMAN ticket', async () => {
      // Setup: Create a non-HUMAN ticket (type: qa)
      createTicket('ready', 'QA-100', { type: 'qa' });

      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'QA-100',
          decision: 'approved',
          result_body: 'Test'
        })
      ).rejects.toThrow(/NOT_HUMAN_TICKET/);
    });

    it('should throw INCOMPLETE_RESULT when result_body is empty', async () => {
      // Setup: Create a HUMAN ticket in review/ (valid transition: review -> done)
      createTicket('review', 'HUMAN-6', { type: 'human' });

      // Act & Assert
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-6',
          decision: 'approved',
          result_body: ''
        })
      ).rejects.toThrow(/INCOMPLETE_RESULT/);

      // Create another ticket for the second test
      createTicket('review', 'HUMAN-6b', { type: 'human' });

      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-6b',
          decision: 'approved',
          result_body: '   \n  '
        })
      ).rejects.toThrow(/INCOMPLETE_RESULT/);
    });

    it('should throw ALREADY_RESOLVED when trying to resolve a ticket that is already done', async () => {
      // Setup: Create and resolve a ticket from in-progress (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-7', { type: 'human' });
      const firstResolve = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-7',
        decision: 'approved',
        result_body: 'Already resolved'
      });

      // Verify the ticket was moved to done/
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-7.md');
      expect(fs.existsSync(donePath)).toBe(true);

      // Act & Assert: Try to resolve again - should fail since it's already in done/
      await expect(
        resolve_human_ticket({
          project: 'test-project',
          ticket_id: 'HUMAN-7',
          decision: 'approved',
          result_body: 'Try to resolve again'
        })
      ).rejects.toThrow();
    });
  });

  describe('Stage behavior documentation', () => {
    it('should resolve HUMAN ticket from in-progress status', async () => {
      // Setup: Create a HUMAN ticket in in-progress/
      createTicket('in-progress', 'HUMAN-8', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-8',
        decision: 'approved',
        result_body: 'Completed in-progress'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-8.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should resolve HUMAN ticket from review status', async () => {
      // Setup: Create a HUMAN ticket in review/
      createTicket('review', 'HUMAN-9', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-9',
        decision: 'rejected',
        result_body: 'Review rejected'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-9.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should resolve HUMAN ticket from backlog status', async () => {
      // Setup: Create a HUMAN ticket in backlog/
      createTicket('backlog', 'HUMAN-10', { type: 'human' });

      // Act: Resolve the ticket
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-10',
        decision: 'approved',
        result_body: 'Resolved from backlog'
      });

      // Assert: Ticket moved to done
      expect(result.new_status).toBe('done');
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-10.md');
      expect(fs.existsSync(donePath)).toBe(true);
    });

    it('should allow custom next_status parameter', async () => {
      // Setup: Create a HUMAN ticket in ready/
      createTicket('ready', 'HUMAN-11', { type: 'human' });

      // Act: Resolve with custom next_status
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-11',
        decision: 'needs_review',
        result_body: 'Needs further review',
        next_status: 'review'
      });

      // Assert: Ticket moved to specified status
      expect(result.new_status).toBe('review');
      const reviewPath = path.join(projectPath, '.workflow', 'tickets', 'review', 'HUMAN-11.md');
      expect(fs.existsSync(reviewPath)).toBe(true);
    });
  });

  describe('HUMAN ticket identification', () => {
    it('should recognize HUMAN ticket by type field', async () => {
      // Setup: Create ticket with type: human (without HUMAN- prefix in filename)
      // Using review status for valid transition: review -> done
      createTicket('review', 'CUSTOM-1', { type: 'human' });

      // Act: Resolve should work for type: human tickets
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'CUSTOM-1',
        decision: 'approved',
        result_body: 'Resolved custom HUMAN type'
      });

      // Assert: Successfully resolved
      expect(result.id).toBe('CUSTOM-1');
      expect(result.new_status).toBe('done');
    });

    it('should recognize HUMAN ticket by HUMAN- filename prefix', async () => {
      // Setup: Create ticket with HUMAN- prefix (without explicit type: human) in in-progress status
      // Valid transition: in-progress -> done
      const ticketPath = path.join(projectPath, '.workflow', 'tickets', 'in-progress', 'HUMAN-BYPREFIX.md');
      const frontmatter = `---
id: HUMAN-BYPREFIX
type: task
title: Test HUMAN Prefix
priority: 1
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-27T08:00:00Z"
completed_at: ""
---`;
      fs.writeFileSync(ticketPath, frontmatter + '\n## Test\n');

      // Act: Resolve should work for HUMAN- prefixed tickets
      const result = await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-BYPREFIX',
        decision: 'approved',
        result_body: 'Resolved by prefix'
      });

      // Assert: Successfully resolved
      expect(result.id).toBe('HUMAN-BYPREFIX');
      expect(result.new_status).toBe('done');
    });
  });

  describe('Data persistence and atomicity', () => {
    it('should preserve all ticket metadata when resolving', async () => {
      // Setup: Create ticket with metadata in in-progress status (valid transition: in-progress -> done)
      createTicket('in-progress', 'HUMAN-12', {
        type: 'human',
        title: 'Test with metadata',
        priority: 2,
        parent_plan: '.workflow/plans/PLAN-001.md',
        dependencies: ['IMPL-1', 'IMPL-2']
      });

      // Act: Resolve the ticket
      await resolve_human_ticket({
        project: 'test-project',
        ticket_id: 'HUMAN-12',
        decision: 'approved',
        result_body: 'Test result'
      });

      // Assert: Metadata is preserved
      const donePath = path.join(projectPath, '.workflow', 'tickets', 'done', 'HUMAN-12.md');
      const content = fs.readFileSync(donePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe('Test with metadata');
      expect(frontmatter.priority).toBe(2);
      expect(frontmatter.parent_plan).toBe('.workflow/plans/PLAN-001.md');
      expect(frontmatter.dependencies).toEqual(['IMPL-1', 'IMPL-2']);
    });
  });

  // Правило о правках кода продукта во время тикета человека (разбор review-result,
  // находка human-ticket-product-edits-unchecked) дано агенту в описаниях обоих
  // инструментов, а правила dod_confirmed — в описании resolve_human_ticket и его схемы.
  describe('tool descriptions', () => {
    const PRODUCT_CODE_RULE = /product-code change[\s\S]*separate agent ticket \(create_ticket\)[\s\S]*only the human result/;

    it('get_human_context and resolve_human_ticket send product-code changes to a separate agent ticket', () => {
      expect(get_human_context_tool.description).toMatch(PRODUCT_CODE_RULE);
      expect(resolve_human_ticket_tool.description).toMatch(PRODUCT_CODE_RULE);
    });

    it('resolve_human_ticket describes both DoD modes, and the schema keeps dod_confirmed optional', () => {
      const { description, inputSchema } = resolve_human_ticket_tool;
      expect(description).toMatch(/Without dod_confirmed, moving to review or done ticks every DoD item/);
      expect(description).toMatch(/dod_confirmed[\s\S]*DOD_NOT_CONFIRMED[\s\S]*another next_status/);
      expect(inputSchema.shape.dod_confirmed.description).toMatch(/Omit to keep the previous behavior[\s\S]*DOD_NOT_CONFIRMED/);

      const call = { project: 'p', ticket_id: 'HUMAN-1', decision: 'ok', result_body: 'Готово.' };
      expect(inputSchema.safeParse(call).success).toBe(true);
      expect(inputSchema.safeParse({ ...call, dod_confirmed: [1, 'записана версия'] }).success).toBe(true);
      expect(inputSchema.safeParse({ ...call, dod_confirmed: 'all' }).success).toBe(false);
      // Ссылка из одних пробелов — подстрока любого пункта DoD: схема её не пропускает.
      expect(inputSchema.safeParse({ ...call, dod_confirmed: ['   '] }).success).toBe(false);
      expect(inputSchema.safeParse({ ...call, dod_confirmed: [''] }).success).toBe(false);
    });

    it('says which statuses a partial hand-over can use, and what counts as a DoD item', () => {
      const { description, inputSchema } = resolve_human_ticket_tool;
      // «blocked» как пример вёл из ready в недопустимый переход.
      expect(description).toMatch(/another next_status that the current status allows[\s\S]*from ready only backlog, blocked is not reachable/);
      expect(description).not.toMatch(/e\.g\. blocked/);
      expect(inputSchema.shape.dod_confirmed.description).toMatch(/checkbox lines of that section \("- \[ \]", "\* \[ \]", "\+ \[ \]", "1\. \[ \]"\); a \[ \] inside an item's text is not an item/);
    });
  });

  // Копия таблицы переходов workflow-ai живёт в human.mjs, потому что оттуда её не достать;
  // отказ до lock'а и подсказка по статусам верны, только пока она совпадает с настоящей.
  describe('transition table', () => {
    const STATUSES = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

    it('allows exactly the moves that workflow-ai moveTicket allows, for every pair of statuses', async () => {
      expect(Object.keys(TICKET_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
      const mismatches = [];
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const id = `HUMAN-X-${from}-${to}`;
          createTicket(from, id);
          let allowed = true;
          try {
            await moveTicket(projectPath, id, to);
          } catch (e) {
            if (e?.code !== 'INVALID_TRANSITION') throw e;
            allowed = false;
          }
          if (allowed !== TICKET_TRANSITIONS[from].includes(to)) mismatches.push(`${from} → ${to}: moveTicket ${allowed ? 'allows' : 'refuses'}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });
});
