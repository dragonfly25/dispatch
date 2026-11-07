# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-07

First public version. Implements the functional spec (`docs/spec.md`) with the deviations recorded in
`STATUS.md` and `docs/PLAN.md`.

### Added
- `dispatch` CLI: `setup` (wizard, user-scope host integration), `install` / `uninstall [--global]`,
  `trust`, `run` (sync, `--detach`, `--dry-run`, `--json`, `--provider`), `wait`, `cancel`, `explain`
  (`--replay`), `status` (`--set`, `--compare`), `use`, `profiles`, `providers`, `validate`, `logs`
  (`--follow`), `gc`, `doctor` (`--live`, `--from-host`).
- Adapters for Claude Code (`claude -p --safe-mode`, native sandbox, credential read-deny), Codex
  (`codex exec --json`, isolation flags, project-trust side-effect guard) and Antigravity (`agy`,
  experimental, read-only, opt-in with ToS acknowledgement).
- Pure, deterministic router: pins → direct mappings → profile rules → tier preset → default; tier ×
  effort abstraction with per-adapter model tables; soft/hard quota thresholds; fallback and fanout
  (second opinion); `explain` with the full rule chain; shadow mode and `status --compare`.
- Quota module: official/passive readers (Codex app-server `account/rateLimits/read`, Claude
  `rate_limit_event`, `agy /usage`), estimator, reliability (`real`/`estimated`/`stale`/`unknown`),
  manual overrides, `quota_exhausted` signals.
- Execution sandbox: git worktree per task (dirty-tree snapshot base), process-group supervision with
  monotonic timeouts, env allow-list, recursion guard, patch collection with path/symlink/secret
  filtering and apply-check against the current tree. Dispatch never applies patches.
- Host integrations: Claude Code (soft: user-scope plugin with `dispatch` sub-agent and SessionStart
  policy context) and Codex (hard: PreToolUse `deny_redirect` on sub-agent spawns, skill, rules file).
- Config: global + per-repo YAML, tighten-only security keys, hash-bound repo trust, presets
  (`mirror`, `economy`, `custom`), profiles (`balance`, `preserve`, `specialize`, `off`).
- State in SQLite with redaction before every write; leases; idempotent detach.
- Docs: README (five-minute setup, billing/ToS disclosure), configuration reference (generated),
  adapter and host-integration guides, threat model, manual test scripts.
- Tests: ~1,400 tests (unit, contract on recorded CLI output, e2e with fake CLIs, security suite,
  UC1–UC14 acceptance suite); CI on macOS and Linux, Node 22 and 24.
