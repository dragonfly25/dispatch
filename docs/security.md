# Dispatch security model

This document covers what Dispatch protects, who it assumes may be hostile, and what stops each
attack. It also links the test that proves each defence and says what remains exposed. It covers
v0.1: spec §2 (invariants), spec §9, plan §2 and plan §7 (deviations 7–11).

**Short version.** Dispatch is a router, not a sandbox. Each child CLI's own OS sandbox is what
isolates it (Claude's sandbox, Codex `workspace-write` or `read-only`, agy's headless auto-deny).
Dispatch adds four things around that sandbox:

- it picks the child's flags, environment and working directory;
- it keeps repo content from weakening the user's own settings;
- it filters whatever comes back before the host sees it;
- it never commits or pushes anything, and applies a patch only for an intercepted Claude Code
  custom agent, after re-checking it (T12).

## 1. Assets

| Asset | Where it lives | What must hold |
|---|---|---|
| The user's repository | working tree, `.git/` (hooks, config, refs) | Changed only by the user or host. Dispatch returns a patch file; it applies one only through `dispatch apply` for a handoff run (T12), to the working tree only. |
| The user's agent files | `<repo>/.claude/agents/*.md`, `~/.claude/agents/*.md` | Read by the Claude hook; never written, moved or copied. |
| Host and CLI configuration | `~/.claude`, `~/.codex` (config.toml, hooks.json, rules), `~/.gemini`, `~/.agents` | Dispatch writes only its own entries, at user scope, and setup records them. A run writes nothing there. |
| Credentials | CLI OAuth files (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`), API keys and tokens in the environment | Dispatch never reads, copies, logs or sends them (AC7). Children never inherit them from Dispatch's environment. |
| Quota and money | subscription windows, API pools | Runs are bounded by concurrency limits, timeouts and the depth limit. The user's global config alone sets the ceilings. |
| Dispatch's own state | `~/.dispatch/` (config, `trusted_repos`, SQLite state, worktrees), `<repo>/.dispatch/state/` (run dirs) | Contents are redacted before they are written. Nothing under these paths is ever part of a patch. |

## 2. Trust boundaries

```
 host model ──(Bash / hook)──▶ dispatch CLI ──(argv, allow-listed env, stdin)──▶ child CLI
  (Claude Code,                 (trusted code;           ▲                         (official claude /
   Codex)                        user's global config)   │ JSONL events,           codex / agy, inside
     ▲                                                   │ patch, -o file          its native sandbox,
     │  RunResult: redacted summary marked               │                         cwd = worktree)
     └──── EXTERNAL_AGENT_OUTPUT + patch path ◀──────────┘                              │
                                                                                         ▼
 repo content (.dispatch/ policy, source files, prompts in files) ─── read by ───▶ Dispatch and the child
```

1. **Host model → Dispatch.** The host model is driven by a prompt and may have been prompt
   injected. It controls the task text and the task flags, but not the security settings.
2. **Repo → Dispatch.** `.dispatch/` is data from whoever controls the repo. It is applied only
   after `dispatch trust`, only while its bytes match the hash taken at trust time, and only to
   tighten security keys.
3. **Dispatch → child.** The child is an official CLI running a model that may have been prompt
   injected. It gets a fresh worktree, an allow-listed environment, and fixed safety flags that
   are not configurable.
4. **Child → Dispatch → host.** Everything the child emits is untrusted data. That covers its
   events, its final message, the files it changed and the `-o` file. It is redacted, filtered
   and labelled before the host sees it.

## 3. Attacker models

| Id | Attacker | Controls | Wants |
|---|---|---|---|
| A1 | Malicious repo or PR author | `.dispatch/` (config, profiles, mappings) and any file in the repo | Loosen autonomy, smuggle env secrets to a child, enable agy, raise concurrency, run their own binary, plant hooks |
| A2 | Prompt-injected repo content | text read by the child or the host (README, code comments, issue text) | Make the child escape the worktree, write hooks, read credentials, exfiltrate data, recurse |
| A3 | Prompt-injected host model | the task text and the `dispatch` flags it passes | Delegate above the user's ceilings, recurse, spend quota |
| A4 | Compromised or misbehaving child CLI output | stdout/stderr, files in the worktree, symlinks, the `-o` file | Inject instructions into the host, get a malicious patch applied, leak secrets into logs |

## 4. Threats, mitigations, proofs, residual risk

The suite lives in `test/security/` and runs with `pnpm test:security`; it is also part of
`pnpm test`, and CI runs it on every OS and Node version in the matrix. Its tests run as real
processes: the built CLI (`dispatch run --json`, `explain`, `trust`, `validate`) and the hook
entry, so the real config loader, composition root, runner, adapters, probes and spawner run. They
run against the fake CLIs, a temporary HOME and a temporary repo. Unit-level proofs sit next to each
module.

### T1. A repo policy or flags loosen a security key (A1, A3)

- **Mitigation.**
  - Security keys are tighten-only against the global config:
    - `autonomy`, `allowed_providers`, `concurrency`, `max_depth`, `network`, `worktree.*`;
    - per instance: `enabled`, `binary`, `max_autonomy`, `concurrency`, `env_passthrough`.
  - A looser repo or flag value is ignored and reported as an error issue: `validate` exits 2,
    and `run` exits 2 before deciding anything.
  - A repo cannot add instances.
  - agy is capped to read-only and needs `tos_acknowledged` in the global config.
  - Per-task `--autonomy` above the ceiling is filtered by the router, so the task stays with the
    host.
  - Source: `src/config/merge.ts`, `src/router/filters.ts`.
- **Proof.**
  - `test/security/config.test.ts`: `[SEC-flags]` covers a trusted hostile `.dispatch/config.yaml`
    (the effective security config equals the global-only baseline, and every attempt is an error
    issue), the same
    values as flags, the run path refusing with exit 2 and spawning nothing, and
    `explain --autonomy direct|worktree` under `autonomy: read-only` never delegating.
  - Unit tests: `test/unit/config/merge.test.ts` `[SEC-flags]`, including a property test that no
    repo/flag combination is looser than global.
- **Residual risk.**
  - A trusted repo still controls ordinary routing keys: pins, profiles, presets, thresholds and
    the active profile. It can steer which allowed provider runs a task, and so whose quota is
    spent, but only within the user's ceilings.
  - `--autonomy` above the ceiling is not rejected with exit 2. `explain` shows it as "filtered"
    on purpose, so the user can see why.

### T2. An unreviewed or altered repo policy is applied (A1)

- **Mitigation.**
  - Repo policy applies only after `dispatch trust`, which records a sha256 over the relative path
    and bytes of every policy file in the global `trusted_repos`.
  - The repo is identified by the realpath of its git common dir.
  - Files are read once with `O_NOFOLLOW`, and the buffer that was hashed is the one parsed, so a
    swap between the two has no effect.
  - Any symlink in `.dispatch/` voids trust.
  - When the hash mismatches, the policy is ignored with a visible warning that names the files.
  - Source: `src/config/trust.ts`.
- **Proof.**
  - `test/security/config.test.ts` `[SEC-trust]`: an added file, a renamed file, a symlinked
    `config.yaml` (also refused by `trust`, exit 2), a linked worktree with a modified policy, and
    a TOCTOU swap through the fault hook, where the trusted bytes are applied and the next load
    reports `changed`. Each case checks the warning in `explain`.
  - Unit tests: `test/unit/config/trust.test.ts`.
- **Residual risk.** Trust grants the policy bytes, not their intent. A user who trusts a hostile
  policy gets that routing (T1 residual), but never looser security.

### T3. The child writes outside its worktree or plants hooks (A2, A4)

- **Mitigation.**
  - Each task runs in a fresh linked worktree under `~/.dispatch/worktrees`, and the child's own
    OS sandbox confines its writes:
    - Claude: `sandbox.failIfUnavailable`, a fixed tool list and no `Agent` tool;
    - Codex: `-s workspace-write|read-only`;
    - agy: read-only through headless auto-deny.
  - Dispatch fails closed when a CLI lacks the required flags or features.
  - The patch is collected in a temporary index, and the filter rejects:
    - `..`, absolute paths and symlinks;
    - `.git*`, `.dispatch/`, host config directories (`.claude/`, `.codex/`, `.agents/`, ...);
    - `.env*` and pinned paths.
  - Rejected paths are reset before the final diff and listed in `patch.rejectedPaths`.
  - When the filter rejects every change, the result still carries `patch`: no file,
    `diffstat` `""`, `applies: false` (there is nothing to apply) and the `rejectedPaths`, so the
    host sees what was dropped (spec §9 rule 6). Only a run that changed nothing has
    `patch: null`.
  - `git apply --check` runs against the current tree.
  - Dispatch never applies the patch.
  - Sources: `src/sandbox/`, `reportedPatch` in `src/runner/orchestrate.ts`.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-patch]`:
    - `escape_writes` (`.git/hooks/pre-commit`, `../outside.txt`, an absolute path,
      `.dispatch/config.yaml`, `.claude/settings.json`) yields rejected paths, a patch holding only
      the legitimate file, and a byte-identical user tree and `.git/hooks`;
    - `symlink` (`/etc/passwd`, `../..`, and replacing a tracked file with a link) produces no
      patch file; `RunResult.patch` reports `diffstat: ""`, `applies: false` and the three
      rejected paths.
  - Unit tests: `test/unit/sandbox-filter.test.ts`, `test/unit/sandbox-patch.test.ts`,
    `test/unit/sandbox.test.ts`.
- **Residual risk.**
  - **The worktree is not an OS boundary.** Without the CLI's sandbox, a child can write anywhere
    the user can. The fake CLIs prove this: their out-of-tree writes succeed, and only the patch
    stays clean. Dispatch relies on the official sandboxes (deviation 11) and fails closed when it
    cannot request them, but it cannot verify them at runtime.
  - Network access is not restricted (spec §9.5).

### T4. Secrets reach the child through the environment (A2, A4)

- **Mitigation.**
  - The child environment is built from an allow-list: `PATH HOME USER LOGNAME LANG LC_* TMPDIR
    SHELL`, `TERM=dumb`, adapter-owned variables and the user's global `env_passthrough`.
  - A deny-list wins even over passthrough: `*TOKEN*`, `*_API_KEY`, `CLAUDECODE*`,
    `CLAUDE_CODE_*`, `CODEX_*`, `ANTIGRAVITY_*` and `NODE_OPTIONS`.
  - Probes get their own minimal environment.
  - Every withheld value is added to the redactor.
  - Exception (T13): with MCP forwarding, exactly the variables a forwarded server references
    pass by name (`dangerouslyAllow`), and their values are redacted too.
  - Source: `src/runner/env.ts`.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-env]`: with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
    `GITHUB_TOKEN`, `CANARY_SECRET`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `CODEX_THREAD_ID`
    in the parent, the fake child's logged environment (and every probe's) holds none of them,
    and `DISPATCH_DEPTH=1` is set. The same check runs separately for `NODE_OPTIONS`.
  - Unit tests: `test/unit/runner-env.test.ts`, `test/unit/runner-proc.test.ts`.
- **Residual risk.** The child still runs as the user, with the user's HOME. Its own credentials
  are reachable by its process: that is how it authenticates. Only its sandbox's read-deny keeps
  the model from reading them (T6).

### T5. Recursion and runaway spend (A2, A3)

- **Mitigation.**
  - `run` refuses with exit 3 when `DISPATCH_DEPTH ≥ max_depth` (default 1), before deciding
    anything.
  - Every hook exits silently when `DISPATCH_DEPTH` is set.
  - The Claude child has no `Agent` tool; Codex runs with `agents.enabled=false`, and hooks and
    plugins are disabled.
  - Concurrency leases and monotonic timeouts bound spend.
  - Sources: `src/runner/depth.ts`, `src/runner/lease.ts`.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-recursion]`: a fake child runs `dispatch run` again; the
    inner run exits 3 with `rejected` and no decision, and the outer run completes.
  - Unit tests: `test/unit/runner-depth.test.ts`, and `test/unit/runner-proc.test.ts`
    ("recursion guard through the recurse scenario").
- **Residual risk.** The guard depends on the environment variable surviving. A child that clears
  it and calls `dispatch` from a fresh shell would not be stopped. The CLI sandboxes and the
  absence of a sub-agent tool make that path unlikely, but it is not impossible.

### T6. Dispatch or a child copies, logs or sends credentials (AC7)

- **Mitigation.**
  - Dispatch never opens credential files.
  - Quota comes from official channels: Claude's passive `rate_limit_event` and the official
    `claude -p /usage` command (spec §2.2: no undocumented endpoint, no credential access; the CLI
    uses its own login), the Codex app-server, and agy `/usage`.
  - `claude -p /usage` also prints a breakdown of local sessions (subagent names, request counts).
    The reader cuts the output to the `Current …` quota lines as soon as the child exits; the
    breakdown is never stored, logged or sent to a model. Only if those lines cannot be parsed, and
    only in `status`/`doctor` (never while routing), the trimmed header is sent to Haiku
    (`claude -p --model haiku --tools ""`, one turn, no session file), which spends a little Claude
    quota; its answer is dropped unless every number and time appears literally in that header.
    Turn it off with `quota.readers.claude-usage.llm_fallback: false`.
  - Every string bound for SQLite, the run log or stdout is redacted, using both patterns and the
    withheld env values.
  - The summary is redacted and length-capped.
  - The Claude child's settings deny Read on `~/.claude`, `~/.codex`, `~/.gemini`, `~/.dispatch`,
    `~/.ssh`, `~/.aws` and `.env*`, with an OS-level `denyRead`.
  - The Codex `-o` output file is read and then deleted. The child writes it unredacted, so only
    the redacted result keeps its text.
  - Sources: `src/state/redact.ts`, `src/runner/attempt.ts`, `src/adapters/claude/invocation.ts`.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-redact][AC7]`, for both codex and claude, using
    `leak_secret` and canary credential files planted in the temp HOME.
  - It finds zero canary hits in the raw bytes of every file under `~/.dispatch` (`dispatch.db`
    with its `-wal`/`-shm`), in the in-repo run dir (events log, attempt dirs), and in stdout and
    stderr.
  - The `fs-trace.cjs` preload (`node --require test/security/fs-trace.cjs …`) records every path
    the Dispatch process opens, reads, copies or stats; none is under `~/.claude`, `~/.codex` or
    `~/.gemini`.
  - Unit tests: `test/unit/state-redact.test.ts`, `test/unit/state-canary.test.ts`,
    `test/unit/sandbox-secrets.test.ts`, `test/unit/quota-readers-integration.test.ts`
    (`[SEC-cred]`), and `test/unit/adapters/claude-invocation.test.ts` (`[SEC-claude-cred]`).
- **Residual risk.**
  - Redaction is best-effort pattern matching. A secret in an unknown format that never appeared
    in Dispatch's environment is not masked.
  - The patch file holds the child's work verbatim, since it has to apply. A secret scan flags it
    (`needsReview`) but does not change it.
  - The fs-trace covers `node:fs` and not native code: SQLite opens only the state db.
  - The children are not traced; their credential reads are governed by their own sandboxes.
    The live canary Read in WP1 verified this for Claude.

### T7. Antigravity is used beyond read-only, or without consent (A1, A3)

- **Mitigation.**
  - agy is disabled by default.
  - Enabling it needs `enabled` plus `tos_acknowledged` in the global config; a repo cannot
    enable it (T1).
  - `max_autonomy` is hard-capped to read-only, so the router filters agy out of every worktree
    task.
  - The adapter rejects worktree and direct autonomy and never passes
    `--dangerously-skip-permissions`.
  - A disabled instance is never spawned, not even for a quota read.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-agy-ro]` covers three cases:
    - a worktree task with a rule naming agy first goes to codex, and agy never runs;
    - a read-only task runs on agy without the dangerous flag and yields no patch, even though the
      fake edited files;
    - with agy disabled (the default) it is never spawned.
  - Unit tests: `test/unit/adapters/agy.test.ts` and `test/unit/app-readers.test.ts`.
- **Residual risk.**
  - agy's user hooks and plugins cannot be disabled in the child; `doctor` discloses this.
  - Google's FAQ says wrapping agy is "not supported under consumer plans". Using it is the
    user's informed choice.

### T8. The Codex child persists trust or reads user config (A2, A4)

- **Mitigation.**
  - Every Codex invocation adds `--ignore-user-config --ignore-rules --strict-config`.
  - It disables hooks, plugins, apps and memories, and sets `agents.enabled=false`.
  - It adds a side-effect guard, `-c projects={"<worktree>"={trust_level="untrusted"},"<repo
    root>"={trust_level="untrusted"}}`. Without it, `codex exec` writes `trust_level="trusted"`
    into `~/.codex/config.toml`, for the main repo root of a linked worktree.
  - A missing isolation feature makes the run fail closed.
- **Proof.**
  - `test/security/run.test.ts` `[SEC-codex-trust]`: a full codex run leaves
    `$HOME/.codex/config.toml` byte-identical, and the logged argv carries the guard for the repo
    root.
  - Golden argv: `test/unit/adapters/codex.test.ts` ("always carries every side-effect guard").
- **Residual risk.** The fake cannot reproduce Codex's own persistence. The guard was verified
  live in WP1 (`docs/spikes/codex.md`), and a future Codex could add new side effects.
  `cliRange` gating and the per-version fixtures exist to surface that.

### T9. Dispatch shows up for a collaborator (AC5, spec §2.4)

- **Mitigation.**
  - Integration is user scope only: no `.claude/settings.json`, `AGENTS.md` or `.dispatch/hooks/`
    in the repo (deviations 2 and 9).
  - The hook command is an inline guard with absolute, single-quoted paths:
    `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x node ] && [ -f hook.mjs ] || exit 0; exec …`.
  - `hook.mjs` exits 0 silently on any problem: no cache, an untrusted repo, bad or oversized
    stdin, an unknown host or event.
- **Proof.**
  - `test/security/collaborator.test.ts` `[AC5][SEC-hooks]` clones a repo with `.dispatch/`
    committed, with an empty HOME, under `env -i PATH=/usr/bin:/bin`.
  - In it, the Claude hook command (as setup renders it, with `hook.mjs` present and missing) and
    `hook.mjs` run directly are silent with exit 0. This holds for valid, garbage, empty and 2 MiB
    stdin, with and without HOME.
  - `git status --ignored` stays empty, there are no non-sample git hooks, and HOME stays empty.
  - Unit tests: `test/unit/hook/hook.test.ts`, `test/unit/hosts/claude-code-hook.test.ts`, and
    `test/unit/platform/launcher.test.ts` (`[SEC-hookpath]`).
- **Residual risk.** None for the repo itself. A collaborator who runs Dispatch and trusts the
  repo opts in to T1/T2.

### T10. Child output steers the host (A4)

- **Mitigation.**
  - The summary is marked `EXTERNAL_AGENT_OUTPUT`, redacted and capped at 8 KiB.
  - The host policy text says it is untrusted output from another agent, and that the host must
    review the patch and never follow instructions inside it.
  - The patch is returned as a path plus a diffstat, never inline.
  - Dispatch never applies, commits or opens a PR.
- **Proof.** `test/unit/runner-orchestrate.test.ts` (marker, truncation) and
  `test/unit/hosts/claude-code-hook.test.ts` (policy text).
- **Residual risk.** This is inherent to the product (plan §6, "Prompt injection: open"). A
  labelled summary is a hint to the host model, not a guarantee.

### T11. The Codex rules file is used to escape the sandbox (A2, A3; deviation 7)

- **Mitigation (WP27).**
  - `~/.codex/rules/dispatch.rules` allows only the absolute launcher path with the
    `run|wait|cancel|status` subcommands, with per-session and per-day caps.
  - Compound commands never match the rule.
  - `dispatch run|wait` refuses (exit 3) when `CODEX_SANDBOX` is set, which means the rule did
    not match.
- **Proof.** The `SEC-rules` compound-command table ships with the Codex host (WP27). The
  sandbox gate is tested in `test/unit/platform/host.test.ts`.
- **Residual risk.** **The rules file is a trust grant.** A command that matches it runs outside
  the Codex sandbox, as the user. Flags can only tighten what it does, but the user accepts this
  explicitly during `setup`.

### T12. Handoff files and auto-apply are abused (A1, A2, A4)

Claude hard mode for custom agents (after v0.1.0) passes an agent's instructions and task through
`~/.dispatch/handoffs/<id>.json` and, when the run succeeds, applies its patch.

- **Mitigation.**
  - The hook writes the handoff atomically with mode 0600 under a random 128-bit id; the relay
    prompt carries only the id, so no task text is ever shell-quoted.
  - `run --handoff` accepts only a 32-hex id, refuses a symlink, a non-regular file, a symlinked
    `handoffs` directory, a file of another user or readable by others, a file older than 1 h and
    malformed contents, and deletes the file once read. `gc` removes stale handoffs.
  - The agent's model, effort and autonomy are requests: routing, autonomy ceilings and every
    tighten-only security key still apply. Agents that need tools Dispatch cannot give the child
    (desktop browser, web tools, non-forwardable MCP servers, unknown tools) are never delegated.
  - `dispatch apply <runId>` applies only a run recorded from a handoff (0600 record under
    `~/.dispatch/handoff-runs/`, written by Dispatch itself) with `autoApply`, with
    `hosts.claude-code.auto_apply` not false in the global config, status `completed` and outcome
    `success`, a patch that applied when the run ended, `needsReview` false, no `rejectedPaths`, in
    the same repository, once. It re-runs `git apply --check` against the current tree and then
    `git apply` (working tree only: no index, no commit). Any refusal changes nothing.
  - The patch is the filtered one (T3), so `.git*`, `.dispatch/`, host config dirs, `.env*` and
    pinned paths can never be applied.
  - Loop guard: a handed-back run records a hash of (agent type, prompt) in
    `~/.dispatch/hook-passthrough.json` (0600, 30 min, at most 100 entries); the next identical call
    runs natively once.
- **Proof.** `test/unit/hosts/claude-code-agents.test.ts` and `test/unit/cli-handoff.test.ts`
  `[SEC-handoff]` `[SEC-apply]` (each refusal leaves the tree snapshot unchanged).
- **Residual risk.** **Auto-apply is a deviation** from "Dispatch never applies patches" (owner
  decision): the external agent's edits land in the working tree without the host reviewing them
  first, as a native sub-agent's would. They are unstaged and visible in `git diff`. A local
  process running as the user could forge a handoff or a record; it could equally edit the files.
### T13. An external, unsupervised agent gets the user's MCP tools (A2, A3; after v0.1.0)

Context: when Claude Code hands one of the user's custom agents to Dispatch, the agent may use MCP
tools (`mcp__<server>__*`). With the user's consent, the external agent that runs it (codex only)
starts those servers itself. That agent is unsupervised and may be prompt injected: whatever a
forwarded server can do (open issues, query a database, post messages), the child can do too.

- **Mitigation.**
  - **Consent.** `hosts.claude-code.forward_mcp` is a trust grant asked once by `dispatch setup`
    (default yes in the wizard, as the owner approved; `--forward-mcp` / `--no-forward-mcp` or
    `forward_mcp:` in the answers file; absent = false, so a non-interactive setup never assumes
    it). It is global only and tighten-only: a repo or flag `forward_mcp: false` turns it off,
    `true` is ignored and reported as an error. `setup --refresh` keeps the existing value.
  - **Only what the agent needs.** The runner receives server NAMES (the handoff's `mcpServers`)
    and re-resolves them from the user's Claude config at run time (`src/runner/mcp.ts`): the
    hook's view is never trusted. An unknown server (built-in app tools such as `Claude_Browser`),
    a server that is no longer forwardable or a referenced variable that is not set returns the task
    to the host with the reason. The child still loads no other MCP server, hook, plugin or
    project config (`--ignore-user-config --strict-config`, the untrusted-project override).
  - **Secrets rule.** Credential values are never copied. A server is forwardable only when every
    `env` and header value is a pure `${VAR}` reference with the same name (`GH_TOKEN:
    ${GH_TOKEN}`); a literal value, a default (`${VAR:-x}`), text around the reference, a reference
    in `command`/`args`/`url`, `headersHelper` or OAuth makes it not forwardable. Codex then gets
    the NAME (`env_vars`, `env_http_headers`) and the value reaches the codex process from
    Dispatch's own environment through an explicit `dangerouslyAllow` of exactly those names. The
    values go to the redactor and never to disk, argv, state or logs; `shell_environment_policy.
    exclude` keeps them out of the agent's own shell commands. Host markers, `DISPATCH_*`,
    `NODE_OPTIONS`, `LD_*`/`DYLD_*` can never be referenced.
  - **Repo-defined servers.** A `.mcp.json` server is forwardable only when the user approved it
    in Claude Code (`enabledMcpjsonServers` / `enableAllProjectMcpServers` in `~/.claude.json`,
    the user settings or the gitignored `.claude/settings.local.json`; never the repo-shared
    `.claude/settings.json`).
  - **Targets.** Only codex hosts forwarded servers (stdio and streamable HTTP). Claude's
    `--safe-mode` drops `--mcp-config`, so claude instances are excluded by the router; agy never
    receives MCP. Adapters refuse forwarded servers they cannot host (fail closed).
  - The user's MCP config is read, never modified (`src/mcp/resolve.ts`).
- **Proof.**
  - `test/unit/mcp/resolve.test.ts` `[SEC-mcp]`: precedence (local > project > user), project
    approval, `${VAR}` vs literal secrets and every other refusal, missing and malformed files,
    run-time re-resolution.
  - `test/unit/mcp/forward.test.ts` `[SEC-mcp][SEC-env]`: golden codex `-c` overrides with and
    without servers, no value in argv or stdin; claude and agy refuse; router capability filter.
  - `test/unit/runner-orchestrate.test.ts` "MCP forwarding": a canary token passes by name to the
    codex process only; argv, stdin, the summary, the run log and the SQLite files never hold it;
    consent off, a server that became a literal secret, and no capable provider all return the
    task to the host without spawning anything.
  - `test/unit/config/merge.test.ts`, `test/unit/setup-wizard.test.ts`,
    `test/unit/hook-cache-writer.test.ts`: tighten-only consent, setup, refresh, cache fields.
  - Live spikes: `docs/spikes/mcp-forwarding.md`.
- **Residual risk.** A forwarded server runs as the user, outside the child's sandbox (codex
  starts it), with the tools the user granted it in Claude Code, now driven by an unsupervised
  agent. Literal secrets in `args` (e.g. `--token abc`) are not detected; keep secrets in `env`
  references. Doctor `claude-code.mcp-forwarding` lists, per repo, what would be forwarded.

## 5. Accepted risks and disclosures

- **MCP forwarding is a trust grant** (T13): the external agent can use the forwarded servers'
  tools with the user's privileges.

- **The worktree is not an OS boundary** (T3). Isolation rests on each CLI's native sandbox.
  Dispatch fails closed when it cannot request that sandbox, but cannot prove it at runtime.
- **agy user hooks and plugins cannot be disabled** in the child (T7).
- **The Codex rules file is a trust grant** (T11).
- **Auto-apply of intercepted Claude Code custom agents** (T12), on by default;
  `hosts.claude-code.auto_apply: false` turns it off.
- **Automated use of Claude subscriptions is a terms-of-service grey area.** Fanning out over a
  consumer Claude plan through `claude -p` may not match Anthropic's intended use; the README
  discloses it. Each instance's billing pool appears in `status`, and there are no technical
  workarounds.
- **Network is unrestricted** for children (spec §9.5).
- **Redaction is best-effort** (T6), and patches are not redacted.

## 6. Running the suite

```sh
pnpm test:security            # test/security only
pnpm test                     # everything, including test/security (CI matrix)
```

The suite bundles `src/cli/main.ts` and `src/hook/entry.ts` into
`node_modules/.cache/dispatch-security/`, so it never depends on, or races with, `dist/`. It
never touches the real HOME and never calls a real CLI: `test/support/guard.ts` fails the run if
one is reachable.
