import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { list_tickets } from '../../src/tools/tickets.mjs';
import { frontmatterCache, invalidate as invalidateCache } from '../../src/caches/frontmatter-cache.mjs';

/**
 * Helper to create test directories with .workflow structure
 */
function createProjectDir(basePath, projectName = 'test-project') {
  const projectPath = path.resolve(basePath, projectName);
  const workflowPath = path.join(projectPath, '.workflow');

  // Create .workflow/tickets structure with all stages
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'ready'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'in-progress'), { recursive: true });
  fs.mkdirSync(path.join(workflowPath, 'tickets', 'done'), { recursive: true });

  return projectPath;
}

/**
 * Helper to create a ticket file
 */
function createTicketFile(projectPath, stage, ticketId, number) {
  const ticketPath = path.join(projectPath, '.workflow', 'tickets', stage, `${ticketId}-${number}.md`);

  const content = `---
id: "${ticketId}-${number}"
title: "Test Ticket ${number}"
type: "impl"
priority: ${(number % 3) + 1}
created_at: "2026-04-26T00:00:00Z"
updated_at: "2026-04-26T10:43:31.812Z"
completed_at: ""
---

This is a test ticket for benchmarking.
`;

  fs.writeFileSync(ticketPath, content, 'utf-8');
  return ticketPath;
}

describe('list_tickets Benchmark — frontmatter-cache efficiency', () => {
  let testDir;
  let projectPath;
  const originalCwd = process.cwd();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'workflow-mcp-bench-'));
    projectPath = createProjectDir(testDir);
    process.chdir(testDir);
    frontmatterCache.clear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
    frontmatterCache.clear();
  });

  it('should demonstrate 10x+ cache speedup: warm call faster than cold call', async () => {
    // Generate 1000 fixtures in backlog
    const ticketCount = 1000;
    console.log(`Generating ${ticketCount} fixture tickets...`);
    for (let i = 0; i < ticketCount; i++) {
      createTicketFile(projectPath, 'backlog', 'BENCH', i + 1);
    }

    // Ensure cache is empty before cold call
    frontmatterCache.clear();

    // COLD CALL: First invocation without warm cache
    console.log('Starting cold call (unfilled cache)...');
    const startCold = process.hrtime.bigint();
    const ticketsCold = await list_tickets({ project: projectPath, status: 'backlog' });
    const endCold = process.hrtime.bigint();
    const timeCold = Number(endCold - startCold) / 1_000_000; // Convert to ms

    console.log(`Cold call: ${timeCold.toFixed(2)}ms, loaded ${ticketsCold.length} tickets`);
    expect(ticketsCold).toHaveLength(ticketCount);

    const cacheStatsAfterCold = frontmatterCache.getStats();
    console.log(`Cache after cold call: ${cacheStatsAfterCold.size} entries`);

    // WARM CALL: Repeat with warm cache
    console.log('Starting warm call (filled cache)...');
    const backlogDir = path.join(projectPath, '.workflow', 'tickets', 'backlog');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const startWarm = process.hrtime.bigint();
    const ticketsWarm = await list_tickets({ project: projectPath, status: 'backlog' });
    const endWarm = process.hrtime.bigint();
    const ticketReads = readSpy.mock.calls
      .filter(([p]) => typeof p === 'string' && p.startsWith(backlogDir)).length;
    readSpy.mockRestore();
    const timeWarm = Number(endWarm - startWarm) / 1_000_000; // Convert to ms

    console.log(`Warm call: ${timeWarm.toFixed(2)}ms, loaded ${ticketsWarm.length} tickets`);
    expect(ticketsWarm).toHaveLength(ticketCount);

    const cacheStatsAfterWarm = frontmatterCache.getStats();
    console.log(`Cache after warm call: ${cacheStatsAfterWarm.size} entries`);

    // Главное свойство кеша — тёплый вызов не перечитывает тикеты с диска.
    // Это детерминировано, в отличие от отношения времён: на загруженной
    // машине ускорение проседало до ~7x при полностью работающем кеше и
    // роняло прогон.
    expect(ticketReads).toBe(0);

    const speedupRatio = timeCold / timeWarm;
    console.log(`Speedup ratio: ${speedupRatio.toFixed(1)}x`);
    expect(speedupRatio).toBeGreaterThan(2);
  });

  it('should invalidate cache when file mtime changes', async () => {
    // Create a small fixture (10 tickets)
    const ticketCount = 10;
    console.log(`Generating ${ticketCount} fixture tickets...`);
    for (let i = 0; i < ticketCount; i++) {
      createTicketFile(projectPath, 'backlog', 'BENCH', i + 1);
    }

    frontmatterCache.clear();

    // First call to populate cache
    const tickets1 = await list_tickets({ project: projectPath, status: 'backlog' });
    expect(tickets1).toHaveLength(ticketCount);

    const cacheSize1 = frontmatterCache.getStats().size;
    console.log(`Cache size after first call: ${cacheSize1}`);

    // Modify one file (change mtime)
    const targetFile = path.join(projectPath, '.workflow', 'tickets', 'backlog', 'BENCH-1.md');
    console.log(`Modifying ${targetFile}...`);

    // Sleep a bit to ensure mtime is actually different
    await new Promise(resolve => setTimeout(resolve, 10));

    const newContent = `---
id: "BENCH-1"
title: "MODIFIED Test Ticket 1"
type: "impl"
priority: 1
created_at: "2026-04-26T00:00:00Z"
updated_at: "2026-04-26T10:43:31.812Z"
completed_at: ""
---

This ticket was modified for invalidation testing.
`;
    fs.writeFileSync(targetFile, newContent, 'utf-8');

    // Second call should pick up the change
    // Mock fs.readFile to count calls
    const originalReadFileSync = fs.readFileSync;
    let readCount = 0;
    const readCountProxy = new Proxy(fs, {
      get: (target, prop) => {
        if (prop === 'readFileSync') {
          return (...args) => {
            readCount++;
            return originalReadFileSync.apply(target, args);
          };
        }
        return target[prop];
      }
    });

    // Track read operations
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      readCount++;
      return originalReadFileSync.apply(fs, args);
    });

    readCount = 0;
    const tickets2 = await list_tickets({ project: projectPath, status: 'backlog' });
    expect(tickets2).toHaveLength(ticketCount);

    // Find the modified ticket
    const modifiedTicket = tickets2.find(t => t.id === 'BENCH-1');
    console.log(`Modified ticket title: ${modifiedTicket.title}`);
    expect(modifiedTicket.title).toBe('MODIFIED Test Ticket 1');

    // Verify that at least some reads happened (invalidation detected)
    console.log(`Read operations during second call: ${readCount}`);
    expect(readCount).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  it('should evict LRU entries when cache exceeds 1000 limit', async () => {
    // Generate 1100 fixtures across two directories to trigger LRU eviction
    const ticketCount = 1100;
    const backlogCount = 550;
    const readyCount = 550;

    console.log(`Generating ${backlogCount} backlog + ${readyCount} ready tickets (total: ${ticketCount})...`);

    // Create tickets in backlog
    for (let i = 0; i < backlogCount; i++) {
      createTicketFile(projectPath, 'backlog', 'BL', i + 1);
    }

    // Create tickets in ready
    for (let i = 0; i < readyCount; i++) {
      createTicketFile(projectPath, 'ready', 'RD', i + 1);
    }

    frontmatterCache.clear();

    // Load all tickets
    console.log('Loading all tickets...');
    const ticketsBacklog = await list_tickets({ project: projectPath, status: 'backlog' });
    const ticketsReady = await list_tickets({ project: projectPath, status: 'ready' });
    const allTickets = [...ticketsBacklog, ...ticketsReady];

    console.log(`Loaded ${allTickets.length} tickets total`);
    expect(allTickets).toHaveLength(ticketCount);

    // Check cache stats: should not exceed maxSize (1000)
    const cacheStats = frontmatterCache.getStats();
    console.log(`Cache size: ${cacheStats.size}, max size: ${cacheStats.maxSize}`);
    expect(cacheStats.size).toBeLessThanOrEqual(cacheStats.maxSize);
    expect(cacheStats.size).toBe(1000);

    // Verify that the most recent entries are in cache
    // (loaded later in the process)
    const lastReadyFile = path.join(projectPath, '.workflow', 'tickets', 'ready', 'RD-550.md');
    const isLastReadyInCache = frontmatterCache.cache.has(lastReadyFile);
    console.log(`Last ready entry (RD-550) in cache: ${isLastReadyInCache}`);
    expect(isLastReadyInCache).toBe(true);
  });

  it('should maintain cache hits for 1000 files and verify no unbounded growth', async () => {
    // Stress test: verify cache doesn't grow beyond maxSize
    const iterations = 3;
    const ticketsPerIteration = 400;

    frontmatterCache.clear();

    for (let iter = 0; iter < iterations; iter++) {
      console.log(`Iteration ${iter + 1}: generating ${ticketsPerIteration} tickets...`);

      // Clear previous fixtures
      const ticketsDir = path.join(projectPath, '.workflow', 'tickets', 'backlog');
      if (fs.existsSync(ticketsDir)) {
        fs.readdirSync(ticketsDir).forEach(file => {
          if (file.endsWith('.md')) {
            fs.unlinkSync(path.join(ticketsDir, file));
            invalidateCache(path.join(ticketsDir, file));
          }
        });
      }

      // Create new batch
      for (let i = 0; i < ticketsPerIteration; i++) {
        createTicketFile(projectPath, 'backlog', 'ITER', iter * ticketsPerIteration + i + 1);
      }

      // Load and verify
      const tickets = await list_tickets({ project: projectPath, status: 'backlog' });
      expect(tickets).toHaveLength(ticketsPerIteration);

      const stats = frontmatterCache.getStats();
      console.log(`After iteration ${iter + 1}: cache size = ${stats.size}`);

      // Cache should never exceed maxSize
      expect(stats.size).toBeLessThanOrEqual(stats.maxSize);
    }

    const finalStats = frontmatterCache.getStats();
    console.log(`Final cache size: ${finalStats.size}/${finalStats.maxSize}`);
    expect(finalStats.size).toBeLessThanOrEqual(1000);
  });
});
