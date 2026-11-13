# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-11-13

### Added
- Native Windows support (win32; WSL keeps the Linux path). Binaries resolve through `PATHEXT` and
  npm cmd-shims start as `node <script>` (never through `cmd.exe`); process trees stop with
  `taskkill /T`; detached runs cancel through a `cancel.request` file; the child env allow-list
  adds the Windows system variables; home falls back to `USERPROFILE`; worktree bootstrap uses
  junctions. Launcher `~/.dispatch/bin/dispatch.cmd`, Claude Code hooks in exec form (needs
  Claude Code 2.1.139+ and Git for Windows), Codex hooks as a PowerShell script, no Codex rules
  file on Windows. Delegated codex runs use `windows.sandbox="elevated"`; delegated claude and agy
  are refused on Windows (no OS sandbox / unverified) and routed around. `cancel` now finds the run
  directory from the run record (state migration v2), not from the cwd. CI adds `windows-latest` test and
  pack-smoke jobs. Threat model T17; facts in `docs/spikes/windows.md`.
- Isolated browser for delegated agents: custom agents that list the Claude desktop browser tools
  (`mcp__Claude_Browser__*`) are delegated to codex with a Dispatch-owned Playwright MCP server
  (`dispatch_browser`): the installed Google Chrome, `--isolated --headless`, a temporary empty
  profile, origins limited to the dev-server ports of `.claude/launch.json`, output in the run dir,
  and a codex `enabled_tools` allowlist without `browser_run_code_unsafe`. Trust grant
  `hosts.claude-code.browser` asked by `dispatch setup` (wizard default yes; `--browser`,
  `--no-browser`, answers key `browser`); setup installs the pinned `@playwright/mcp@0.0.84` into
  `~/.dispatch/tools/playwright-mcp` with npm `--ignore-scripts` (refresh reinstalls, uninstall
  removes it). Such agents also need the sandbox network (`network: delegated-agents`) and Bash;
  otherwise they stay on Claude. The task gets a "Browser tools in this run" section mapping the
  desktop tools to Playwright's and saying how to start, read and stop the dev servers. Doctor
  check `claude-code.browser`; handoff field `browser`; `executeTask` option `browser`. Live
  spikes: `docs/spikes/browser.md`; threat model T16.
- Opt-in shell sandbox network for delegated agents (off by default): `network: off |
  delegated-agents | all` in the global config (the old `on` is a deprecated alias of `all`), plus
  global-only `network_agents: [names]` to narrow `delegated-agents` (`general-purpose` = runs a host
  session starts without a handoff). Worktree runs get codex
  `-c sandbox_workspace_write.network_access=true` or claude `sandbox.network` (localhost binding,
  Unix sockets, all domains; credential `denyRead` kept), plus per-attempt npm/pnpm caches under
  TMPDIR. Read-only runs never get it. Tighten-only: a repo or flag can only lower it. The decision
  is recorded as `sandboxNetwork` in the run result and shown by `run`, `run --json` and `logs`;
  `doctor` warns (`sandbox.network`) while it is on. Live spikes: `docs/spikes/sandbox-network.md`;
  threat model T15.
- Web access for delegated custom agents: an intercepted agent whose `tools:` list `WebSearch` or
  `WebFetch` is now delegated (it used to stay on Claude). Codex gets `-c web_search="cached"`
  (WebSearch) or `"live"` (WebFetch), claude instances get the web tools pre-approved; the shell
  sandbox network is unchanged and antigravity is never picked. Global switch
  `hosts.claude-code.forward_web` (default true); repo/flag `forward_web: false` turns it off.
  Handoff field `webFetch`, `executeTask` option `web`, hook cache field `forwardWeb`; doctor lists
  such agents as "delegated (…, web)". Live spikes: `docs/spikes/web-access.md`.
- Claude Code hard mode: the plugin's new `PreToolUse` hook on the `Agent` tool rewrites
  `general-purpose` sub-agent calls to the `dispatch:dispatch` sub-agent in trusted repos whose policy
  delegates. Config `hosts.claude-code.hard` (default true) and `hosts.claude-code.intercept`
  (default `["general-purpose"]`, `"*"` for every type). Doctor check `claude-code.hard-mode`.
  Existing installs: `dispatch setup --refresh`, then restart Claude Code sessions.
- MCP forwarding: an intercepted agent that uses MCP tools can have exactly those servers forwarded
  to the codex child that runs it, after a one-time trust grant in `dispatch setup`
  (`hosts.claude-code.forward_mcp`, flags `--forward-mcp` / `--no-forward-mcp`). Only servers whose
  env and header values are `${VAR}` references qualify; secrets pass by variable name, never by
  value. Repo/flag key `forward_mcp: false` turns it off. `executeTask` option `mcpServers`, hook
  cache fields `forwardMcp` / `forwardableMcp`, doctor check `claude-code.mcp-forwarding`.
- Claude Code hard mode for your own sub-agents (`.claude/agents/*.md`, project and user): eligible
  agents are redirected through a one-time handoff file (`dispatch run --handoff <id>`), with the
  agent's instructions, model (tier), effort and autonomy. Agents using the desktop browser, web
  tools, non-forwardable MCP servers or other tools stay on Claude. Doctor `claude-code.hard-mode`
  lists the agents of the current repo and why each stays or goes.
- `dispatch apply <runId>`: applies the clean patch of a successful handoff run to the working tree
  (auto-apply, `hosts.claude-code.auto_apply`, default true). The relay calls it; doctor prints the
  new `Bash(... apply:*)` permission rule.
- Config `hosts.claude-code.exclude` and `hosts.claude-code.auto_apply`; `dispatch gc` removes
  stale handoffs, expired passthrough entries and old handoff-run records.

### Changed
- README reworked: a step-by-step sequence diagram of a delegated task, the three ways a task
  reaches Dispatch with examples, knobs moved to a collapsed table, a routing flowchart, command,
  Windows and troubleshooting tables.
- `hosts.claude-code.intercept` defaults to `auto` (general-purpose plus eligible custom agents);
  `"*"` now means every eligible type (built-ins without an agent file are no longer redirected).
- The claude reverse model table classifies `*fable*` as `max`.
- Children may now start the MCP servers the delegated agent needs (codex only, with consent);
  every other MCP server stays disabled. Claude targets never receive MCP servers (`--safe-mode`
  ignores `--mcp-config`).
- The SessionStart policy text (Claude Code and Codex) now says that task types the policy routes to a
  provider are delegated through Dispatch unless the user says otherwise.

### Fixed
- The `run` progress spinner draws a new phase at once instead of on the next tick, so a short
  run still shows which provider took it.
- Codex `SKILL.md` named a nonexistent `--prompt-file` flag; it now uses `--task-file`.
- Antigravity probe: `agy --help` flags are read from stderr as well as stdout. agy 1.5.3 prints its
  whole help on stderr, so `dispatch doctor` warned "`--help` listed no flags" and the required
  isolation flags were never verified.

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
