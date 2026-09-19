import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  get_workflow_project_config_pipeline,
  get_workflow_project_config_ticket_movement_rules,
  resources_list_config
} from '../../src/resources/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create temporary test projects for each test
let testProjectDir;
let testCwd;

beforeAll(() => {
  // Create a temporary directory for test projects
  testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  testCwd = testProjectDir;

  // Create a test project structure
  const projectPath = path.join(testProjectDir, 'test-project');
  fs.mkdirSync(projectPath, { recursive: true });

  // Create .workflow/config directory (именно так его создаёт `workflow init`)
  const configsDir = path.join(projectPath, '.workflow', 'config');
  fs.mkdirSync(configsDir, { recursive: true });

  // Create pipeline.yaml
  const pipelineYaml = `stages:
  - name: build
    steps:
      - run: npm install
      - run: npm run build
  - name: test
    steps:
      - run: npm test
`;
  fs.writeFileSync(path.join(configsDir, 'pipeline.yaml'), pipelineYaml, 'utf-8');

  // Create ticket-movement-rules.yaml
  const ticketRulesYaml = `rules:
  - from: backlog
    to: ready
    condition: priority >= 1
  - from: ready
    to: in-progress
    condition: assigned == true
  - from: in-progress
    to: review
    condition: pr_created == true
  - from: review
    to: done
    condition: approved == true
`;
  fs.writeFileSync(path.join(configsDir, 'ticket-movement-rules.yaml'), ticketRulesYaml, 'utf-8');
});

afterAll(() => {
  // Clean up temporary directory
  if (testProjectDir && fs.existsSync(testProjectDir)) {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  }
});

describe('Config Resources', () => {

  describe('resources_list_config()', () => {
    it('should return array of config resources', () => {
      const list = resources_list_config(testCwd);
      expect(Array.isArray(list)).toBe(true);
    });

    it('should contain pipeline config resource', () => {
      const list = resources_list_config(testCwd);
      const pipelineUri = list.find(r => r.uri.includes('config/pipeline'));
      expect(pipelineUri).toBeDefined();
      if (pipelineUri) {
        expect(pipelineUri.uri).toMatch(/workflow:\/\/[a-z-]+\/config\/pipeline/);
        expect(pipelineUri.format).toBe('YAML');
        expect(pipelineUri.mimeType).toBe('application/yaml');
      }
    });

    it('should contain ticket-movement-rules config resource', () => {
      const list = resources_list_config(testCwd);
      const rulesUri = list.find(r => r.uri.includes('config/ticket-movement-rules'));
      expect(rulesUri).toBeDefined();
      if (rulesUri) {
        expect(rulesUri.uri).toMatch(/workflow:\/\/[a-z-]+\/config\/ticket-movement-rules/);
        expect(rulesUri.format).toBe('YAML');
        expect(rulesUri.mimeType).toBe('application/yaml');
      }
    });

    it('each config resource should have required fields', () => {
      const list = resources_list_config(testCwd);
      list.forEach(item => {
        expect(item).toHaveProperty('uri');
        expect(item).toHaveProperty('format');
        expect(item).toHaveProperty('description');
        expect(item).toHaveProperty('mimeType');
        expect(item.mimeType).toBe('application/yaml');
      });
    });
  });

  describe('get_workflow_project_config_pipeline()', () => {
    it('should read pipeline.yaml content correctly', async () => {
      const result = await get_workflow_project_config_pipeline(testCwd, 'test-project');
      expect(result).toBeDefined();
      expect(result.uri).toBe('workflow://test-project/config/pipeline');
      expect(result.text).toContain('stages:');
      expect(result.text).toContain('build');
      expect(result.text).toContain('test');
    });

    it('should have correct MIME type', async () => {
      const result = await get_workflow_project_config_pipeline(testCwd, 'test-project');
      expect(result.mimeType).toBe('application/yaml');
    });

    it('should throw RESOURCE_NOT_FOUND for non-existent project', async () => {
      try {
        await get_workflow_project_config_pipeline(testCwd, 'non-existent-project');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
        expect(err.message).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should throw RESOURCE_NOT_FOUND if pipeline.yaml does not exist', async () => {
      // Create a project without pipeline.yaml
      const projectPath = path.join(testProjectDir, 'no-pipeline-project');
      fs.mkdirSync(projectPath, { recursive: true });
      const configsDir = path.join(projectPath, '.workflow', 'config');
      fs.mkdirSync(configsDir, { recursive: true });

      try {
        await get_workflow_project_config_pipeline(testCwd, 'no-pipeline-project');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
        expect(err.message).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject path traversal with .. in project name', async () => {
      try {
        await get_workflow_project_config_pipeline(testCwd, '../malicious');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject path traversal with backslash in project name', async () => {
      try {
        await get_workflow_project_config_pipeline(testCwd, 'test\\..\\escape');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject forward slash in project name', async () => {
      try {
        await get_workflow_project_config_pipeline(testCwd, 'test/invalid');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });
  });

  describe('get_workflow_project_config_ticket_movement_rules()', () => {
    it('should read ticket-movement-rules.yaml content correctly', async () => {
      const result = await get_workflow_project_config_ticket_movement_rules(testCwd, 'test-project');
      expect(result).toBeDefined();
      expect(result.uri).toBe('workflow://test-project/config/ticket-movement-rules');
      expect(result.text).toContain('rules:');
      expect(result.text).toContain('backlog');
      expect(result.text).toContain('ready');
      expect(result.text).toContain('in-progress');
      expect(result.text).toContain('review');
      expect(result.text).toContain('done');
    });

    it('should have correct MIME type', async () => {
      const result = await get_workflow_project_config_ticket_movement_rules(testCwd, 'test-project');
      expect(result.mimeType).toBe('application/yaml');
    });

    it('should throw RESOURCE_NOT_FOUND for non-existent project', async () => {
      try {
        await get_workflow_project_config_ticket_movement_rules(testCwd, 'non-existent-project');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
        expect(err.message).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should throw RESOURCE_NOT_FOUND if ticket-movement-rules.yaml does not exist', async () => {
      // Create a project without ticket-movement-rules.yaml
      const projectPath = path.join(testProjectDir, 'no-rules-project');
      fs.mkdirSync(projectPath, { recursive: true });
      const configsDir = path.join(projectPath, '.workflow', 'config');
      fs.mkdirSync(configsDir, { recursive: true });

      try {
        await get_workflow_project_config_ticket_movement_rules(testCwd, 'no-rules-project');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
        expect(err.message).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject path traversal with .. in project name', async () => {
      try {
        await get_workflow_project_config_ticket_movement_rules(testCwd, '../malicious');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject path traversal with backslash in project name', async () => {
      try {
        await get_workflow_project_config_ticket_movement_rules(testCwd, 'test\\..\\escape');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('should reject forward slash in project name', async () => {
      try {
        await get_workflow_project_config_ticket_movement_rules(testCwd, 'test/invalid');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
      }
    });
  });

  describe('File content validation', () => {
    it('pipeline.yaml content should match expected YAML structure', async () => {
      const result = await get_workflow_project_config_pipeline(testCwd, 'test-project');
      expect(result.text).toMatch(/^stages:/m);
      expect(result.text).toMatch(/- name: build/);
      expect(result.text).toMatch(/- name: test/);
      expect(result.text).toMatch(/npm install/);
      expect(result.text).toMatch(/npm run build/);
      expect(result.text).toMatch(/npm test/);
    });

    it('ticket-movement-rules.yaml content should match expected YAML structure', async () => {
      const result = await get_workflow_project_config_ticket_movement_rules(testCwd, 'test-project');
      expect(result.text).toMatch(/^rules:/m);
      expect(result.text).toMatch(/- from: backlog/);
      expect(result.text).toMatch(/- from: ready/);
      expect(result.text).toMatch(/- from: in-progress/);
      expect(result.text).toMatch(/- from: review/);
      expect(result.text).toMatch(/to: done/);
    });
  });

  describe('URI format validation', () => {
    it('pipeline resource URI should follow workflow://{project}/config/pipeline pattern', async () => {
      const result = await get_workflow_project_config_pipeline(testCwd, 'test-project');
      expect(result.uri).toMatch(/^workflow:\/\/test-project\/config\/pipeline$/);
    });

    it('ticket-movement-rules resource URI should follow workflow://{project}/config/ticket-movement-rules pattern', async () => {
      const result = await get_workflow_project_config_ticket_movement_rules(testCwd, 'test-project');
      expect(result.uri).toMatch(/^workflow:\/\/test-project\/config\/ticket-movement-rules$/);
    });
  });
});
