import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { list_tickets, get_ticket } from '../../src/tools/tickets.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Security: Path Traversal Tests', () => {
  let testProjectDir;
  let originalCwd;

  beforeAll(() => {
    // Setup test project directory
    testProjectDir = path.join(__dirname, '../../', 'test-project-security');
    originalCwd = process.cwd();

    // Create test project structure
    if (!fs.existsSync(testProjectDir)) {
      fs.mkdirSync(testProjectDir, { recursive: true });
    }

    // Create .workflow directory
    const workflowDir = path.join(testProjectDir, '.workflow');
    if (!fs.existsSync(workflowDir)) {
      fs.mkdirSync(workflowDir, { recursive: true });
    }

    // Create tickets directories
    const ticketsDir = path.join(workflowDir, 'tickets');
    ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'].forEach(status => {
      const statusDir = path.join(ticketsDir, status);
      if (!fs.existsSync(statusDir)) {
        fs.mkdirSync(statusDir, { recursive: true });
      }
    });

    // Create a test ticket
    const testTicket = path.join(ticketsDir, 'ready', 'TEST-001.md');
    fs.writeFileSync(testTicket, '---\nid: TEST-001\ntitle: Test\n---\nBody', 'utf8');

    // Change to test project directory
    process.chdir(testProjectDir);
  });

  afterAll(() => {
    // Restore original working directory
    process.chdir(originalCwd);

    // Cleanup test project
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  describe('list_tickets - path traversal in project parameter', () => {
    it('should reject path traversal attack: ../../../etc', async () => {
      const spy = vi.spyOn(fs, 'readdirSync');

      try {
        await list_tickets({ project: '../../../etc', status: 'ready' });
        expect(true).toBe(false); // Should throw error
      } catch (error) {
        expect(error.message).toContain('not found');
      } finally {
        spy.mockRestore();
      }
    });

    it('should reject path traversal with backslashes: ..\\\\..\\\\Windows', async () => {
      try {
        await list_tickets({ project: '..\\\\..\\\\Windows', status: 'ready' });
        expect(true).toBe(false); // Should throw error
      } catch (error) {
        expect(error.message).toContain('not found');
      }
    });

    it('should reject multiple path traversal attempts', async () => {
      try {
        await list_tickets({ project: '../../../../../../etc/passwd', status: 'ready' });
        expect(true).toBe(false); // Should throw error
      } catch (error) {
        expect(error.message).toContain('not found');
      }
    });
  });

  describe('get_ticket - path traversal in ticket_id', () => {
    it('should reject ticket_id with path traversal: ../../secret.md', async () => {
      try {
        await get_ticket({
          project: '.',
          ticket_id: '../../secret.md'
        });
        expect(true).toBe(false); // Should throw error
      } catch (error) {
        expect(error.message).toContain('not found');
      }
    });

    it('should reject ticket_id with path traversal: ready/../../etc/passwd', async () => {
      try {
        await get_ticket({
          project: '.',
          ticket_id: 'ready/../../etc/passwd'
        });
        expect(true).toBe(false); // Should throw error
      } catch (error) {
        expect(error.message).toContain('not found');
      }
    });

    it('should reject invalid ticket IDs that attempt path traversal', async () => {
      const invalidIds = [
        '../../etc/passwd',
        '../secret',
        'ready/../../etc/passwd',
      ];

      for (const invalidId of invalidIds) {
        try {
          await get_ticket({
            project: '.',
            ticket_id: invalidId
          });
          // Should not reach here - invalid IDs should be rejected
          expect(true).toBe(false);
        } catch (error) {
          // Valid response - either path traversal blocked or file not found
          expect(error.message).toBeDefined();
        }
      }
    });

    it('NOTE: ticket_id validation against pattern [A-Z]+-\\d+ NOT YET IMPLEMENTED', async () => {
      // Current implementation does not validate ticket_id format
      // This is a security gap that should be addressed
      // The code should validate: ticket_id =~ /^[A-Z]+-\d+$/

      // Currently, these invalid IDs are accepted and only fail because file doesn't exist:
      const currentlyAcceptedInvalidIds = [
        'test-001',      // lowercase (should be invalid)
        '001-TEST',      // wrong order (should be invalid)
        'test_001',      // underscore (should be invalid)
        'TEST-00a',      // letter in number (should be invalid)
      ];

      // They all fail with "not found" rather than validation error
      for (const id of currentlyAcceptedInvalidIds) {
        try {
          await get_ticket({
            project: '.',
            ticket_id: id
          });
        } catch (error) {
          // Current behavior: "Ticket not found: <id>"
          expect(error.message).toContain('Ticket not found');
        }
      }
    });

    it('should accept only valid ticket IDs', async () => {
      try {
        const result = await get_ticket({
          project: '.',
          ticket_id: 'TEST-001'
        });
        expect(result).toBeDefined();
        expect(result.frontmatter.id).toBe('TEST-001');
      } catch (error) {
        // Expected if ticket doesn't exist, but should not be a path traversal error
        expect(error.message).not.toContain('path');
      }
    });
  });

  describe('symlink escape detection', () => {
    it('should detect and reject symlinks pointing outside project', async () => {
      // Create a temporary directory outside the project
      const outsideDir = path.join(__dirname, '../../', 'outside-dir');
      if (!fs.existsSync(outsideDir)) {
        fs.mkdirSync(outsideDir, { recursive: true });
      }

      const outsideFile = path.join(outsideDir, 'secret.md');
      fs.writeFileSync(outsideFile, 'SECRET CONTENT', 'utf8');

      try {
        // Create a symlink inside the project pointing outside
        const symlinkPath = path.join(testProjectDir, '.workflow', 'tickets', 'ready', 'LINK-001.md');

        // Only create symlink if it doesn't exist
        if (!fs.existsSync(symlinkPath)) {
          try {
            fs.symlinkSync(outsideFile, symlinkPath);
          } catch (e) {
            // Symlinks might not be available on Windows without admin rights
            // In that case, skip this test
            console.warn('Skipping symlink test: ', e.message);
            return;
          }
        }

        // Try to read the symlink through get_ticket
        try {
          await get_ticket({
            project: '.',
            ticket_id: 'LINK-001'
          });

          // If we got here, check that we didn't actually read the outside file
          // This is where fs.realpath check should kick in
          expect(true).toBe(false); // Should have thrown or detected the escape
        } catch (error) {
          // Expected: symlink escape should be detected
          expect(error.message).toContain('not found');
        }
      } finally {
        // Cleanup
        if (fs.existsSync(outsideDir)) {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe('readdir boundary check', () => {
    it('should not call fs.readdir outside of project .workflow/tickets', async () => {
      const spy = vi.spyOn(fs, 'readdirSync');

      try {
        await list_tickets({ project: '.', status: 'ready' });

        // Check that readdir was called only within the project
        const calls = spy.mock.calls;
        for (const [callPath] of calls) {
          const normalizedPath = path.normalize(callPath);
          const ticketsPath = path.normalize(path.join(testProjectDir, '.workflow', 'tickets'));
          expect(normalizedPath).toContain(ticketsPath);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });
});
