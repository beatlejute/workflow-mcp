/**
 * Тесты на разбор аргументов тикетных tools.
 *
 * `ticket_id` и `type` идут прямо в имя файла, а ошибки раннера приходят не
 * всегда как `Error`. И то и другое до регистрации этих функций как MCP-tools
 * никто не проверял: значения приходили от своих же модулей.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { get_ticket, move_ticket, create_ticket } from '../../src/tools/tickets.mjs';

const STATUSES = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];

describe('валидация аргументов тикетных tools', () => {
  let root;
  let project;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-guards-'));
    project = path.join(root, 'proj');
    for (const st of STATUSES) {
      fs.mkdirSync(path.join(project, '.workflow', 'tickets', st), { recursive: true });
    }
    // Файл за пределами проекта — цель обхода.
    fs.writeFileSync(path.join(root, 'secret.md'), '---\nid: "SECRET"\n---\n\nтайна\n');
    fs.writeFileSync(
      path.join(project, '.workflow', 'tickets', 'backlog', 'IMPL-1.md'),
      '---\nid: "IMPL-1"\ntitle: "тест"\nstatus: backlog\n---\n\nтело\n'
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // временная папка могла быть уже убрана
    }
  });

  it('get_ticket не читает файл за пределами проекта', async () => {
    await expect(get_ticket({ project, ticket_id: '../../secret' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('move_ticket не трогает файл за пределами проекта', async () => {
    await expect(move_ticket({ project, ticket_id: '../../secret', target: 'ready' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Файл остался нетронутым.
    expect(fs.readFileSync(path.join(root, 'secret.md'), 'utf8')).toContain('тайна');
  });

  it('create_ticket не создаёт тикет вне каталога тикетов', async () => {
    await expect(create_ticket({ project, type: '../../../evil', title: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(fs.existsSync(path.join(root, 'evil-001.md'))).toBe(false);
  });

  it('обычные идентификаторы проходят', async () => {
    const ticket = await get_ticket({ project, ticket_id: 'IMPL-1' });
    expect(ticket.frontmatter.id).toBe('IMPL-1');
    expect(ticket.status_from_dir).toBe('backlog');
  });

  it('недопустимый переход приходит с текстом, а не как undefined', async () => {
    // Раннер бросает голый объект `{code, from, to, id}`, а обработчик сервера
    // берёт `err.message` — без нормализации клиент видел бы «undefined».
    await expect(move_ticket({ project, ticket_id: 'IMPL-1', target: 'review' }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    await expect(move_ticket({ project, ticket_id: 'IMPL-1', target: 'review' }))
      .rejects.toThrow(/backlog.*review/);
  });

  it('ненайденный тикет не выдаётся за недопустимый переход', async () => {
    // У ненайденного тикета раннер сообщает тот же код, но с `from: null`.
    await expect(move_ticket({ project, ticket_id: 'IMPL-999', target: 'ready' }))
      .rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });
});
