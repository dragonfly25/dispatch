# Dispatch — Project status

Maintained by the lead engineer after every merge. Plan: [docs/PLAN.md](docs/PLAN.md) (incl. "Amendments after WP1 spike").

_Last update: 2026-11-07 (after PR #21)_

## Work packages

| WP | Title | Model · effort | State | PR |
|---|---|---|---|---|
| WP0 | Bootstrap, CI, core contracts | Opus · medium | ✅ merged | #1 |
| WP0b | Shared RoutingConfig contract (lead) | Opus (lead) | ✅ merged | #3 |
| WP1 | Live spike + contract freeze | Opus · medium | ✅ merged | #2, #4 |
| WP2 | Fake CLI harness | Sonnet · high | ✅ merged | #9, #22 |
| WP3 | Launcher, binary resolution, host detection | Sonnet · high | ✅ merged | #5 |
| WP4 | Config, layering, trust | Opus · medium | ✅ merged | #10 |
| WP5 | Router + explain | Opus · medium | ✅ merged | #8 |
| WP6 | State store | Sonnet · high | ✅ merged | #7 |
| WP7 | Worktree sandbox | Sonnet · high | ✅ merged | #6 |
| WP8 | Host prototype (real CLIs) | Sonnet · high | ✅ merged | #11 |
| WP9 | Validate, presets, model tables | Sonnet · high | ✅ merged | #18 |
| WP10 | Shadow decisions + compare | Sonnet · high | ✅ merged | #14 |
| WP11 | Quota core | Sonnet · high | ✅ merged | #13 |
| WP12 | Patch pipeline | Opus · medium | ✅ merged | #12 |
| WP13 | Process supervisor | Sonnet · high | 🔧 fixing macOS CI (orphan after SIGINT) | #19 |
| WP14 | Claude adapter | Opus · medium | ✅ merged | #17 |
| WP15 | Codex adapter | Opus · medium | ✅ merged | #15 |
| WP16 | Antigravity adapter (read-only) | Sonnet · high | ✅ merged | #16 |
| WP17 | Setup framework + hook entry | Opus · medium | ✅ merged | #21 |
| WP18 | Quota readers | Sonnet · high | ✅ merged | #20 |
| WP19 | Runner core | Opus · medium | 🔨 in progress | |
| WP20 | Composition root + CLI read commands | Sonnet · high | 🔨 in progress | |
| WP21 | Repo install/uninstall | Sonnet · high | 🔎 rebasing onto WP17 | #23 |
| WP22 | Claude Code host (soft) | Sonnet · high | 🔨 in progress | |
| WP23–WP31 | — | see plan §4 | ⏳ pending | |

Escalations Sonnet → Opus: none so far.

CI hygiene fixes by the lead: biome excludes raw fixtures and Markdown; fake CLI signal race on macOS (#22).

## Acceptance checklist (spec §12)

| Item | State |
|---|---|
| UC1–UC14 | ⏳ not yet testable (core packages in progress) |
| AC1 automated UC tests | ⏳ |
| AC2 install+uninstall empty diff | 🟡 global part byte-identical (WP17); repo part in PR #23 |
| AC3 every decision reproducible + logged | ⏳ |
| AC4 works with all quota readers disabled | ⏳ |
| AC5 invisible to collaborators | 🟡 hook guard + silent hook entry tested (WP3, WP17); e2e in WP29 |
| AC6 English docs | ⏳ |
| AC7 no credentials copied/logged/sent | 🟡 redaction canaries (WP6), patch secret scan (WP12), readers never open credential files (WP18); suite in WP28 |

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

6. Antigravity read-only runs: the adapter maps SUCCESS-with-denied-actions to `failed`; the runner (WP19) reports read-only tasks with a non-empty answer as `success` with the denied actions logged, since text-only output is the expected result.
7. Delegated-run artifacts (patch, events log) live in `<repo>/.dispatch/state/runs/<id>/` (gitignored by `.dispatch/.gitignore`) so host sessions can read the patch without extra permissions (WP8 finding); fallback `~/.dispatch/runs/<id>/` outside an installed repo.
8. Claude plugin uninstall via the `claude` CLI leaves empty settings keys; `uninstall --global` removes exactly the keys Dispatch's install added (pre-install snapshot), restoring `~/.claude/settings.json` byte-for-byte.

## Process notes

- Repo-local git `user.email` set to the GitHub noreply address (pushes with the private email are rejected by GitHub).
