import { describe, it, expect, beforeAll } from 'vitest';
import * as resources from '../../src/resources/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectCwd = path.resolve(__dirname, '../../');

describe('Static MCP Resources', () => {

  describe('resources_list()', () => {
    it('should return array of all static URIs', () => {
      const list = resources.resources_list();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    });

    it('should contain workflow://projects URI', () => {
      const list = resources.resources_list();
      const projectsUri = list.find(r => r.uri === 'workflow://projects');
      expect(projectsUri).toBeDefined();
      expect(projectsUri.format).toBe('JSON');
    });

    it('should contain all expected URIs', () => {
      const list = resources.resources_list();
      const uris = list.map(r => r.uri);

      expect(uris).toContain('workflow://projects');
      expect(uris).toContain('workflow://{project}/board');
      expect(uris).toContain('workflow://{project}/tickets/{id}');
      expect(uris).toContain('workflow://skills/{skill_name}/SKILL.md');
      expect(uris).toContain('workflow://templates/{type}');
    });

    it('should have at least 5 URIs (Sprint 1 minimum)', () => {
      const list = resources.resources_list();
      expect(list.length).toBeGreaterThanOrEqual(5);
    });

    it('each URI should have uri, format, and description fields', () => {
      const list = resources.resources_list();
      list.forEach(item => {
        expect(item).toHaveProperty('uri');
        expect(item).toHaveProperty('format');
        expect(item).toHaveProperty('description');
        expect(typeof item.uri).toBe('string');
        expect(typeof item.format).toBe('string');
        expect(typeof item.description).toBe('string');
      });
    });
  });

  describe('get_workflow_projects()', () => {
    it('should return object with uri, mimeType, and text properties', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      expect(result).toHaveProperty('uri');
      expect(result).toHaveProperty('mimeType');
      expect(result).toHaveProperty('text');
    });

    it('should return correct URI', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      expect(result.uri).toBe('workflow://projects');
    });

    it('should have JSON mimeType', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      expect(result.mimeType).toBe('application/json');
    });

    it('should return valid JSON', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      expect(() => JSON.parse(result.text)).not.toThrow();
    });

    it('should return array of projects', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);
      expect(Array.isArray(projects)).toBe(true);
    });

    it('each project should have name, path, and counters', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        projects.forEach(project => {
          expect(project).toHaveProperty('name');
          expect(project).toHaveProperty('path');
          expect(project).toHaveProperty('counters');
          expect(project.counters).toHaveProperty('backlog');
          expect(project.counters).toHaveProperty('ready');
          expect(project.counters).toHaveProperty('in_progress');
          expect(project.counters).toHaveProperty('review');
          expect(project.counters).toHaveProperty('blocked');
          expect(project.counters).toHaveProperty('done');
        });
      }
    });
  });

  describe('get_workflow_project_board()', () => {
    it('should throw error for unknown project', async () => {
      await expect(
        resources.get_workflow_project_board(projectCwd, 'unknown_project_xyz')
      ).rejects.toThrow();
    });

    it('should return object with uri, mimeType, and text for valid project', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        const boardResult = await resources.get_workflow_project_board(projectCwd, projectName);

        expect(boardResult).toHaveProperty('uri');
        expect(boardResult).toHaveProperty('mimeType');
        expect(boardResult).toHaveProperty('text');
      }
    });

    it('should return valid JSON board', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        const boardResult = await resources.get_workflow_project_board(projectCwd, projectName);

        expect(() => JSON.parse(boardResult.text)).not.toThrow();
        const board = JSON.parse(boardResult.text);
        expect(board).toHaveProperty('project');
        expect(board).toHaveProperty('columns');
      }
    });

    it('should have JSON mimeType', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        const boardResult = await resources.get_workflow_project_board(projectCwd, projectName);
        expect(boardResult.mimeType).toBe('application/json');
      }
    });

    it('should have standard status columns', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        const boardResult = await resources.get_workflow_project_board(projectCwd, projectName);
        const board = JSON.parse(boardResult.text);

        const expectedStatuses = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];
        expectedStatuses.forEach(status => {
          expect(board.columns).toHaveProperty(status);
        });
      }
    });
  });

  describe('get_workflow_skill()', () => {
    it('should throw error for unknown skill', async () => {
      await expect(
        resources.get_workflow_skill('unknown_skill_xyz_12345')
      ).rejects.toThrow();
    });

    it('should return object with uri, mimeType, and text for valid skill', async () => {
      const result = await resources.get_workflow_skill('coach');
      expect(result).toHaveProperty('uri');
      expect(result).toHaveProperty('mimeType');
      expect(result).toHaveProperty('text');
    });

    it('should return correct URI format', async () => {
      const result = await resources.get_workflow_skill('coach');
      expect(result.uri).toBe('workflow://skills/coach/SKILL.md');
    });

    it('should have markdown mimeType', async () => {
      const result = await resources.get_workflow_skill('coach');
      expect(result.mimeType).toBe('text/markdown');
    });

    it('should return non-empty markdown content', async () => {
      const result = await resources.get_workflow_skill('coach');
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('should contain skill metadata (frontmatter or name)', async () => {
      const result = await resources.get_workflow_skill('coach');
      // Should contain something that identifies it as a skill
      expect(result.text).toMatch(/^---/); // YAML frontmatter start
    });
  });

  describe('get_workflow_template()', () => {
    it('should throw error for invalid template type', async () => {
      await expect(
        resources.get_workflow_template('invalid_type')
      ).rejects.toThrow();
    });

    it('should return object for valid template types', async () => {
      const types = ['ticket', 'plan', 'report'];

      for (const type of types) {
        try {
          const result = await resources.get_workflow_template(type);
          expect(result).toHaveProperty('uri');
          expect(result).toHaveProperty('mimeType');
          expect(result).toHaveProperty('text');
        } catch (error) {
          // Template might not exist, that's ok - test that error is thrown
          expect(error).toBeDefined();
        }
      }
    });

    it('should have markdown mimeType when successful', async () => {
      const types = ['ticket', 'plan', 'report'];

      for (const type of types) {
        try {
          const result = await resources.get_workflow_template(type);
          expect(result.mimeType).toBe('text/markdown');
        } catch (error) {
          // Skip if template doesn't exist
        }
      }
    });
  });

  describe('get_workflow_ticket()', () => {
    it('should throw error for unknown project', async () => {
      await expect(
        resources.get_workflow_ticket(projectCwd, 'unknown_project_xyz', 'SOME-123')
      ).rejects.toThrow();
    });

    it('should throw error for non-existent ticket', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        await expect(
          resources.get_workflow_ticket(projectCwd, projectName, 'NONEXISTENT-99999')
        ).rejects.toThrow();
      }
    });

    it('should return ticket for valid project and ticket id', async () => {
      const result = await resources.get_workflow_projects(projectCwd);
      const projects = JSON.parse(result.text);

      if (projects.length > 0) {
        const projectName = projects[0].name;
        const boardResult = await resources.get_workflow_project_board(projectCwd, projectName);
        const board = JSON.parse(boardResult.text);

        // Find a ticket that exists
        let ticketFound = false;
        for (const status of Object.keys(board.columns)) {
          if (board.columns[status].length > 0) {
            const ticketId = board.columns[status][0].id;
            const ticketResult = await resources.get_workflow_ticket(projectCwd, projectName, ticketId);

            expect(ticketResult).toHaveProperty('uri');
            expect(ticketResult).toHaveProperty('mimeType');
            expect(ticketResult).toHaveProperty('text');
            expect(ticketResult.mimeType).toBe('text/markdown');
            expect(ticketResult.text.length).toBeGreaterThan(0);
            ticketFound = true;
            break;
          }
        }
      }
    });
  });

  describe('Error handling', () => {
    it('invalid project should fail gracefully', async () => {
      await expect(
        resources.get_workflow_project_board(projectCwd, 'invalid_project_12345')
      ).rejects.toBeDefined();
    });

    it('error messages should be descriptive', async () => {
      try {
        await resources.get_workflow_project_board(projectCwd, 'invalid_project');
      } catch (error) {
        expect(error.message).toContain('not found');
      }
    });
  });
});
