import { z } from 'zod';
import { findProjectRoot } from '../../../workflowAi/src/lib/find-root.mjs';
import { parseFrontmatter } from '../../../workflowAi/src/lib/utils.mjs';
import path from 'path';
import fs from 'fs';

/**
 * Получить абсолютный путь к корню проекта
 * @param {string} project - Путь к проекту (относительно cwd или абсолютный)
 * @returns {string} Абсолютный путь к корню проекта
 */
function resolveProjectRoot(project) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, project);
  const workflowDir = path.join(resolved, '.workflow');
  if (!fs.existsSync(workflowDir)) {
    throw new Error(`Project not found or not a workflow project: ${project}`);
  }
  return resolved;
}

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
    .filter(f => f.endsWith('.md'))
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
    throw new Error(`INVALID_FRONTMATTER: Invalid report_id format: ${report_id}`);
  }

  const reportsDir = path.join(projectRoot, '.workflow', 'reports');
  const filePath = path.join(reportsDir, `${report_id}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Report not found: ${report_id}`);
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
  async execute(args) {
    try {
      const data = await listReportsImpl({ 
        project: args.project, 
        since: args.since, 
        limit: args.limit 
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool list_reports: ${err.message}`
          }
        ],
        isError: true
      };
    }
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
  async execute(args) {
    try {
      const data = await getReportImpl({ 
        project: args.project, 
        report_id: args.report_id 
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool get_report: ${err.message}`
          }
        ],
        isError: true
      };
    }
  }
};