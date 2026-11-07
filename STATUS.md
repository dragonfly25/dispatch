# Dispatch — Project status

Maintained by the lead engineer after every merge. Plan: [docs/PLAN.md](docs/PLAN.md) (including the
"Amendments after WP1 spike" section).

_Last update: 2026-11-07 — release v0.1.0_

## Work packages

All work packages are merged. Model · effort is the development sub-agent profile used.

| WP | Title | Model · effort | PR |
|---|---|---|---|
| WP0 | Bootstrap, CI, core contracts | Opus · medium | #1 |
| WP0b | Shared RoutingConfig contract (lead) | Opus (lead) | #3 |
| WP1 | Live spike + contract freeze | Opus · medium | #2, #4 |
| WP2 | Fake CLI harness | Sonnet · high | #9, #22 |
| WP3 | Launcher, binary resolution, host detection | Sonnet · high | #5 |
| WP4 | Config, layering, trust | Opus · medium | #10 |
| WP5 | Router + explain | Opus · medium | #8 |
| WP6 | State store | Sonnet · high | #7 |
| WP7 | Worktree sandbox | Sonnet · high | #6 |
| WP8 | Host prototype (real CLIs) | Sonnet · high | #11 |
| WP9 | Validate, presets, model tables | Sonnet · high | #18 |
| WP10 | Shadow decisions + compare | Sonnet · high | #14 |
| WP11 | Quota core | Sonnet · high | #13 |
| WP12 | Patch pipeline | Opus · medium | #12 |
| WP13 | Process supervisor | Sonnet · high | #19 |
| WP14 | Claude adapter | Opus · medium | #17 |
| WP15 | Codex adapter | Opus · medium | #15 |
| WP16 | Antigravity adapter (read-only) | Sonnet · high | #16 |
| WP17 | Setup framework + hook entry | Opus · medium | #21 |
| WP17b | Setup wizard (global config) — added during execution | Sonnet · high | #34 |
| WP18 | Quota readers | Sonnet · high | #20 |
| WP19 | Runner core | Opus · medium | #26 |
| WP20 | Composition root + CLI read commands | Sonnet · high | #24 |
| WP21 | Repo install/uninstall | Sonnet · high | #23 |
| WP22 | Claude Code host (soft) | Sonnet · high | #25 |
| WP23 | Runner multi: fanout, detach/wait/cancel | Opus · medium | #33 |
| WP24 | CLI run + hook-cache writer | Sonnet · high | #29 |
| WP25 | CLI status/logs/gc | Sonnet · high | #28 |
| WP26 | doctor + --live | Sonnet · high | #30 |
| WP27 | Codex host (hard, deny_redirect) | Opus · medium | #35 |
| WP28 | Security suite + threat model | Opus · medium | #31 |
| WP29 | Acceptance suite + manual tests | Sonnet · high | #37 |
| WP30 | Docs (configuration, guides, README) | Sonnet · high | #27, #32 |
| — | Fixes from live verification | Sonnet · high | #36 |
| WP31 | Release v0.1.0 (lead) | Opus (lead) | #38 |

Escalations Sonnet → Opus: none were needed. Lead-side CI hygiene fixes: biome excludes raw fixtures and
Markdown; macOS signal race in the fake CLI (#22); merge-train rebases of parallel PRs.

## Acceptance checklist (spec §12) — `pnpm acceptance` on main

| Item | Result |
|---|---|
| UC1 first setup | PASS (88/88 tagged tests) |
| UC2 soft delegation from Claude Code | PASS (67/67) + **live** (real Claude host → real Codex) |
| UC3 hard interception from Codex | PASS (58/58) + **live** (real Codex host → real Claude; see notes) |
| UC4 quota fallback | PASS (66/66) |
| UC5 pinned task | PASS (19/19) |
| UC6 unspecified model | PASS (14/14) |
| UC7 second opinion | PASS (8/8) |
| UC8 profile experimentation | PASS (18/18) |
| UC9 collaborator without Dispatch | PASS (84/84) |
| UC10 no host | PASS (19/19) |
| UC11 broken quota channel | PASS (48/48) |
| UC12 second account / API pool | PASS (16/16); live part documented in docs/manual-tests/UC12.md |
| UC13 timeout and non-applicable patch | PASS (72/72) |
| UC14 uninstall | PASS (35/35) |
| AC1 UC1–UC14 automated + manual documented | PASS |
| AC2 install + uninstall leave the repo identical | PASS |
| AC3 every decision reproducible and logged | PASS |
| AC4 works with every quota reader disabled | PASS |
| AC5 collaborator notices nothing | PASS |
| AC6 English docs (README, config reference, two guides) | PASS |
| AC7 no credential copied, logged or transmitted | PASS |

Security tags: all 15 `[SEC-*]` groups PASS. Total: 1,398 tests passed, 1 skipped (opt-in perf).

### Live verification on this machine (real CLIs: claude 2.1.301, codex 0.167.0, agy 1.5.2)
- `dispatch doctor`: 0 failures; Codex quota read live via app-server; agy not started (disabled).
- `dispatch doctor --live --provider claude,codex`: both produced the expected one-file patch (5 s / 6.5 s).
- UC3 live: Codex host with Dispatch's hooks and rules → `run --detach` executed outside the Codex
  sandbox via the rules file, router chose Claude, `wait` returned the result, the model applied the patch.
  In these runs the model followed the skill/SessionStart policy and called Dispatch directly, so the
  PreToolUse deny itself was exercised synthetically (and live in the WP1/WP8 spikes).
- UC2 live: Claude host with the plugin loaded via `--plugin-dir` → `dispatch` sub-agent → Codex chosen,
  patch returned, no recursive Claude child.
- `~/.codex/config.toml`, `~/.claude/settings.json` and other host files verified byte-identical after
  every live experiment; `~/.dispatch` is never created by read-only commands.
- Not exercised live: Antigravity as a delegation target (ToS caution — quota-free probes only), quota
  exhaustion on a real account, Codex hook trust via the `/hooks` TUI (user step).

## Open risks (spec §12 table + new)

| Risk | State at v0.1.0 | Notes |
|---|---|---|
| Quota channels change/disappear | Mitigated | Codex app-server is official; Claude passive `rate_limit_event` + `claude -p /usage` (after v0.1.0); agy `/usage`; estimator + `stale`; UC11/AC4 tested. |
| No hard interception in Claude Code | Resolved (after v0.1.0) | PreToolUse on `Agent` rewrites `general-purpose` sub-agents to `dispatch:dispatch` (`updatedInput`), verified live; see "After v0.1.0". |
| Codex `SubagentStart` can't redirect | Resolved | UC3 via PreToolUse `deny_redirect` (multi-agent V2 encrypts spawn messages; proxy rewrite impossible). |
| Antigravity streaming/hooks | Resolved technically; **ToS-restricted** | Experimental, off by default, read-only, explicit ToS acknowledgement; child user hooks cannot be disabled (disclosed by doctor). |
| Billing/OAuth rule changes | Active | Claude automated use of subscriptions is a grey area; Google forbids wrapping on consumer plans; README discloses; `pool` shown in `status`. |
| Prompt injection | Open (inherent) | Native sandboxes, credential read-deny, patch filter, untrusted-output marker, no auto-apply; docs/security.md. |
| Codex rules file = sandbox-escape surface | Accepted trust grant | Absolute launcher, subcommand allow-list, compound commands never match, flags tighten-only. |
| Codex hooks need TUI `/hooks` trust | Open (user step) | Setup preview + doctor heartbeat check. |
| `codex exec` writes project trust into `~/.codex/config.toml` | Mitigated | Side-effect guard, verified live. |
| CLI churn (agy auto-update, Codex flags) | Open | `cliRange`, probe gating, fail closed, fixtures per CLI version; doctor warns outside range. |
| node:sqlite experimental | Low | DbPort abstraction; warning filtered in the CLI. |

## Deviations from the spec

Decided in planning (details in docs/PLAN.md §7):
1. Undocumented Claude OAuth quota endpoint not used (violates §2.2); official/passive channels instead.
2. No edits to AGENTS.md, CLAUDE.md or `.claude/settings.json`; host integration is user-scope only.
3. UC1/UC14: the repo diff contains only `.dispatch/`; host changes are user-scope.
4. `setup` (per user) / `install` (per repo) / `uninstall [--global]` instead of a single install.
5. Antigravity as target: experimental, off by default, read-only, ToS opt-in; no agy host integration.
6. UC3: the native spawn is denied and redirected to `dispatch run --detach` + `wait` (deny_redirect).
7. New Codex host file `~/.codex/rules/dispatch.rules` (trust grant).
8. Security keys are global-only and tighten-only (including flags); repo policy requires `dispatch trust`.
9. No `.dispatch/hooks/` scripts; hooks are inline guards with absolute paths.
10. Worktrees in `~/.dispatch/worktrees`; the patch is checked against the current tree.
11. Isolation boundary = each CLI's native sandbox; fail closed without it.
12. `reserve_for_host` dropped; `unspecified_model` default `balanced` (session model often unobservable).
13. Commands added: setup, trust, wait, cancel, gc; `watch` → `logs --follow`; `status --history` dropped.
14. UC8 shadow results are decisions recomputed on recorded snapshots; consumption labelled estimated.
15. State in SQLite. 16. Windows unsupported. 17. `doctor` spends no quota unless `--live`.

Taken during execution:
18. agy read-only is enforced by headless auto-deny (`--mode plan` is ineffective); read-only runs with a
    text answer are reported as success with the denied actions logged.
19. Run artifacts (patch, events) live in `<repo>/.dispatch/state/runs/<id>/` (gitignored) so host
    sessions can read the patch; `~/.dispatch/runs/<id>/` outside an installed repo.
20. Claude plugin uninstall leaves empty settings keys; `uninstall --global` removes exactly what install
    added (pre-install snapshot), restoring `~/.claude/settings.json` byte-for-byte.
21. `direct` autonomy is not implemented in v0.1 (adapters refuse it; the runner uses a worktree).
22. `returned_to_host` exits 0 (the host proceeds natively); exit 5 only when a completed run ended
    quota-exhausted.
23. Codex hard mode switch `hosts.codex.hard` (default true); Claude stays soft.
24. Package `@dragonfly25/dispatch`, MIT — placeholders for the owner; npm publishing is a manual
    workflow (publish.yml), never triggered by tags.

## After v0.1.0

- **Claude quota reader `claude-usage`** (`claude -p /usage --safe-mode`, quota-free): real Claude
  windows (`5h`, `7d`, per-model `7d:<model>`), including the user's interactive usage. Only the
  official CLI command is used (spec §2.2 compliant; no OAuth endpoint, no credential access). The
  local-usage breakdown in the output is discarded immediately.
- **Deviation:** an optional Haiku fallback (default on, `quota.readers.claude-usage.llm_fallback`)
  parses the trimmed header when the deterministic parser fails; it runs only with a reader budget
  of at least 20 s (`status`, `doctor`), never on the routing path, spends a small amount of quota,
  and its readings (`source: claude-usage+llm`) are kept only when grounded in the header text.
- **Risk:** `/usage` is human-oriented text, not a stable format. Mitigation: tolerant parser,
  fallback, UC11 behaviour (stale/estimate) when both fail; `doctor` reports the channel.
- Per-model windows have no plan-table capacity (no published allowance): they are shown and count
  in routing as real readings only, never estimated.
- **Claude Code hard mode** (UC2): the plugin gains a `PreToolUse` hook (matcher `Agent|Task`). In a
  trusted repo whose policy delegates, with `hosts.claude-code.hard` on (default), it rewrites
  intercepted sub-agent calls (`hosts.claude-code.intercept`, default `general-purpose`; `"*"` = all)
  to `dispatch:dispatch` through `permissionDecision: "allow"` + `updatedInput`. Verified once on
  Claude Code 2.1.301 (`claude -p --plugin-dir`, haiku): the parent's `Agent{general-purpose}` call
  ran as the Dispatch relay. The SessionStart text now says delegable task types go through Dispatch
  unless the user says otherwise (Codex wording aligned). Claude reads a directory-marketplace plugin
  from its folder (verified), so `setup --refresh` reaches new sessions without a reinstall or a
  version bump; running sessions need a restart. Doctor: `claude-code.hard-mode`.
- **Deviation:** spec §5 ("Claude Code: Soft" at launch) is superseded for `general-purpose`
  sub-agents, as approved by the owner. The frozen `SubagentStrategy` enum has no "rewrite" value, so
  the Claude integration still reports `subagentStrategy: "none"`; an ADR could add one.
- **Claude Code custom agents** (UC2): `hosts.claude-code.intercept` now defaults to `auto`:
  `general-purpose` plus every eligible agent of `<repo>/.claude/agents/` and `~/.claude/agents/`
  (`CLAUDE_CONFIG_DIR` respected; matched by file name, then frontmatter `name:`). Eligible: only
  file tools (read tools → read-only, edit tools or Bash or no `tools:` → worktree), MCP tools only
  for servers `forwardableMcpFor(cache, root)` returns (empty without the MCP forwarding
  consent), never `Claude_Browser`, instructions ≤ 32 KB. The hook writes a 0600 handoff
  (`~/.dispatch/handoffs/<id>.json`) and points the relay at `run --handoff <id>`; the agent's
  `model:` goes through the claude reverse table (`*fable*` → max added), `effort:` xhigh/max → high.
  New `hosts.claude-code.exclude`, `auto_apply`; doctor `claude-code.hard-mode` lists every agent of
  the current repo and why it stays on Claude. Handed-back runs write a one-shot passthrough so the
  caller's identical retry runs natively. Verified live once on Claude Code 2.1.301 (haiku,
  `--plugin-dir`): the parent's `Agent{subagent_type: "reader"}` ran as the Dispatch relay with a
  handoff id, the relay ran `run --detach --json --handoff <id>`, and the 0600 handoff existed with
  the agent's instructions, model and read-only autonomy.
- **Deviation (auto-apply):** "Dispatch never applies patches" no longer holds for runs started from
  a handoff: the relay runs `dispatch apply <runId>`, which applies a successful, clean, unreviewed-
  flag-free patch to the working tree (no index, no commit), as approved by the owner
  (`hosts.claude-code.auto_apply`, default true, global only). The Codex host does not auto-apply.
- **Web access for delegated custom agents** (owner-approved, zero-touch): agents whose `tools:`
  list `WebSearch`/`WebFetch` are now delegated (agents that also use `Claude_Browser` still stay).
  The handoff carries `web` and `webFetch`; `executeTask` takes `web: "search" | "fetch"` and, like
  MCP forwarding, restricts routing before `decide` to instances that can give it (codex, claude;
  never antigravity), returning to the host when none can or when `hosts.claude-code.forward_web`
  (default true, global, tighten-only) is off. The frozen contracts are untouched:
  `BuildInvocationWithWeb` is a structural superset of the invocation args. Codex gets
  `-c web_search="cached"` (WebSearch) or `"live"` (WebFetch); claude gets the tools in `--tools`
  and `--allowedTools`. Verified live once each (codex 0.167 `open_page` on a given URL while shell
  `curl` stayed offline; claude 2.1.301 `--safe-mode` used both tools): `docs/spikes/web-access.md`.
  The `network` key still does not govern this (the shell sandbox network is unchanged); runs
  without a web request keep codex's default argv. Threat model: docs/security.md T14.
- **Opt-in sandbox network for delegated agents** (owner-approved, off by default): the dormant
  `network` security key now has an effect, with values `off | delegated-agents | all` (`on` kept
  as a deprecated alias of `all`, with a warning) and a global-only `network_agents` list. The
  brief suggested a new `sandbox.network` key; the existing tighten-only `network` key was reused
  instead, to avoid two keys for one switch. A run's agent is the handoff's custom agent, else
  `general-purpose` when a host session started it (host detected from env), else none (by hand):
  Dispatch cannot tell a hard-mode `general-purpose` relay run from any other run a host session
  starts, so `delegated-agents` covers both. Worktree attempts get codex
  `-c sandbox_workspace_write.network_access=true` or claude `sandbox.network` in `--settings`, and
  `npm_config_cache` / `npm_config_store_dir` in a per-attempt TMPDIR directory (allowWrite for
  claude). Read-only runs never get it (codex has no read-only network setting). Both adapters are
  capable, so no routing hint is needed. `BuildInvocationWithNetwork` and `RunResultWithNetwork`
  (field `sandboxNetwork`, present only when the scope is not `off`) are structural supersets; the
  frozen contracts are untouched (`run --json` re-adds the field after the schema check). Doctor
  `sandbox.network` warns while it is on; setup never asks. Verified live: one codex run and three
  claude runs, `docs/spikes/sandbox-network.md`. Threat model: docs/security.md T15.
- **Per-agent MCP forwarding** (owner-approved, one-time consent): `src/mcp/` reads the user's
  Claude MCP config read-only (local > `.mcp.json` (approved only) > user scope) and decides which
  servers are forwardable (pure `${VAR}` env/header references only; values never copied).
  `dispatch setup` asks the trust grant `hosts.claude-code.forward_mcp` (wizard default yes;
  absent = false; repo/flag `forward_mcp: false` only tightens). The hook cache carries
  `policy.forwardMcp`, `policy.forwardableMcp` (user scope) and `trustedRepos[].forwardableMcp`
  (per repo); `forwardableMcpFor(cache, cwd)` reads them. `executeTask` takes `mcpServers` (names),
  re-resolves them at run time, restricts routing to instances that can host them and passes them to
  `buildInvocation`. Doctor: `claude-code.mcp-forwarding`; `*.isolation` wording updated.
  Wired to custom agents: the hook checks eligibility with `forwardableMcpFor` (consent honoured),
  and `run --handoff` passes the handoff's `mcpServers` to `executeTask` (sync and detached).
- **Deviation:** children no longer always run with MCP disabled: a codex child may start exactly
  the servers the delegated agent needs (`-c mcp_servers.<name>.*`, variables by name, tools
  pre-approved). Claude targets cannot receive MCP: `--safe-mode` drops `--mcp-config` (verified
  live, `docs/spikes/mcp-forwarding.md`). The frozen `BuildInvocationArgs` is extended structurally
  (`BuildInvocationWithMcp` in `src/mcp/forward.ts`), and the router's capability hint is applied by
  disabling incapable instances in the effective routing config before `decide` (the routing
  contract stays frozen); an ADR could make both first-class.
- **Isolated browser for delegated agents** (owner-approved): agents that list
  `mcp__Claude_Browser__*` are now eligible when `hosts.claude-code.browser` (setup trust grant,
  global, tighten-only) is on, the pinned `@playwright/mcp@0.0.84` is installed with verified
  integrities, Google Chrome is found, the agent lists Bash and the run gets the sandbox network.
  Codex only (`planBrowser` restricts routing like the MCP hint; claude/agy adapters refuse). The
  codex child gets `-c mcp_servers.dispatch_browser.*` (node + pinned `cli.js`, `--isolated
  --headless --browser chrome`, `--allowed-origins` from `.claude/launch.json` ports,
  `--output-dir`, `HOME` and `cwd` in the attempt dir, an `enabled_tools` allowlist of 22 tools).
  The task gets a translation note (Claude_Browser to Playwright tools; dev servers started as
  long-running commands and stopped with Ctrl-C). Setup provisions it as a manifest-tracked
  `cli-command` (new `env` and `ensure` spec fields; `CommandRunner.run` takes an optional env).
  Verified live: 3 codex runs, `docs/spikes/browser.md` (a job backgrounded with `&` dies with its
  command; `kill` across commands is denied by the sandbox). Threat model: docs/security.md T16.
- **Risk:** a forwarded server runs as the user outside the child's sandbox, driven by an
  unsupervised agent (docs/security.md T13). Not live-verified: `env_http_headers` and
  `shell_environment_policy.exclude` (keys taken from the codex 0.167 config schema).

## Process notes

- Repo-local git `user.email` set to the GitHub noreply address (GitHub rejects the private email).
- 38 PRs, each with tests and green CI (macOS + Linux × Node 22/24) before merge.
