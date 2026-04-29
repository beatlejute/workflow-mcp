/**
 * Startup guard: verify workflow-ai version compatibility.
 * Checks that workflow-ai major=1, minor>=2.
 *
 * Note: implemented without the `semver` package on purpose — the only check we
 * perform is "major matches expected, minor >= expected". A regex parser is
 * sufficient and avoids pulling in a transitive dependency that is not
 * declared in package.json.
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;
const RANGE_RE = /^[\^~]?(\d+)\.(\d+)\.(\d+)/;

/**
 * Parse a plain semver-ish version string (X.Y.Z[...]).
 * @param {string} version
 * @returns {{major:number, minor:number, patch:number}|null}
 */
function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Parse a npm-style range like "^1.2.0", "~1.2.0", "1.2.0".
 * Only caret/tilde/exact prefixes are supported — sufficient for our gate.
 * @param {string} range
 * @returns {{major:number, minor:number, patch:number}|null}
 */
function parseRangeMin(range) {
  if (typeof range !== 'string') return null;
  const m = RANGE_RE.exec(range.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Check whether actualVersion satisfies a caret/tilde/exact range.
 * @param {{major:number, minor:number, patch:number}} actual
 * @param {string} range
 */
function satisfies(actual, range) {
  const min = parseRangeMin(range);
  if (!min) return false;
  if (range.startsWith('^')) {
    if (actual.major !== min.major) return false;
    if (actual.minor < min.minor) return false;
    if (actual.minor === min.minor && actual.patch < min.patch) return false;
    return true;
  }
  if (range.startsWith('~')) {
    if (actual.major !== min.major) return false;
    if (actual.minor !== min.minor) return false;
    return actual.patch >= min.patch;
  }
  // exact
  return actual.major === min.major && actual.minor === min.minor && actual.patch === min.patch;
}

/**
 * Verify workflow-ai version matches expected range.
 * @param {string} expectedRange e.g. "^1.2.0"
 * @throws {Error} If workflow-ai package cannot be resolved or major mismatches.
 * @returns {string} Actual workflow-ai version string.
 */
export function verifyWorkflowAiVersion(expectedRange) {
  let actualVersion;
  let pkgPath = null;

  try {
    const require = createRequire(import.meta.url);
    // Anchor on a known-exported subpath; package.json itself is not in `exports`.
    // WORKFLOW_AI_RESOLVE_PATH overrides resolution base (used in tests for version isolation).
    const resolveOpts = process.env.WORKFLOW_AI_RESOLVE_PATH
      ? { paths: [process.env.WORKFLOW_AI_RESOLVE_PATH] }
      : undefined;
    const anchor = require.resolve('workflow-ai/lib/find-root.mjs', resolveOpts);
    let dir = path.dirname(anchor);

    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.name === 'workflow-ai') {
          actualVersion = pkg.version;
          pkgPath = candidate;
          break;
        }
      }
      dir = path.dirname(dir);
    }

    if (!pkgPath) {
      throw new Error('workflow-ai package.json not found near resolved entry');
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('workflow-ai not found. Run npm install.');
    }
    throw new Error(`unexpected error checking workflow-ai version: ${err.message}`);
  }

  const actual = parseVersion(actualVersion);
  const expectedMin = parseRangeMin(expectedRange);

  if (!actual) {
    throw new Error(`unexpected workflow-ai version format: ${actualVersion}`);
  }

  if (!satisfies(actual, expectedRange)) {
    // Major mismatch — fatal.
    if (expectedMin && actual.major !== expectedMin.major) {
      throw new Error(
        `workflow-ai major version mismatch (expected ${expectedRange}, got ${actualVersion})`
      );
    }
    // Minor below expected — warning only (compat band).
    if (expectedMin && actual.minor < expectedMin.minor) {
      console.error(
        `[workflow-mcp] WARNING: workflow-ai version below expected (expected ${expectedRange}, got ${actualVersion}); continuing startup`
      );
    }
  }

  return actualVersion;
}

/**
 * Validate that workflow-ai version is at least 1.2.0 (major=1, minor>=2).
 * @param {string} actualVersion The version to validate
 * @throws {Error} If version does not meet requirements
 * @returns {true}
 */
export function validateStartupVersion(actualVersion) {
  const parsed = parseVersion(actualVersion);
  if (!parsed) {
    throw new Error(`invalid version format: ${actualVersion}`);
  }

  if (parsed.major !== 1) {
    throw new Error(
      `workflow-ai major version mismatch (expected major=1, got major=${parsed.major})`
    );
  }

  if (parsed.minor < 2) {
    throw new Error(
      `workflow-ai minor version too old (expected minor>=2, got minor=${parsed.minor})`
    );
  }

  return true;
}
