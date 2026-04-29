import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    pool: 'forks',
    // Run all test files in a single fork to prevent process.chdir() conflicts
    // and parallel resource contention. Each test file still runs in isolation
    // via vitest's module registry reset between files.
    singleFork: true,
    exclude: [
      // Non-vitest test scripts (use process.exit or node:test API)
      '.workflow/**',
      '.kilocode/**',
      // Script-style test (not proper vitest suite, references IMPL-5.md hardcoded path)
      'src/caches/frontmatter-cache.test.mjs',
      // Uses assert module only, no vitest describe/it, tests non-existent default export
      'tests/tools/check-pipeline-health.test.mjs',
      // Default vitest excludes
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
