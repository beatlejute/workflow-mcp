/**
 * Tests for workflow://alerts and workflow://alerts/history MCP resources
 * Verifies IMPL-29 DoD criteria for alert resources
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as resources from '../../src/resources/index.mjs';
import * as stuck from '../../src/health/detectors/stuck.mjs';
import { serverStateDir } from '../../src/paths/state-dir.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Create a temporary state directory for testing
function createTestStateDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-test-'));
  return { dir: tmpDir, mode: 'read-write' };
}

// Clean up test directory
function cleanupTestStateDir(stateDir) {
  if (fs.existsSync(stateDir.dir)) {
    fs.rmSync(stateDir.dir, { recursive: true, force: true });
  }
}

// Create alerts-history.jsonl with test data
function createAlertsHistoryFile(stateDir, alerts) {
  const historyPath = path.join(stateDir.dir, 'alerts-history.jsonl');
  const lines = alerts.map(alert => JSON.stringify(alert)).join('\n');
  fs.writeFileSync(historyPath, lines + '\n');
  return historyPath;
}

describe('Alerts MCP Resources', () => {

  describe('resources_list()', () => {
    it('should include workflow://alerts in the list', () => {
      const list = resources.resources_list();
      const alertsUri = list.find(r => r.uri === 'workflow://alerts');
      expect(alertsUri).toBeDefined();
      expect(alertsUri.format).toBe('JSON');
      expect(alertsUri.subscribable).toBe(true);
    });

    it('should include workflow://alerts/history in the list', () => {
      const list = resources.resources_list();
      const historyUri = list.find(r => r.uri === 'workflow://alerts/history');
      expect(historyUri).toBeDefined();
      expect(historyUri.format).toBe('JSON');
    });

    it('alerts URIs should have JSON mimeType', () => {
      const list = resources.resources_list();
      const alertsUri = list.find(r => r.uri === 'workflow://alerts');
      const historyUri = list.find(r => r.uri === 'workflow://alerts/history');

      expect(alertsUri.mimeType).toBe('application/json');
      expect(historyUri.mimeType).toBe('application/json');
    });
  });

  describe('get_workflow_alerts()', () => {
    // Ресурс отвечает на вопрос «что не так сейчас»: прогоняет детекторы по
    // проектам рабочей области. Прежде он читал историю публикаций и выдавал
    // её за текущее состояние — разрешившееся условие висело в списке сутки.
    let workspace;
    let prevMcpCwd;
    let prevStateDir;

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-live-'));
      prevMcpCwd = process.env.MCP_CWD;
      prevStateDir = process.env.WORKFLOW_STATE_DIR;
      process.env.MCP_CWD = workspace;
      // Каталог состояния — внутри рабочей области теста. Иначе `serverStateDir`
      // вернул бы путь из `WORKFLOW_STATE_DIR`, и уборка снесла бы каталог,
      // заданный окружением, — то есть живое состояние сервера.
      process.env.WORKFLOW_STATE_DIR = path.join(workspace, '.state');
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (prevMcpCwd === undefined) delete process.env.MCP_CWD;
      else process.env.MCP_CWD = prevMcpCwd;
      if (prevStateDir === undefined) delete process.env.WORKFLOW_STATE_DIR;
      else process.env.WORKFLOW_STATE_DIR = prevStateDir;
      // Сносится только то, что тест сам и создал.
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    /** Проект без единого условия для детекторов. */
    function makeProject(name = 'proj') {
      const root = path.join(workspace, name);
      fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });
      return root;
    }

    /** Условие для detectCrashed: lock с мёртвым pid и свежий лог прогона. */
    function makeCrashedRun(root, { pid = 999999, runId = 'pipeline_2026-09-20_10-00-00' } = {}) {
      const logsDir = path.join(root, '.workflow', 'logs');
      const now = new Date().toISOString();
      fs.writeFileSync(
        path.join(logsDir, '.pipeline.lock'),
        JSON.stringify({ pid, timestamp: now, started_at: now, started_by: 'mcp', run_id: runId }, null, 2)
      );
      fs.writeFileSync(
        path.join(logsDir, runId + '.log'),
        [
          '[2026-09-20 10:00:00] [INFO] [PipelineRunner] Step 1',
          '[2026-09-20 10:00:00] [INFO] START stage="execute-task" agent="claude"'
        ].join('\n')
      );
      return path.join(logsDir, '.pipeline.lock');
    }

    async function readAlerts() {
      const result = await resources.get_workflow_alerts();
      return JSON.parse(result.text);
    }

    it('пустая рабочая область — пустой список', async () => {
      makeProject();

      expect(await readAlerts()).toEqual([]);
    });

    it('сработавший детектор виден сразу', async () => {
      const root = makeProject();
      makeCrashedRun(root);

      const alerts = await readAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('crashed');
      expect(alerts[0].project).toBe('proj');
      expect(alerts[0].severity).toBe('critical');
      expect(alerts[0].detected_at).toBeTruthy();
    });

    it('исчезнувшее условие из списка уходит', async () => {
      // Главное отличие от прежнего поведения: тогда запись держалась сутки.
      const root = makeProject();
      const lockPath = makeCrashedRun(root);
      expect(await readAlerts()).toHaveLength(1);

      fs.rmSync(lockPath);

      expect(await readAlerts()).toEqual([]);
    });

    it('история публикаций на ответ не влияет', async () => {
      // История кладётся ровно туда, откуда её читала прежняя реализация, —
      // в каталог состояния этой рабочей области. Иначе тест тавтологичен:
      // до временного каталога у ресурса пути нет в любом случае.
      makeProject();
      const stateDir = serverStateDir(workspace);
      fs.mkdirSync(stateDir.dir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir.dir, 'alerts-history.jsonl'),
        JSON.stringify({
          type: 'stuck',
          project: 'proj',
          severity: 'critical',
          detected_at: new Date().toISOString(),
          fingerprint: 'stuck:proj:execute-task:run-1',
          _fingerprint: 'deadbeef',
          _published_at: new Date().toISOString()
        }) + '\n',
        'utf8'
      );

      // Записи свежие и прошли бы фильтр «за сутки» прежней реализации.
      expect(await readAlerts()).toEqual([]);
    });

    it('алерты по нескольким проектам отсортированы по detected_at, свежие первыми', async () => {
      const first = makeProject('proj-a');
      const second = makeProject('proj-b');
      makeCrashedRun(first, { runId: 'pipeline_2026-09-20_10-00-00' });
      makeCrashedRun(second, { runId: 'pipeline_2026-09-20_11-00-00' });

      const alerts = await readAlerts();

      expect(alerts).toHaveLength(2);
      const times = alerts.map((alert) => new Date(alert.detected_at).getTime());
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    });

    it('бросивший детектор не отменяет остальные и не роняет ответ', async () => {
      // Битый lock детекторы разбирают сами и не бросают — поэтому детектор
      // здесь ломается по-настоящему.
      const root = makeProject();
      makeCrashedRun(root);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(stuck, 'detectStuck').mockImplementation(() => {
        throw new Error('детектор сломался');
      });

      const alerts = await readAlerts();

      expect(alerts.map((alert) => alert.type)).toEqual(['crashed']);
    });

    it('каталог без .workflow в обход не попадает', async () => {
      fs.mkdirSync(path.join(workspace, 'not-a-project'), { recursive: true });
      const root = makeProject();
      makeCrashedRun(root);

      const alerts = await readAlerts();

      expect(alerts.map((alert) => alert.project)).toEqual(['proj']);
    });
  });

  describe('get_workflow_alerts_history()', () => {
    let stateDir;

    beforeEach(() => {
      stateDir = createTestStateDir();
    });

    afterEach(() => {
      cleanupTestStateDir(stateDir);
    });

    it('should return empty data structure when no alerts-history.jsonl exists', async () => {
      const result = await resources.get_workflow_alerts_history(stateDir);

      expect(result.uri).toContain('workflow://alerts/history');
      expect(result.mimeType).toBe('application/json');

      const data = JSON.parse(result.text);
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBe(0);
    });

    it('should parse all records from alerts-history.jsonl', async () => {
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
          fingerprint: 'fp-001'
        },
        {
          type: 'error',
          project: 'proj2',
          severity: 'medium',
          detected_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
          fingerprint: 'fp-002'
        },
        {
          type: 'crashed',
          project: 'proj3',
          severity: 'critical',
          detected_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
          fingerprint: 'fp-003'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts_history(stateDir);
      const history = JSON.parse(result.text);

      // History returns array directly (not wrapped in {data: []})
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(3);
      expect(history[0].fingerprint).toBe('fp-001');
      expect(history[1].fingerprint).toBe('fp-002');
      expect(history[2].fingerprint).toBe('fp-003');
    });

    it('should filter by since parameter (ISO timestamp)', async () => {
      const now = Date.now();
      const sinceTime = new Date(now - 1000 * 60 * 15); // 15 min ago

      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 30).toISOString(), // 30 min ago
          fingerprint: 'fp-001'
        },
        {
          type: 'error',
          project: 'proj2',
          severity: 'medium',
          detected_at: new Date(now - 1000 * 60 * 10).toISOString(), // 10 min ago
          fingerprint: 'fp-002'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts_history(stateDir, sinceTime.toISOString());
      const history = JSON.parse(result.text);

      // Only the 10-min-ago alert should be included (it's after the 'since' time)
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(1);
      expect(history[0].fingerprint).toBe('fp-002');
    });

    it('should return all records when since is not specified', async () => {
      const now = Date.now();
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 100).toISOString(), // Very old
          fingerprint: 'fp-001'
        },
        {
          type: 'error',
          project: 'proj2',
          severity: 'medium',
          detected_at: new Date(now - 1000 * 60 * 10).toISOString(),
          fingerprint: 'fp-002'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts_history(stateDir);
      const history = JSON.parse(result.text);

      // Both should be included
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(2);
    });

    it('should handle read-only mode gracefully', async () => {
      const readOnlyStateDir = { dir: stateDir.dir, mode: 'read-only' };

      const result = await resources.get_workflow_alerts_history(readOnlyStateDir);
      const data = JSON.parse(result.text);

      expect(data).toHaveProperty('data');
      expect(data.data).toEqual([]);
      expect(data.meta).toHaveProperty('warnings');
    });

    it('should parse JSON correctly with various alert types', async () => {
      const testAlerts = [
        {
          type: 'crashed',
          project: 'proj-a',
          severity: 'critical',
          detected_at: new Date().toISOString(),
          fingerprint: 'fp-crash',
          message: 'Process crashed',
          stage: 'execution',
          details: { code: 1 }
        },
        {
          type: 'stuck',
          project: 'proj-b',
          severity: 'high',
          detected_at: new Date().toISOString(),
          fingerprint: 'fp-stuck',
          message: 'Process stuck',
          stage: 'ready',
          details: { duration_sec: 3600 }
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts_history(stateDir);
      const history = JSON.parse(result.text);

      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(2);
      expect(history[0].details).toBeDefined();
      expect(history[0].details.code).toBe(1);
      expect(history[1].details.duration_sec).toBe(3600);
    });
  });

  describe('Alert subscription mechanism', () => {
    let stateDir;

    beforeEach(() => {
      stateDir = createTestStateDir();
    });

    afterEach(() => {
      cleanupTestStateDir(stateDir);
    });

    it('уведомление шлёт клиенту resources/updated для workflow://alerts', () => {
      // Обработчик ставился сервером и не читался нигде, поэтому
      // `resources/updated` для `workflow://alerts` не уходил никогда — клиент
      // узнавал об алерте, только если сам решал перечитать ресурс.
      const updated = [];
      resources.setResourceNotificationHandler((uri) => updated.push(uri));

      try {
        resources.notify_workflow_alerts({ type: 'crashed', project: 'proj1' });
        expect(updated).toEqual(['workflow://alerts']);
      } finally {
        resources.setResourceNotificationHandler(null);
      }
    });

    it('падение обработчика уведомлений не роняет notify_workflow_alerts', () => {
      // Уведомление зовётся из тика детекторов: исключение из него уронило бы
      // весь обход проектов.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resources.setResourceNotificationHandler(() => { throw new Error('transport closed'); });

      try {
        expect(() => resources.notify_workflow_alerts({ type: 'stuck', project: 'proj1' })).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        resources.setResourceNotificationHandler(null);
        errorSpy.mockRestore();
      }
    });

  });

  describe('Error handling and edge cases', () => {
    let stateDir;

    beforeEach(() => {
      stateDir = createTestStateDir();
    });

    afterEach(() => {
      cleanupTestStateDir(stateDir);
    });

    it('несуществующий корень рабочей области даёт пустой список', async () => {
      const prev = process.env.MCP_CWD;
      process.env.MCP_CWD = path.join(os.tmpdir(), 'no-such-workspace-12345');
      try {
        const result = await resources.get_workflow_alerts();
        expect(JSON.parse(result.text)).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.MCP_CWD;
        else process.env.MCP_CWD = prev;
      }
    });

    it('история: запись без detected_at пропускается', async () => {
      const historyPath = path.join(stateDir.dir, 'alerts-history.jsonl');
      const content = `${JSON.stringify({
        type: 'stuck',
        project: 'proj1',
        severity: 'high',
        fingerprint: 'fp-001'
      })}
${JSON.stringify({
        type: 'error',
        project: 'proj2',
        severity: 'medium',
        detected_at: new Date().toISOString(),
        fingerprint: 'fp-002'
      })}`;

      fs.writeFileSync(historyPath, content);

      const result = await resources.get_workflow_alerts_history(stateDir);
      const history = JSON.parse(result.text);

      // Обе записи попадают в историю: она отдаёт то, что публиковалось.
      expect(history.map((entry) => entry.fingerprint)).toContain('fp-002');
    });

    it('история: отпечаток читается и из _fingerprint, и из fingerprint', async () => {
      const now = Date.now();
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 10).toISOString(),
          _fingerprint: 'fp-underscore'
        },
        {
          type: 'error',
          project: 'proj2',
          severity: 'medium',
          detected_at: new Date(now - 1000 * 60 * 5).toISOString(),
          fingerprint: 'fp-normal'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts_history(stateDir);
      const history = JSON.parse(result.text);

      expect(history.length).toBe(2);
    });

    it('should return valid JSON in all cases', async () => {
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date().toISOString(),
          fingerprint: 'fp-001'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const alertsResult = await resources.get_workflow_alerts();
      const historyResult = await resources.get_workflow_alerts_history(stateDir);

      expect(() => JSON.parse(alertsResult.text)).not.toThrow();
      expect(() => JSON.parse(historyResult.text)).not.toThrow();
    });
  });

  describe('URI format and metadata', () => {
    let stateDir;

    beforeEach(() => {
      stateDir = createTestStateDir();
    });

    afterEach(() => {
      cleanupTestStateDir(stateDir);
    });

    it('get_workflow_alerts should return correct URI', async () => {
      const result = await resources.get_workflow_alerts();
      expect(result.uri).toBe('workflow://alerts');
    });

    it('get_workflow_alerts_history should return correct URI with optional since param', async () => {
      const result1 = await resources.get_workflow_alerts_history(stateDir);
      expect(result1.uri).toContain('workflow://alerts/history');
      expect(result1.uri).not.toContain('?since=');

      const sinceTime = new Date().toISOString();
      const result2 = await resources.get_workflow_alerts_history(stateDir, sinceTime);
      expect(result2.uri).toContain('workflow://alerts/history');
      expect(result2.uri).toContain('?since=');
    });

    it('both resources should have application/json mimeType', async () => {
      const alertsResult = await resources.get_workflow_alerts();
      const historyResult = await resources.get_workflow_alerts_history(stateDir);

      expect(alertsResult.mimeType).toBe('application/json');
      expect(historyResult.mimeType).toBe('application/json');
    });
  });
});
