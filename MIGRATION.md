# Migration Guide: Upgrading to workflow-mcp 1.1.0

This guide helps you upgrade from workflow-mcp 1.0.0 to 1.1.0 (Sprint 2), which introduces pipeline controls, approvals, and cross-platform process management.

## Overview

workflow-mcp 1.1.0 adds 12 new tools for managing pipeline execution, 4 new resources, and requires `workflow-ai@^1.2.0` for full functionality. Key features include:

- **Pipeline Controls**: Start, pause, resume, abort, and stop pipelines
- **Approvals**: Manual gate steps with `approve_step` tool
- **Cross-Platform Process Control**: POSIX signals and Windows taskkill
- **Enhanced Monitoring**: Pipeline state resource and approval alerts

## Breaking Changes

### None

There are **no breaking changes** in this release. All 1.0.0 functionality remains intact and backward-compatible.

## Prerequisites

### 1. Update workflow-ai Dependency

To use **manual gate approvals**, you need `workflow-ai@^1.2.0`:

```bash
# Update npm dependency
npm install workflow-ai@^1.2.0
```

**Note**: Without `workflow-ai@1.2.0+`:
- Pipeline control tools (`pause`, `resume`, `abort`, `stop`, `start`, `list_running_pipelines`) work normally
- `approve_step` returns `RUNNER_VERSION_TOO_OLD`
- Manual gate stages will not create approval files

### 2. Windows Users: Install PsTools (Optional)

For `pause_pipeline` and `resume_pipeline` on Windows:

```powershell
# Download PsTools from Microsoft Sysinternals
# https://docs.microsoft.com/en-us/sysinternals/downloads/psexec

# Extract pssuspend.exe to a directory in PATH
# Example: C:\Windows\System32\ or C:\Tools\
```

Without `pssuspend.exe`:
- `pause_pipeline` returns `{error: "PAUSE_UNSUPPORTED", hint: "install Sysinternals PsTools"}`
- `resume_pipeline` returns `RESUME_UNSUPPORTED`
- `abort_pipeline` and `stop_pipeline` still work (use `taskkill`)

## Configuration Changes

### New Configuration Options

Add these to your `.workflow-mcp.yaml`:

```yaml
# Coalescing window for notifications (milliseconds)
# Default: 200
# Reduce for fewer notifications, increase for more batching
notifications:
  coalesce_window_ms: 200

# Health monitoring: approval pending threshold (seconds)
# Default: 600 (10 minutes)
# Alert when an approval is pending longer than this
health:
  approval_pending_threshold_sec: 600

# Existing health settings (unchanged)
  tick_interval_sec: 15
  stuck_headroom_sec: 60
  blocked_accumulation_threshold: 5
  ghost_execution_log_marker: "ghost-execution"
  crash_mtime_freshness_sec: 60
  dedup_fingerprint_ttl_sec: 3600
```

### Environment Variable

**`WORKFLOW_MCP_FORCE_FOREIGN=1`**

Override foreign pipeline protection (use with caution):

```bash
# Allow killing pipelines started by other MCP instances
WORKFLOW_MCP_FORCE_FOREIGN=1 claude
```

**Warning**: This disables protection against accidentally killing pipelines owned by other MCP instances. Only use in emergency scenarios or controlled environments.

## New Capabilities

### Pipeline Control Tools

#### Start a Pipeline

```javascript
const result = await client.callTool('start_pipeline', {
  project: 'MyProject',
  options: {
    detach: true,  // Run in background (default: true)
    env: { CUSTOM_VAR: 'value' }  // Optional environment variables
  }
});

// Returns:
// { run_id: "pipeline_2026-04-27_10-00-00", pid: 12345, started_at: "...", log_path: "..." }
```

#### Pause and Resume

```javascript
// Pause
await client.callTool('pause_pipeline', { project: 'MyProject' });
// { ok: true, pid: 12345, state: "paused", paused_at: "..." }

// Resume
await client.callTool('resume_pipeline', { project: 'MyProject' });
// { ok: true, pid: 12345, state: "running" }
```

#### Graceful Abort

```javascript
// Abort with 10-second grace period (default)
await client.callTool('abort_pipeline', {
  project: 'MyProject',
  options: { grace_sec: 10 }
});
// { pid: 12345, state: "aborted", duration_ms: 10123, escalated: false }

// Immediate abort (grace_sec=0)
await client.callTool('abort_pipeline', {
  project: 'MyProject',
  options: { grace_sec: 0 }
});
// { pid: 12345, state: "aborted", duration_ms: 123, escalated: true }
```

#### Force Stop

```javascript
// Hard kill (SIGKILL on POSIX, taskkill /F on Windows)
await client.callTool('stop_pipeline', {
  project: 'MyProject',
  options: { force: true }  // Override marker validation
});
// { ok: true, pid: 12345, state: "killed" }
```

#### List Running Pipelines

```javascript
const pipelines = await client.callTool('list_running_pipelines', {});

// Returns:
// [
//   {
//     project: "MyProject",
//     pid: 12345,
//     state: "running",  // running|paused|aborting|killed|stale
//     current_stage: "test",
//     step_number: 42,
//     awaiting_approval: { step_id: "step-142", since: "..." },
//     marker_valid: true,
//     foreign: false,
//     run_id: "pipeline_2026-04-27_10-00-00",
//     started_at: "...",
//     last_log_at: "..."
//   }
// ]
```

### Manual Approvals

When using `workflow-ai@1.2.0+`, define manual gates in your pipeline:

```yaml
# .workflow/configs/pipeline.yaml
stages:
  - id: step-142
    type: manual-gate
    title: "Production Approval"
    description: "Review and approve before production deployment"
```

Then approve programmatically:

```javascript
const result = await client.callTool('approve_step', {
  project: 'MyProject',
  step_id: 'step-142',
  decision: 'approve',  // or 'reject'
  comment: 'All checks passed. Proceeding to production.'
});

// Returns:
// { step_id: "step-142", decision: "approve", decided_at: "..." }
```

### Pipeline State Resource

Subscribe to real-time pipeline state changes:

```javascript
const unsubscribe = await client.subscribe(
  'workflow://pipeline-state',
  (resource) => {
    const pipelines = JSON.parse(resource.text);
    console.log('Pipeline state updated:', pipelines);
  }
);

// Later, unsubscribe
unsubscribe();
```

### Pipeline Logs

```javascript
// Get latest log (last 200 lines)
const log = await client.callTool('get_pipeline_log', {
  project: 'MyProject',
  tail_lines: 200
});

// With cursor for incremental reading
const log = await client.callTool('get_pipeline_log', {
  project: 'MyProject',
  cursor: 1024  // Byte offset from previous read
});
```

## Migration Checklist

- [ ] Update `package.json` to `workflow-ai@^1.2.0` (optional for full features)
- [ ] Add `.workflow-mcp.yaml` configuration (or update existing)
- [ ] Install PsTools on Windows (for pause/resume)
- [ ] Update automation scripts to use new pipeline control tools
- [ ] Configure notification coalescing window if needed
- [ ] Set `approval_pending_threshold_sec` for your workflow
- [ ] Test foreign pipeline protection in your environment
- [ ] Update documentation for your team

## Troubleshooting

### Pause/Resume Not Working on Windows

**Symptom**: `PAUSE_UNSUPPORTED` error

**Solution**: Install PsTools and ensure `pssuspend.exe` is in PATH:

```powershell
# Download PsTools
# Add to PATH or copy pssuspend.exe to C:\Windows\System32\
```

### Foreign Pipeline Error

**Symptom**: `FOREIGN_PIPELINE` or `MARKER_VALIDATION_FAILED`

**Cause**: Pipeline was started outside MCP (e.g., via CLI)

**Solution**:
```bash
# Option 1: Use force=true (stop_pipeline only)
claude mcp call stop_pipeline --project MyProject --options '{"force": true}'

# Option 2: Set environment variable
export WORKFLOW_MCP_FORCE_FOREIGN=1
```

### Approval Tool Returns RUNNER_VERSION_TOO_OLD

**Symptom**: `approve_step` fails with version error

**Solution**: Update workflow-ai:
```bash
npm install workflow-ai@^1.2.0
```

### No Notifications Received

**Symptom**: `resources/updated` not firing

**Check**:
1. Coalescing window may be batching notifications (default 200ms)
2. Verify subscription is active
3. Check pipeline state is actually changing

## Rollback Plan

If issues occur, rollback to 1.0.0:

```bash
npm install workflow-ai@1.0.0
```

**Note**: Pipeline control tools will still function, but:
- Manual gate approvals won't work
- Some new fields may be absent from `list_running_pipelines`

## Upgrading to workflow-mcp 1.2.0 (Sprint 3)

### New Configuration Options

#### Strict Human Ticket Validation

You can enable strict validation for HUMAN ticket results by adding the following to your `.workflow-mcp.yaml`:

```yaml
human_ticket:
  strict_validation: true
```

When enabled, `resolve_human_ticket` will require:
- Result body length ≥ 50 characters (configurable via `min_result_length`)
- Presence of evidence (URL, file path, or code block) unless `evidence_required` is set to `false`

Custom validation rules can be added in a `human-task-rules.md` file at the project root using a simple format:

```markdown
- rule: https?://[^\s]+ | External link required
- rule: \.png|\.jpg | Screenshot evidence
```

#### Branch Divergence Detection

Configure thresholds for Git branch divergence alerts:

```yaml
health:
  branch_diverged_max_behind: 10   # Warn if behind remote by >10 commits
  branch_diverged_max_ahead: 30    # Warn if ahead of remote by >30 commits
  branch_diverged_auto_fetch: false # Set true to run `git fetch` before check (default false)
```

The detector runs automatically during health checks for all Git projects.

### Additional Runtime Dependencies

Some new tools require external binaries:

- **ripgrep** (`rg`) — required for `cross_project_search`. Install from https://ripgrep.org or your package manager.
- **Git** — required for all `git_*` tools.
- **GitHub CLI** (`gh`) — optional, required only for `git_open_pr`. Install from https://cli.github.com/.

No changes to `workflow-ai` dependency are required; `^1.2.0` remains compatible.

## Additional Resources

- [README.md](README.md) — Full documentation with examples
- [PLAN-002.md](.workflow/plans/current/PLAN-002.md) — Sprint 2 implementation plan
- [workflow-ai releases](https://github.com/yourusername/workflow-ai/releases) — Changelog for dependency updates