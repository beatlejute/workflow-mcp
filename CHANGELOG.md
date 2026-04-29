# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-27

### Added

#### Pipeline Controls (12 new tools)
- **`start_pipeline(project, {detach?, env?})`** — Start a pipeline for a project by spawning `workflow run`. Returns `{run_id, pid, started_at, log_path}`.
- **`pause_pipeline(project)`** — Pause a running pipeline via `SIGSTOP` (POSIX) or `pssuspend.exe` (Windows). Returns `{pid, state: "paused", paused_at}`.
- **`resume_pipeline(project)`** — Resume a paused pipeline via `SIGCONT` (POSIX) or `pssuspend.exe -r` (Windows). Returns `{pid, state: "running"}`.
- **`abort_pipeline(project, {grace_sec=10})`** — Graceful shutdown: `SIGINT` → wait `grace_sec` → `SIGTERM` (POSIX). Windows uses `taskkill /PID` → wait → `taskkill /F`. Returns `{pid, state: "aborted", duration_ms, escalated: bool}`.
- **`stop_pipeline(project, {force=false})`** — Hard kill via `SIGKILL` (POSIX) or `taskkill /F /T` (Windows). Returns `{pid, state: "killed"}`.
- **`list_running_pipelines()`** — List all running pipelines with state (`running|paused|aborting|killed|completed`), current stage, step number, and `awaiting_approval` status.
- **`get_pipeline_log(project, {run_id?, tail_lines=200})`** — Retrieve pipeline log with pagination support and cursor-based reading.
- **`approve_step(project, step_id, {decision, comment?})`** — Approve or reject a manual gate step. Decision must be `approve` or `reject`. Writes to `<project>/.workflow/approvals/{step_id}.json`.
- **`list_blocked_tickets({project?})`** — Aggregate blocked tickets from `<project>/.workflow/tickets/blocked/` across all projects or a specific project.
- **`list_ghost_executions({project?, since?})`** — Scan pipeline logs for `ghost_execution` markers indicating stuck or orphaned pipeline runs.
- **`list_reports({project?, since?, limit=50})`** — List all project reports sorted by creation date.
- **`get_report(project, report_id)`** — Retrieve a specific report's content.

#### Resources (3 new)
- **`workflow://pipeline-state`** (JSON, Subscribable) — Aggregated state of all running pipelines. Notifies via `resources/updated` on state changes. Includes fields: `project`, `pid`, `state`, `current_stage`, `step_number`, `awaiting_approval`, `run_id`, `started_at`, `last_log_at`.
- **`workflow://{project}/config/pipeline`** (YAML) — Pipeline configuration for a project.
- **`workflow://{project}/config/ticket-movement-rules`** (YAML) — Ticket movement rules configuration.

#### New Resource URIs (existing)
- **`workflow://{project}/logs/pipeline/latest`** (text/plain, Subscribable) — Live-tail of the latest pipeline log with cursor-based delta reading.

#### Cross-Platform Process Control
- **`src/process/control.mjs`** — New module providing `pause(pid)`, `resume(pid)`, `abort(pid, {grace_sec})`, `kill(pid)` functions. POSIX uses `process.kill()` with signals. Windows uses `pssuspend.exe`, `taskkill`, with graceful degradation when tools are unavailable.

#### Marker System
- **`src/process/marker.mjs`** — Functions `writeMarker()`, `readMarker()`, `validateMarker()`, `removeMarker()` for `.workflow/logs/.mcp-started-by` marker file. Protects against killing foreign pipelines.

#### Approval System
- **`src/approvals/model.mjs`** — Approval file read/write with atomic temp+rename operations and schema validation.
- **`src/tools/approvals.mjs`** — `approve_step` tool implementation.
- Manual gate stages in pipeline.yaml now create `.workflow/approvals/{step_id}.json` files for `runner@1.2.0+`.

#### Health Monitoring
- **`approval_pending`** alert type — Warns when approval files remain pending beyond `health.approval_pending_threshold_sec` (default 600s).
- Added to `src/health/detectors/approval-pending.mjs`.

#### Configuration
- **`.workflow-mcp.yaml`** — New `notifications.coalesce_window_ms` (default 200) for notification coalescing.
- **`.workflow-mcp.yaml`** — New `health.approval_pending_threshold_sec` (default 600) for approval timeout.

### Changed

- **`list_running_pipelines`** now includes `state` (running/paused/aborting/killed/completed), `current_stage`, `step_number`, `awaiting_approval`, `foreign` fields.
- **Pipeline notifications** via `resources/updated` on `workflow://pipeline-state` when any pipeline state changes.
- **Marker validation** prevents accidental killing of foreign pipelines. Override with `WORKFLOW_MCP_FORCE_FOREIGN=1`.
- **Coalescing** reduces notification bursts: multiple changes within 200ms trigger one `resources/updated`.

### Fixed

- Graceful abort now properly waits `grace_sec` before sending SIGTERM on POSIX.
- Parallel abort operations now detected via state-dir flag, returning `ALREADY_ABORTING`.
- Marker removal after successful abort/stop/kill is now atomic and idempotent.
- Resume on non-paused pipeline returns `NOT_PAUSED` instead of error.
- Approval file race conditions resolved via `O_EXCL` atomic writes.

### Security

- Foreign pipeline protection: `pause_pipeline`, `resume_pipeline`, `abort_pipeline`, `stop_pipeline` validate marker ownership before sending signals.
- Path traversal protection on all config and report resources.
- Override available via `WORKFLOW_MCP_FORCE_FOREIGN=1` for emergency scenarios.

### Documentation

- Added **Pipeline Controls** section to README.md with 12 tool descriptions and usage examples.
- Added migration guide for upgrading to `workflow-ai@1.2.0` (see MIGRATION.md).

### Notes

- **Dependency**: Requires `workflow-ai@^1.2.0` for full compatibility (manual gate support). Previous versions work but approval tools return `RUNNER_VERSION_TOO_OLD`.
- Windows pause/resume requires `pssuspend.exe` (Sysinternals PsTools) in PATH. Without it, pause/resume return `PAUSE_UNSUPPORTED`.
- Graceful abort `escalated` flag is `true` when SIGTERM is required (grace period elapsed or graceful exit failed).

---

## [1.2.0] - 2026-04-28

### Added

#### Git Tools (5 new tools) ([#3](https://github.com/beatlejute/workflow-mcp/pull/3))
- **`git_status(project)`** — Get structured Git repository status: branch, ahead/behind, modified/staged/untracked/conflicted files.
- **`git_create_branch(project, {name, from?, switch?})`** — Create a new git branch with optional checkout.
- **`git_diff(project, {staged?, path?, max_lines?})`** — Get a diff snapshot with configurable limits and path filter.
- **`git_commit(project, {message, paths?, co_authors?})`** — Commit staged changes or explicit paths; supports `Co-Authored-By` trailers.
- **`git_open_pr(project, {title, body?, base?, head?, draft?})`** — Open a GitHub pull request via `gh` CLI.

#### Coach Tools (4 new tools) ([#4](https://github.com/beatlejute/workflow-mcp/pull/4))
- **`run_skill(project, {skill_name, args?, context?, timeout_sec?})`** — Run a skill via the project's skill runner.
- **`list_skill_tests(project, {skill_name?})`** — List skill test cases from `index.yaml` files.
- **`run_skill_tests(project, {skill_name, test_ids?, parallel?, timeout_sec?})`** — Run skill tests and parse structured results.
- **`create_coach_ticket(project, {target_skill, gap_description, evidence_path?, priority?})`** — Create a coach-gap ticket in the backlog.

#### Analytics Tools (4 new tools) ([#5](https://github.com/beatlejute/workflow-mcp/pull/5))
- **`get_velocity(project, {window_days?, group_by?})`** — Velocity metrics grouped by day or week.
- **`get_cycle_time(project, {window_days?, percentiles?})`** — Cycle time statistics (p50, p90, mean).
- **`get_ticket_stats(project, {window_days?})`** — Ticket distribution by status, type, and top blocked tickets.
- **`aggregate_metrics({projects?, window_days?})`** — Aggregate analytics across multiple projects.

#### Search Tool ([#5](https://github.com/beatlejute/workflow-mcp/pull/5))
- **`cross_project_search({query, projects?, type?, max_results?})`** — Fast code search across projects using ripgrep.

#### Health Monitoring
- **`branch_diverged`** detector — Warns when local branch diverges from remote tracking branch beyond configured thresholds.

#### Human Ticket Validation
- **`isValidHumanTicket`** validator with configurable rules via `human_ticket` configuration and optional `human-task-rules.md`.

#### Configuration
- **`.workflow-mcp.yaml`** — New `health.branch_diverged_max_behind` (default 10), `health.branch_diverged_max_ahead` (default 30), `health.branch_diverged_auto_fetch` (default false) for branch divergence detection.
- **`.workflow-mcp.yaml`** — New `human_ticket` section with keys: `strict_validation` (default false), `min_result_length` (default 50), `evidence_required` (default true).

### Changed
- **`resolve_human_ticket`** accepts optional `strict` parameter to enable strict validation (overrides config).

### Documentation
- Added **Git Tools**, **Coach Tools**, **Analytics**, and **Search** sections to README with usage examples.
- Updated **Configuration** section with new health and human_ticket keys.
- Added migration guide for `human_ticket.strict_validation` in MIGRATION.md.

### Migration Guide

#### Enabling `human_ticket.strict_validation`

By default, strict validation is **disabled**. To enable it, add to your `.workflow-mcp.yaml`:

```yaml
human_ticket:
  strict_validation: true
  min_result_length: 50    # optional, default: 50
  evidence_required: true  # optional, default: true
```

When `strict_validation: true`:
- Ticket result must be at least `min_result_length` characters
- Evidence field is required when `evidence_required: true`
- Calls to `resolve_human_ticket` with invalid tickets return `VALIDATION_FAILED`

You can also enable strict validation per-call without changing the config:
```javascript
await client.callTool('resolve_human_ticket', {
  project: 'my-project',
  ticket_id: 'HT-001',
  strict: true
});
```

### Notes
- **Runtime dependencies**: `git` required for all git tools; `gh` CLI optional (for `git_open_pr`); `ripgrep` required for search.
- **Backward compatibility**: All existing tools remain unchanged; new tools are opt-in via configuration.

## [1.0.0] - 2026-04-20

### Added
- Initial release of workflow-mcp MCP server
- Multi-project discovery and management
- Ticket management (list, get, create, move)
- Plan management (list, get)
- Human ticket queue aggregation
- Health monitoring with 6 alert types: `crashed`, `stuck`, `stage_error`, `retry_loop`, `blocked_accumulation`, `ghost_execution`
- Basic resources: projects, board, tickets, human-queue, alerts
- Skills framework and execution engine