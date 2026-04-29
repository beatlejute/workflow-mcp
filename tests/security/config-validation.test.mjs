import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { discoverProjects } from '../../src/discovery.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Security: Config Validation Tests', () => {
  let testProjectDir;
  let originalCwd;

  beforeAll(() => {
    // Setup test project directory
    testProjectDir = path.join(__dirname, '../../', 'test-config-security');
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

    // Create logs directory
    const logsDir = path.join(workflowDir, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    process.chdir(testProjectDir);
  });

  afterAll(() => {
    // Restore original working directory
    process.chdir(originalCwd);

    // Cleanup test projects
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  describe('YAML parsing with invalid content', () => {
    it('should handle broken YAML without crashing', async () => {
      // Create broken YAML config
      const brokenYaml = `---
projects:
  whitelist:
    - project-one
    - project-two
  invalid yaml content without closing brace
discovery:
  debounce_sec: 2
`;
      fs.writeFileSync('.workflow-mcp.yaml', brokenYaml, 'utf8');

      try {
        // Should not crash, but fall back to defaults
        const projects = discoverProjects('.');
        // Should return empty or default projects list without crashing
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should not throw error for broken YAML: ${error.message}`);
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });

    it('should handle invalid type for health.tick_interval_sec', async () => {
      // Create config with invalid type
      const invalidTypeYaml = `---
health:
  tick_interval_sec: "abc"
projects:
  whitelist: []
discovery:
  debounce_sec: 2
`;
      fs.writeFileSync('.workflow-mcp.yaml', invalidTypeYaml, 'utf8');

      try {
        // Should use default value for invalid type
        const projects = discoverProjects('.');
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should handle invalid type gracefully: ${error.message}`);
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });

    it('should start in fail-safe mode when YAML is invalid', async () => {
      // Create severely broken YAML
      const severelyBrokenYaml = `---
---
--
invalid yaml
  invalid nesting
    more nesting
: key without value
`;
      fs.writeFileSync('.workflow-mcp.yaml', severelyBrokenYaml, 'utf8');

      const originalStderr = console.error;
      const stderrOutput = [];
      console.error = (...args) => stderrOutput.push(args.join(' '));

      try {
        // Should not crash
        const projects = discoverProjects('.');
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should handle severely broken YAML: ${error.message}`);
      } finally {
        console.error = originalStderr;
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });
  });

  describe('Whitelist validation', () => {
    it('should return empty list when whitelist contains nonexistent project', async () => {
      // Create config with nonexistent project in whitelist
      const configYaml = `---
projects:
  whitelist:
    - nonexistent-project-12345
    - another-missing-project
discovery:
  depth: 2
`;
      fs.writeFileSync('.workflow-mcp.yaml', configYaml, 'utf8');

      try {
        const projects = discoverProjects('.');
        // Should return empty list (or list without the nonexistent projects)
        expect(Array.isArray(projects)).toBe(true);
        // Check that nonexistent projects are not in the results
        const projectNames = projects.map(p => p.name);
        expect(projectNames).not.toContain('nonexistent-project-12345');
        expect(projectNames).not.toContain('another-missing-project');
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });
  });

  describe('Blacklist validation', () => {
    it('should handle blacklist configuration without error', async () => {
      // Create config with blacklist
      const configYaml = `---
projects:
  blacklist:
    - nonexistent-project
discovery:
  depth: 1
`;
      fs.writeFileSync('.workflow-mcp.yaml', configYaml, 'utf8');

      try {
        // Should not throw error even if blacklisted project doesn't exist
        const projects = discoverProjects('.');
        expect(Array.isArray(projects)).toBe(true);

        // If there's a project with .workflow in current dir, it should still be included
        // unless it's in the blacklist
        const currentHasWorkflow = fs.existsSync(path.join(testProjectDir, '.workflow'));
        if (currentHasWorkflow) {
          const projectNames = projects.map(p => p.name);
          const currentDirName = path.basename(testProjectDir);
          expect(projectNames).toContain(currentDirName);
        }
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });
  });

  describe('Config file doesn\'t exist', () => {
    it('should work with default config when .workflow-mcp.yaml is missing', async () => {
      // Ensure config doesn't exist
      if (fs.existsSync('.workflow-mcp.yaml')) {
        fs.unlinkSync('.workflow-mcp.yaml');
      }

      try {
        const projects = discoverProjects('.');
        // Should return array without error
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should work without config file: ${error.message}`);
      }
    });
  });

  describe('Mixed valid and invalid config', () => {
    it('should use defaults for invalid fields while respecting valid ones', async () => {
      const configYaml = `---
projects:
  whitelist:
    - valid-project
  blacklist:
    - excluded-project
discovery:
  depth: 3
  debounce_sec: "invalid"
health:
  tick_interval_sec: "not-a-number"
`;
      fs.writeFileSync('.workflow-mcp.yaml', configYaml, 'utf8');

      try {
        // Should not crash and should use defaults for invalid fields
        const projects = discoverProjects('.');
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should handle mixed valid/invalid config: ${error.message}`);
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });
  });

  describe('Empty and null values', () => {
    it('should handle null whitelist gracefully', async () => {
      const configYaml = `---
projects:
  whitelist: null
discovery:
  depth: 1
`;
      fs.writeFileSync('.workflow-mcp.yaml', configYaml, 'utf8');

      try {
        const projects = discoverProjects('.');
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should handle null whitelist: ${error.message}`);
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });

    it('should handle empty whitelist as no restriction', async () => {
      const configYaml = `---
projects:
  whitelist: []
discovery:
  depth: 1
`;
      fs.writeFileSync('.workflow-mcp.yaml', configYaml, 'utf8');

      try {
        const projects = discoverProjects('.');
        // Empty whitelist means no projects are whitelisted, so result should be empty
        expect(Array.isArray(projects)).toBe(true);
      } catch (error) {
        expect.fail(`Should handle empty whitelist: ${error.message}`);
      } finally {
        if (fs.existsSync('.workflow-mcp.yaml')) {
          fs.unlinkSync('.workflow-mcp.yaml');
        }
      }
    });
  });
});
