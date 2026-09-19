/**
 * Tests for workflow://alerts and workflow://alerts/history MCP resources
 * Verifies IMPL-29 DoD criteria for alert resources
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as resources from '../../src/resources/index.mjs';

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
    let stateDir;

    beforeEach(() => {
      stateDir = createTestStateDir();
    });

    afterEach(() => {
      cleanupTestStateDir(stateDir);
    });

    it('should return empty array when no alerts-history.jsonl exists', async () => {
      const result = await resources.get_workflow_alerts(stateDir);

      expect(result.uri).toBe('workflow://alerts');
      expect(result.mimeType).toBe('application/json');
      expect(() => JSON.parse(result.text)).not.toThrow();

      const alerts = JSON.parse(result.text);
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0);
    });

    it('should return empty array when alerts-history.jsonl is empty', async () => {
      fs.writeFileSync(path.join(stateDir.dir, 'alerts-history.jsonl'), '');

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0);
    });

    it('should parse single active alert with type, project, severity fields', async () => {
      const testAlerts = [
        {
          type: 'stuck',
          project: 'workflow-ai',
          severity: 'high',
          detected_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(), // 10 min ago
          fingerprint: 'fp-001',
          message: 'Process stuck in ready stage'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('stuck');
      expect(alerts[0].project).toBe('workflow-ai');
      expect(alerts[0].severity).toBe('high');
      expect(alerts[0].fingerprint).toBe('fp-001');
    });

    it('should return multiple active alerts sorted by detected_at DESC', async () => {
      const now = Date.now();
      const testAlerts = [
        {
          type: 'crashed',
          project: 'proj1',
          severity: 'critical',
          detected_at: new Date(now - 1000 * 60 * 15).toISOString(), // 15 min ago
          fingerprint: 'fp-001',
          message: 'Process crashed'
        },
        {
          type: 'stuck',
          project: 'proj2',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 5).toISOString(), // 5 min ago
          fingerprint: 'fp-002',
          message: 'Process stuck'
        },
        {
          type: 'error',
          project: 'proj3',
          severity: 'medium',
          detected_at: new Date(now - 1000 * 60 * 20).toISOString(), // 20 min ago
          fingerprint: 'fp-003',
          message: 'Pipeline error'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      expect(alerts.length).toBe(3);
      // Should be sorted by detected_at DESC (most recent first)
      expect(alerts[0].fingerprint).toBe('fp-002'); // 5 min ago (most recent)
      expect(alerts[1].fingerprint).toBe('fp-001'); // 15 min ago
      expect(alerts[2].fingerprint).toBe('fp-003'); // 20 min ago (oldest)
    });

    it('should filter out alerts older than 24 hours', async () => {
      const now = Date.now();
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 60 * 12).toISOString(), // 12 hours ago
          fingerprint: 'fp-001'
        },
        {
          type: 'error',
          project: 'proj2',
          severity: 'medium',
          detected_at: new Date(now - 1000 * 60 * 60 * 30).toISOString(), // 30 hours ago
          fingerprint: 'fp-002'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      // Only the 12-hour-old alert should be included
      expect(alerts.length).toBe(1);
      expect(alerts[0].fingerprint).toBe('fp-001');
    });

    it('should keep most recent alert per fingerprint', async () => {
      const now = Date.now();
      const testAlerts = [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 10).toISOString(),
          fingerprint: 'fp-001',
          message: 'First occurrence'
        },
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date(now - 1000 * 60 * 5).toISOString(),
          fingerprint: 'fp-001',
          message: 'Updated occurrence'
        }
      ];

      createAlertsHistoryFile(stateDir, testAlerts);

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      // Should have only 1 alert (the most recent one)
      expect(alerts.length).toBe(1);
      expect(alerts[0].message).toBe('Updated occurrence');
    });

    it('should handle read-only mode by returning empty array', async () => {
      const readOnlyStateDir = { dir: stateDir.dir, mode: 'read-only' };

      // Even if file exists, read-only mode should return empty
      createAlertsHistoryFile(stateDir, [
        {
          type: 'stuck',
          project: 'proj1',
          severity: 'high',
          detected_at: new Date().toISOString(),
          fingerprint: 'fp-001'
        }
      ]);

      const result = await resources.get_workflow_alerts(readOnlyStateDir);
      const alerts = JSON.parse(result.text);

      expect(alerts.length).toBe(0);
    });

    it('should handle malformed JSON lines by skipping them', async () => {
      const historyPath = path.join(stateDir.dir, 'alerts-history.jsonl');
      const content = `${JSON.stringify({
        type: 'stuck',
        project: 'proj1',
        severity: 'high',
        detected_at: new Date().toISOString(),
        fingerprint: 'fp-001'
      })}
invalid json line
${JSON.stringify({
        type: 'error',
        project: 'proj2',
        severity: 'medium',
        detected_at: new Date().toISOString(),
        fingerprint: 'fp-002'
      })}`;

      fs.writeFileSync(historyPath, content);

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      // Should have 2 valid alerts, skipped the invalid line
      expect(alerts.length).toBe(2);
      expect(alerts.some(a => a.fingerprint === 'fp-001')).toBe(true);
      expect(alerts.some(a => a.fingerprint === 'fp-002')).toBe(true);
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

    it('subscribe_workflow_alerts should return unsubscribe function', () => {
      const callback = () => {};
      const unsubscribe = resources.subscribe_workflow_alerts(callback);

      expect(typeof unsubscribe).toBe('function');

      // Should not throw when called
      unsubscribe();
    });

    it('subscribing and notifying should call the callback', async () => {
      const alerts = [];
      const unsubscribe = resources.subscribe_workflow_alerts((alert) => {
        alerts.push(alert);
      });

      const testAlert = {
        type: 'stuck',
        project: 'proj1',
        severity: 'high',
        detected_at: new Date().toISOString(),
        fingerprint: 'fp-001'
      };

      try {
        resources.notify_workflow_alerts(testAlert);

        // Give callback time to execute
        await delay(100);

        expect(alerts.length).toBe(1);
        expect(alerts[0].fingerprint).toBe('fp-001');
      } finally {
        // Отписка обязана произойти и при упавшем ожидании: подписчики живут в
        // модуле, и утёкший колбэк ловит алерты следующих тестов.
        unsubscribe();
      }
    });

    it('multiple subscribers should all receive notifications', async () => {
      const alerts1 = [];
      const alerts2 = [];

      const unsub1 = resources.subscribe_workflow_alerts((alert) => {
        alerts1.push(alert);
      });

      const unsub2 = resources.subscribe_workflow_alerts((alert) => {
        alerts2.push(alert);
      });

      const testAlert = {
        type: 'error',
        project: 'proj2',
        severity: 'medium',
        detected_at: new Date().toISOString(),
        fingerprint: 'fp-002'
      };

      try {
        resources.notify_workflow_alerts(testAlert);

        await delay(100);

        expect(alerts1.length).toBe(1);
        expect(alerts2.length).toBe(1);
        expect(alerts1[0].fingerprint).toBe('fp-002');
        expect(alerts2[0].fingerprint).toBe('fp-002');
      } finally {
        unsub1();
        unsub2();
      }
    });

    it('unsubscribe should prevent further notifications', async () => {
      const alerts = [];
      const unsubscribe = resources.subscribe_workflow_alerts((alert) => {
        alerts.push(alert);
      });

      try {
        resources.notify_workflow_alerts({ fingerprint: 'fp-001' });

        await delay(100);
        expect(alerts.length).toBe(1);

        unsubscribe();

        resources.notify_workflow_alerts({ fingerprint: 'fp-002' });

        await delay(100);
        // Should still be 1 (not 2)
        expect(alerts.length).toBe(1);
      } finally {
        unsubscribe();
      }
    });

    it('callback errors should not block other subscribers', async () => {
      const alerts2 = [];

      // First subscriber throws error
      const unsub1 = resources.subscribe_workflow_alerts(() => {
        throw new Error('Subscriber 1 error');
      });

      // Second subscriber should still receive
      const unsub2 = resources.subscribe_workflow_alerts((alert) => {
        alerts2.push(alert);
      });

      const testAlert = { fingerprint: 'fp-test' };

      // Suppress console.error for this test
      const originalError = console.error;
      console.error = () => {};

      try {
        resources.notify_workflow_alerts(testAlert);

        await delay(100);

        expect(alerts2.length).toBe(1);
        expect(alerts2[0].fingerprint).toBe('fp-test');
      } finally {
        console.error = originalError;
        unsub1();
        unsub2();
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

    it('should return empty array if stateDir is null', async () => {
      const result = await resources.get_workflow_alerts(null);
      const alerts = JSON.parse(result.text);
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0);
    });

    it('should return empty array if stateDir.dir is invalid', async () => {
      const result = await resources.get_workflow_alerts({ dir: '/nonexistent/path/12345', mode: 'read-write' });
      const alerts = JSON.parse(result.text);
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0);
    });

    it('should handle alerts with missing detected_at gracefully', async () => {
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

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      // Only valid alert with detected_at should be included
      expect(alerts.length).toBe(1);
      expect(alerts[0].fingerprint).toBe('fp-002');
    });

    it('should handle alerts with _fingerprint or fingerprint fields', async () => {
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

      const result = await resources.get_workflow_alerts(stateDir);
      const alerts = JSON.parse(result.text);

      expect(alerts.length).toBe(2);
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

      const alertsResult = await resources.get_workflow_alerts(stateDir);
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
      const result = await resources.get_workflow_alerts(stateDir);
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
      const alertsResult = await resources.get_workflow_alerts(stateDir);
      const historyResult = await resources.get_workflow_alerts_history(stateDir);

      expect(alertsResult.mimeType).toBe('application/json');
      expect(historyResult.mimeType).toBe('application/json');
    });
  });
});
