import { z } from 'zod';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import path from 'path';
import fs from 'fs';
import { resolveProjectRoot } from '../lib/project-root.mjs';
import { isWorkflowDoc } from '../lib/workflow-docs.mjs';

/**
 * list_reports — сканирует <project>/.workflow/reports/*.md, сортирует по created_at DESC
 * @param {Object} params - Параметры
 * @param {string} params.project - Путь к проекту
 * @param {string} [params.since] - Фильтр: только отчёты с created_at >= since (ISO string)
 * @param {number} [params.limit=50] - Лимит возвращаемых отчётов
 * @returns {Promise<Array<{id: string, title: string, type: string, created_at: string, path: string}>>}
 */
async function listReportsImpl({ project, since, limit = 50 }) {
  const projectRoot = resolveProjectRoot(project);
  const reportsDir = path.join(projectRoot, '.workflow', 'reports');

  if (!fs.existsSync(reportsDir)) {
    return [];
  }

  const files = fs.readdirSync(reportsDir)
    .filter(f => isWorkflowDoc(f))
    .map(f => path.join(reportsDir, f));

  const reports = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // Пропускаем отчёты с невалидным frontmatter
      if (!frontmatter || typeof frontmatter !== 'object') {
        continue;
      }

      // Проверка since фильтра
      if (since && frontmatter.created_at) {
        if (new Date(frontmatter.created_at) < new Date(since)) {
          continue;
        }
      }

      reports.push({
        id: frontmatter.id || path.basename(filePath, '.md'),
        title: frontmatter.title || '',
        type: frontmatter.type || '',
        created_at: frontmatter.created_at || '',
        path: filePath
      });
    } catch (e) {
      // Пропускаем файлы, которые не удалось прочитать или распарсить
      continue;
    }
  }

  // Сортировка по created_at DESC
  reports.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    return db - da;
  });

  // Применение лимита
  return reports.slice(0, limit);
}

/**
 * get_report — возвращает {frontmatter, body, path}
 * @param {Object} params - Параметры
 * @param {string} params.project - Путь к проекту
 * @param {string} params.report_id - ID отчёта (валидируется regex ^[A-Z0-9-]+$)
 * @returns {Promise<{frontmatter: Object, body: string, path: string}>}
 * @throws {Error} При невалидном report_id или отсутствии файла
 */
async function getReportImpl({ project, report_id }) {
  const projectRoot = resolveProjectRoot(project);

  // Path traversal защита: валидация report_id
  if (!/^[A-Z0-9-]+$/.test(report_id)) {
    // Прежняя метка INVALID_FRONTMATTER вводила в заблуждение: фронтматтер
    // здесь ни при чём, отклоняется аргумент.
    const err = new Error(`Invalid report_id: ${report_id}. Allowed characters: A-Z 0-9 -`);
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }

  const reportsDir = path.join(projectRoot, '.workflow', 'reports');
  const filePath = path.join(reportsDir, `${report_id}.md`);

  if (!fs.existsSync(filePath)) {
    const err = new Error(`Report not found: ${report_id}`);
    err.code = 'REPORT_NOT_FOUND';
    throw err;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  // Проверка на невалидный frontmatter
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`INVALID_FRONTMATTER: Report ${report_id} has invalid frontmatter`);
  }

  return {
    frontmatter,
    body,
    path: filePath
  };
}

/**
 * MCP Tool: list_reports
 */
export const list_reports = {
  name: 'list_reports',
  description: 'List reports from a project directory, sorted by created_at DESC',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    since: z.string().optional().describe('Optional: ISO 8601 date to filter results (only reports created at or after this date)'),
    limit: z.number().optional().describe('Maximum number of reports to return (default: 50)')
  }),
  // Обёртку в content[] делает сам сервер (см. registerTools в server.mjs).
  // Своя такая же здесь давала клиенту данные на уровень глубже, чем у всех
  // остальных tools; ошибку сервер тоже ловит и форматирует тем же текстом.
  async execute(args) {
    return listReportsImpl({
      project: args.project,
      since: args.since,
      limit: args.limit
    });
  }
};

/**
 * MCP Tool: get_report
 */
export const get_report = {
  name: 'get_report',
  description: 'Get a specific report by ID',
  inputSchema: z.object({
    project: z.string().describe('Project path or name'),
    report_id: z.string().describe('Report ID (alphanumeric and hyphens only)')
  }),
  // См. комментарий у list_reports — двойная обёртка убрана.
  async execute(args) {
    return getReportImpl({
      project: args.project,
      report_id: args.report_id
    });
  }
};