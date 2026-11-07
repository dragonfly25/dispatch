# ADR 0002: WP1 contract freeze (adapters and host integrations)

- Status: accepted
- Date: 2026-11-07
- Work package: WP1
- Supersedes: the `@provisional` items of [ADR 0001](0001-frozen-contracts.md) §3

## Context

ADR 0001 left the adapter and host-integration contracts provisional until the WP1 live spike had recorded real CLI behaviour. The spike ran against claude 2.1.301, codex 0.167.0 and agy 1.5.2. Its results are in [`docs/spikes/`](../spikes/README.md):
- [codex](../spikes/codex.md)
- [claude-code](../spikes/claude-code.md)
- [agy](../spikes/agy.md)
- [hosts](../spikes/hosts.md)
- [proposal](../spikes/contracts-proposal.md)

## Decision

The following are now frozen in `src/core/contracts.ts`, and the `@provisional` markers are removed. Any further change needs a new ADR.

### Additions to contracts that were already frozen (additive; they do not affect `RunResult`)

| Contract | Change | Reason (spike) |
|---|---|---|
| `NormalizedEvent.kind` | adds `"denied"` | All three CLIs report refused tool actions: claude `permission_denials` and `permission_denied`, agy `TOOL_ERROR`, sandbox violations. |
| `NormalizedEvent.path?` | worktree-relative path for reading and editing events | Codex `file_change` carries absolute paths that adapters must relativize. |
| `QuotaSignal` (new) | records which evidence classified a run as `quota_exhausted` | Each CLI signals quota differently: claude `rate_limit_event`, `error`, 429 or text; codex `turn.failed` text; agy `AGY_ERROR`. |
| `AdapterOutcome.deniedActions` (required) and `quotaSignal?` | — | agy returns `status: "SUCCESS"`, exit 0, even when it denied the only useful action, so `finalize` must see the denials and map them to `failed`. |

### Shapes frozen from the provisional set

| Contract | Change vs provisional | Reason (spike) |
|---|---|---|
| `AdapterCapabilities` | `quotaChannel` gains `"passive+reader"`; adds `promptChannel`, `isolation`, `sandbox`, `childNetwork` | agy ignores stdin (`-p -` is taken literally), so its prompt goes in argv. agy user hooks and plugins cannot be disabled. `doctor` must disclose isolation. |
| `Invocation` | `stdin` becomes nullable; adds `outputFile?`, `redactArgvIndexes`, `sideEffectGuards` | agy needs the prompt in argv, which must be redacted in logs. codex writes its final message with `-o`. `codex exec` persists project trust into `~/.codex/config.toml` unless an untrusted-project override is passed, so guards are named and asserted by golden-argv tests. |
| `ProbeResult` | adds `realpath`, `features`, `outsideCliRange` | Codex `--disable` names must be validated against `codex features list`. Homebrew Caskroom realpaths carry the version. |
| `AdapterDeps` (new) | `probe(instance, deps)` and `readQuota?(instance, deps)` take an injected `{ spawner, clock, resolveBinary }` | Boundary rule: only `src/runner/` may spawn processes, so adapters stay free of `child_process` and are tested with `ScriptedSpawner`. |
| `BuildInvocationArgs` | adds `repoRoot`, `runDir`, `baseEnv` | The codex trust guard needs the main repo root, because in a linked worktree codex trusts the main repo. `-o` needs a run dir. The runner owns the env allow-list. |
| `AdapterRunContext` | adds `worktree` | Used to relativize event paths. |
| `Adapter.parseLine` | gains a `stream` argument | agy reports errors (`AGY_ERROR`, auto-deny notices) on stderr. |
| `EditOp` | adds `mode?`, `sha256?`, `trustGrant` (nullable, required) | The Codex rules file is a trust grant shown verbatim by `setup`. Uninstall must verify bytes before removing. |
| `HostPlanContext` | adds `nodePath` | Hook commands must not rely on PATH, because GUI-launched hosts may get `/usr/bin:/bin:/usr/sbin:/sbin`. |
| `SubagentStrategy` (new) | `"none" \| "deny_redirect"` | UC3 is decided. Current Codex models use multi-agent V2: the hook sees `collaborationspawn_agent` with an encrypted `message`, and an `updatedInput` proxy fails with `invalid_encrypted_content`. Deny-with-redirect was verified end-to-end. `proxy_subagent` is deliberately not representable. |
| `HookInput` (new) | typed common hook stdin; `model?` optional | Codex SessionStart and PreToolUse include `model`; Claude `-p` SessionStart does not. |
| `HostIntegration` | `id` narrowed to `"claude-code" \| "codex"`; adds `subagentStrategy`, `subagentMatcher`, `waitTimeoutSec`, `detectSelf(env)`; handlers take `HookInput` | Matcher `spawn_agent\|collaborationspawn_agent\|Agent`. Codex wait is 280 s (unified exec polls up to 300 s); Claude wait is 100 s. Host detection is env-only (`CLAUDECODE`, `CODEX_THREAD_ID`), because the desktop app bundles its own claude version. |

`RunResult` v1 and its JSON Schema snapshot are **unchanged**. None of the changed types is reachable from `RunResultSchema`.

## Consequences

- **Adapters (WP14–16)** implement `Adapter` with injected deps and must record `deniedActions`. The codex adapter must emit the `codex-project-trust-untrusted` and `codex-agents-disabled` guards. agy uses `promptChannel: "argv"`.
- **WP3** provides `resolveBinary`, and **WP13** provides the real `Spawner` used for `AdapterDeps`.
- **Host packages (WP17, WP22, WP27)** build `EditOp`s with `trustGrant` and `sha256`. WP27 implements `deny_redirect`.
- **Tests.** `test/stubs` gains `ScriptedSpawner`. `test/fixtures/contracts.ts` gains sample capabilities, invocations, outcomes, events and edit ops.
- **Lint.** Recorded CLI fixtures (`test/fixtures/{claude,codex,agy}`) are excluded from biome, so they stay byte-identical to what the sanitizer produced.
