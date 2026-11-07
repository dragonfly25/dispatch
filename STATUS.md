# Dispatch — Project status

Maintained by the lead engineer after every merge. Plan: [docs/PLAN.md](docs/PLAN.md) (incl. "Amendments after WP1 spike").

_Last update: 2026-11-07_

## Work packages

| WP | Title | Model · effort | State | PR |
|---|---|---|---|---|
| WP0 | Bootstrap, CI, core contracts | Opus · medium | ✅ merged | #1 |
| WP0b | Shared RoutingConfig contract (lead) | Opus (lead) | ✅ merged | #3 |
| WP1 | Live spike + contract freeze | Opus · medium | ✅ merged | #2, #4 |
| WP2 | Fake CLI harness | Sonnet · high | 🔨 in progress | |
| WP3 | Launcher, binary resolution, host detection | Sonnet · high | 🔎 in review | #5 |
| WP4 | Config, layering, trust | Opus · medium | 🔨 in progress | |
| WP5 | Router + explain | Opus · medium | 🔨 in progress | |
| WP6 | State store | Sonnet · high | 🔨 in progress | |
| WP7 | Worktree sandbox | Sonnet · high | 🔨 in progress | |
| WP8 | Host prototype (real CLIs) | Sonnet · high | 🔨 in progress | |
| WP9–WP31 | — | see plan §4 | ⏳ pending | |

Escalations Sonnet → Opus: none so far.

## Acceptance checklist (spec §12)

| Item | State |
|---|---|
| UC1–UC14 | ⏳ not yet testable (core packages in progress) |
| AC1 automated UC tests | ⏳ |
| AC2 install+uninstall empty diff | ⏳ |
| AC3 every decision reproducible + logged | ⏳ |
| AC4 works with all quota readers disabled | ⏳ |
| AC5 invisible to collaborators | ⏳ (hook guard tested in WP3) |
| AC6 English docs | ⏳ |
| AC7 no credentials copied/logged/sent | ⏳ |

## Open risks (spec §12 table + new)

| Risk | Current state | Notes |
|---|---|---|
| Quota channels change/disappear | Lower | Codex app-server is official; Claude passive `rate_limit_event`; agy `/usage` CLI command. |
| No hard interception in Claude Code | Accepted for v0.1 | PreToolUse on `Agent` exists now; Claude stays soft per spec. |
| Codex `SubagentStart` can't redirect | Resolved | UC3 = `deny_redirect` via PreToolUse (verified live, WP1). |
| Antigravity streaming/hooks | Resolved technically; ToS-restricted | Experimental, opt-in, read-only; user hooks in child not disableable (disclosed). |
| Billing/OAuth changes | Active | Claude fan-out grey area; Google forbids wrapping on consumer plans. README disclosure (WP30). |
| Prompt injection | Open (inherent) | Native sandboxes, credential read-deny verified live (WP1), patch filter, untrusted-output marker. |
| **New** Codex rules file = sandbox-escape surface | Accepted trust grant | Rule semantics verified from source (compound commands split; `$`/backticks/redirects never match). |
| **New** `codex exec` writes trust into `~/.codex/config.toml` | Mitigated | Side-effect guard `-c projects=…untrusted` (WP1); golden-argv test in WP15. |
| **New** Codex hooks need TUI `/hooks` trust | Open | Setup instructions + doctor heartbeat. |
| **New** CLI churn (agy auto-update, codex flags) | Open | cliRange + probe gating + fixtures per version. |
| **New** node:sqlite experimental | Low | DbPort abstraction (WP6). |

## Deviations from the spec

The 17 deviations in plan §7 apply. Additional ones taken during execution:

1. UC3 mechanism is `deny_redirect` only; `proxy_subagent` dropped (multi-agent V2 encrypts the spawn message). UC3 wording: the native spawn is denied and the result arrives via `dispatch wait`.
2. Codex child gets an extra side-effect guard so `codex exec` cannot persist project trust into the user's `~/.codex/config.toml` (spec §2.3).
3. agy read-only is enforced by headless auto-deny (not `--mode plan`, which is ineffective); runs with denied actions are reported as `failed`.
4. Package name `@dragonfly25/dispatch` (bin `dispatch`), MIT license — placeholders until the owner decides; publishing to npm only with explicit go-ahead.
5. Exit code when `CODEX_SANDBOX` is set: WP3 uses 6, the amendment says 3 — to be unified to 3 (`REJECTED`) in WP24.

## Process notes

- Repo-local git `user.email` set to the GitHub noreply address (pushes with the private email are rejected by GitHub).
