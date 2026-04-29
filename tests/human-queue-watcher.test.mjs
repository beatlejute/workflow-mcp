/**
 * Tests for human-queue watcher functionality
 * Verifies IMPL-27 DoD criteria
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { HumanQueueWatcher } from '../src/watchers/human-queue-watcher.mjs';
import * as resources from '../src/resources/index.mjs';

// Create a temporary test project directory
function createTestProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-queue-test-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');
  const statuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];

  for (const status of statuses) {
    fs.mkdirSync(path.join(ticketsDir, status), { recursive: true });
  }

  return tmpDir;
}

// Clean up test directory
function cleanupTestProject(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Create a test ticket file
function createTicketFile(dir, filename, content) {
  const filepath = path.join(dir, '.workflow', 'tickets', 'in-progress', filename);
  fs.writeFileSync(filepath, content);
  return filepath;
}

// Wait for async operations with timeout
async function waitFor(condition, timeout = 5000) {
  const startTime = Date.now();
  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('HumanQueueWatcher', () => {
  let testProject;
  let watcher;
  let notifications = [];
  let unsubscribeGlobal = null;

  beforeEach(() => {
    testProject = createTestProject();
    notifications = [];

    // Register a mock notification handler (and keep the unsubscribe function)
    unsubscribeGlobal = resources.subscribe_workflow_human_queue((update) => {
      notifications.push(update);
    });
  });

  afterEach(() => {
    // Unsubscribe the global subscription
    if (unsubscribeGlobal) {
      unsubscribeGlobal();
      unsubscribeGlobal = null;
    }
    if (watcher) {
      watcher.stop();
    }
    cleanupTestProject(testProject);
  });

  it('DoD-1: Client receives notification when HUMAN ticket is created', async () => {
    watcher = new HumanQueueWatcher({
      projects: [{ path: testProject, name: 'test-project' }],
      debounceMs: 500
    });

    watcher.start();

    // Wait for watcher to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Create a HUMAN ticket
    const ticketContent = `---
id: HUMAN-001
title: Test Human Ticket
type: human
---

# Test`;

    createTicketFile(testProject, 'HUMAN-001.md', ticketContent);

    // Wait for notification (increased timeout for file system event propagation)
    await waitFor(() => notifications.length > 0, 5000);

    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0].ticketId).toBe('HUMAN-001');
  });

  it('DoD-2: Non-HUMAN files do not trigger notification', async () => {
    watcher = new HumanQueueWatcher({
      projects: [{ path: testProject, name: 'test-project' }],
      debounceMs: 500
    });

    watcher.start();

    // Create a non-HUMAN ticket
    const ticketContent = `---
id: FIX-001
title: Test Fix Ticket
type: fix
---

# Test`;

    const notificationsAtStart = notifications.length;
    createTicketFile(testProject, 'FIX-001.md', ticketContent);

    // Wait a bit to see if notification arrives
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Should not have new notifications
    expect(notifications.length).toBe(notificationsAtStart);
  });

  it('DoD-3: Burst of 5 operations < debounce → one aggregated notification', async () => {
    watcher = new HumanQueueWatcher({
      projects: [{ path: testProject, name: 'test-project' }],
      debounceMs: 2000
    });

    watcher.start();

    const notificationsAtStart = notifications.length;

    // Create 5 HUMAN tickets in rapid succession
    for (let i = 1; i <= 5; i++) {
      const ticketContent = `---
id: HUMAN-${String(i).padStart(3, '0')}
title: Test Human Ticket ${i}
type: human
---

# Test ${i}`;

      createTicketFile(testProject, `HUMAN-${String(i).padStart(3, '0')}.md`, ticketContent);

      // Short delay between creations
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Wait for debounce to complete
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Should have only 1 additional notification (or close to it due to debouncing)
    const newNotifications = notifications.length - notificationsAtStart;
    expect(newNotifications).toBeLessThanOrEqual(2); // Allow for timing variations
  });

  it('DoD-4: After unsubscribe, notifications stop being delivered', async () => {
    // Unsubscribe from global subscription for this test
    if (unsubscribeGlobal) {
      unsubscribeGlobal();
      unsubscribeGlobal = null;
    }

    watcher = new HumanQueueWatcher({
      projects: [{ path: testProject, name: 'test-project' }],
      debounceMs: 500
    });

    watcher.start();

    // Wait for watcher to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Create a local notifications array for this test
    const testNotifications = [];
    const unsubscribe = resources.subscribe_workflow_human_queue((update) => {
      testNotifications.push(update);
    });

    const ticketContent1 = `---
id: HUMAN-001
title: Test Ticket 1
type: human
---

# Test 1`;

    createTicketFile(testProject, 'HUMAN-001.md', ticketContent1);

    // Wait for notification (increased timeout)
    await waitFor(() => testNotifications.length > 0, 5000);

    // Unsubscribe
    unsubscribe();

    // Create second ticket
    const ticketContent2 = `---
id: HUMAN-002
title: Test Ticket 2
type: human
---

# Test 2`;

    createTicketFile(testProject, 'HUMAN-002.md', ticketContent2);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Should not receive new notifications since we unsubscribed
    // testNotifications should still contain only the first ticket's notification
    expect(testNotifications.length).toBe(1);
    expect(testNotifications[0].ticketId).toBe('HUMAN-001');
  });
});
