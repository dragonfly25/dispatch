# Dispatch v0.1: Final Plan (Phase 1)

## Context
Dispatch lets a user who has several AI subscriptions keep working in one client (Claude Code, Codex CLI or Antigravity CLI) while delegable agent tasks run on the *other* providers. Those tasks go to the providers' official CLIs, run headless in isolated git worktrees. Routing is driven by quota, rules and profiles. The spec (docs/SPEC.md, Italian) defines what to build; this plan defines how. The repo is greenfield and holds only the spec.

**How this plan was produced.**
- Round 1, run in parallel: three CLI verification agents (claude, codex, agy), a red-team pass on the spec, then architecture, test-strategy and work-breakdown agents.
- A second verification round against the real CLIs installed on this machine.
- Round 2: the red-team critiqued the merged plan, and the architecture, test-strategy and work-breakdown agents revised their parts.

**Your decisions from the planning round.**
- The Antigravity target is experimental, opt-in and read-only.
- Host integrations are installed only at user/local scope.
- Security keys are global-only and tighten-only, and repo policy requires `dispatch trust`.
- The Codex rules file is accepted as a documented trust grant.
- `setup` and `install` become separate commands.
- The UC3 mechanism is chosen by the spike.

**Local environment.**
- `claude` 2.1.301 in `~/.local/bin`.
- `codex` 0.167.0 and `agy` 1.5.2 in `/opt/homebrew/bin`; all three CLIs are logged in.
- node 22.17, pnpm, uv.

---

## 1. Verification results

Legend: ✅ holds · ⚠️ partial or different · ❌ wrong or blocked. "live" means checked on the installed CLI; "src" and "docs" mean official source code or documentation.

### Claude Code (live on 2.1.301 + docs)

| Spec assumption | Verdict | Fact |
|---|---|---|
| `claude -p --output-format stream-json` | ✅ live | Requires `--verbose`. Events: `system/init`, `assistant`, `rate_limit_event`, `result{subtype, usage, total_cost_usd, api_error_status}`. `--effort` exists. |
| Clean headless child | ✅ live | `--safe-mode` plus `--permission-mode dontAsk\|acceptEdits` keeps subscription auth (`apiKeySource:none`) and loads no MCP servers, hooks, plugins or CLAUDE.md. `--bare` would lose subscription auth. Without isolation, `-p` loads the project's hooks, so recursion is a real risk. |
| "Hooks don't intercept sub-agent spawn" | ❌ outdated | Current docs: PreToolUse fires for `Agent`, with deny and `updatedInput`. SubagentStart cannot block, and no hook can return a substitute result. Not used in v0.1 (Claude stays soft, as the spec says). |
| Quota via the "undocumented OAuth endpoint" | ❌ conflicts with §2.2 | The endpoint exists, but calling it with the user's token is a direct OAuth API call, so it is dropped. Official replacements: the passive `rate_limit_event` emitted in every run (utilization plus reset time), statusline `rate_limits`, and `claude -p /usage` (no cost, but localized text only, so display-only). |
| MCP configured in `.claude/settings.json` | ❌ | Project MCP lives in `.mcp.json`. The plugin CLI (`claude plugin install … -s user`) is the clean channel. |
| Billing | ✅ docs | Support article dated 2026-10-07: `claude -p` draws from the subscription, and the June change is paused. Max/Ultra/Team monthly API credits are a separate pool. Automated fan-out is a grey area, so the README discloses it. |
| Second account | ✅ docs | Via `CLAUDE_CONFIG_DIR`. Credentials live in the macOS Keychain. |
| Host detection | ✅ live | `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID`. No env var gives the model; it comes from the SessionStart hook input, which doesn't always include it. |

### Codex CLI (source + live on 0.167.0)

| Spec assumption | Verdict | Fact |
|---|---|---|
| `codex exec --json` | ✅ live | Events: `thread.started`, `turn.started/completed{usage}`, `turn.failed`, `item.*` (types `agent_message`, `command_execution`, `file_change`, `reasoning`…). `--full-auto` has been removed. Isolation flags exist: `--ignore-user-config`, `--ignore-rules`, `--disable <feature>`, `--strict-config`, `--ephemeral`. Skills and recommended plugins are still injected. An editing run under workspace-write has not been verified yet; the spike covers it. |
| Quota exhaustion is detectable | ⚠️ src | In exec JSONL the only signal is the message text ("You’ve hit your usage limit"); the exit code is 1 for every failure. |
| `account/rateLimits/read` | ✅ live, official and documented | Costs no quota. Returns `primary` (300 min) and `secondary` (10080 min) windows with `usedPercent` and `resetsAt`, plus `ordinaryUsageAllowed`, `rateLimitReachedType` and `planType`. Notifications are interleaved in the stream. |
| Hooks behind a feature flag | ⚠️ | Hooks are stable and on by default, but each hook needs the user to trust it in the TUI `/hooks` screen (hash-bound). There is no CLI for this. |
| PreToolUse `updatedInput`; SubagentStart redirect | ✅ / ❌ | `updatedInput` and deny work, including on the `spawn_agent` matcher. SubagentStart cannot block. |
| AGENTS.md as the soft fallback | ⚠️ unnecessary | Skills (`~/.agents/skills`) and plugins exist, so AGENTS.md is never touched. |
| (implicit) Codex as host can run `dispatch` | ❌ blocker | The Codex sandbox has no network and a read-only `.git`, so `dispatch run` fails. Fix (you approved it): a new file `~/.codex/rules/dispatch.rules` that allows the absolute path of the Dispatch launcher. |
| Billing | ✅ | A ChatGPT login draws on the plan; an API key is a separate pool. The docs recommend API keys for automation but don't ban local use. |

### Antigravity CLI (docs + live on 1.5.2)

| Spec assumption | Verdict | Fact |
|---|---|---|
| Headless `agy` | ✅ live | `-p`; `--output-format stream-json`, with events keyed by **`event`** (`init`, `step_update`, `result`); `--model`, `--effort`, `--mode plan\|accept-edits`, `--sandbox`, `--disable-slash-commands`, `--settings`, `--print-timeout`. There is no cwd flag. Errors arrive as `AGY_ERROR: {json}` on stderr with exit code 3. |
| Stream events "to be verified" | ✅ | Documented and confirmed. |
| Hooks in `~/.gemini/settings.json` | ❌ | The real locations are `~/.gemini/config/hooks.json` and `.agents/hooks.json`. Rewrites use `overwrite`; context goes in via `injectSteps`. |
| Quota "via existing tools" | ⚠️ | Use the official `agy -p /usage --output-format json`, which costs no quota. It returns `groups[].buckets[]{window, remaining_fraction, reset_time}` for two groups, "Gemini" and "Claude and GPT"; only weekly buckets have been seen so far. The third-party tools call private endpoints with the user's token, which §2.2 forbids. |
| Gemini CLI is unusable for individual accounts | ✅ | Confirmed, since 2026-06-18. |
| Using a consumer plan through a wrapper | ❌ ToS | Google's FAQ says wrapping `agy` in third-party apps "is not supported under consumer plans", with a risk of suspension. Hence: experimental, off by default, ToS warning, read-only (your decision). |

---

## 2. Design

### Runtime and dependencies
- TypeScript on Node ≥22.13, built as an ESM bundle with tsup and published on npm with a `dispatch` bin.
- Libraries:
  - zod v4, with JSON Schema export
  - `yaml` (Document API, so comments survive edits)
  - commander
  - picomatch
  - semver
  - smol-toml (reading only)
  - jsonc-parser (byte-preserving edits)
  - `node:sqlite`, behind a `DbPort` interface
- vitest for tests, biome for lint and format.
- macOS and Linux only.

### Layout
```
src/core (contracts, clock, ids, errors) · cli/ · hook/ (light entry) · config/ (schema, load, tighten, trust)
router/ (pure decide + explain) · quota/ (core, estimator, readers/*) · adapters/{claude,codex,antigravity,fake}
sandbox/ (worktree, snapshot, patch, filter, applycheck, gc) · runner/ (proc, supervisor, env, lease, orchestrate)
state/ (db, migrations, redact) · hosts/{_framework,claude-code,codex}
assets/ (profiles, mappings, models/*.yaml, host templates) · test/{unit,contract,e2e,fakes,stubs}
```

### Module boundaries
- The router is a pure function: `decide(DecisionInput) → Decision + rule chain`. A lint rule bans `Date`, `Math.random` and `process.env` inside it.
- `runner` is the only module that spawns processes.
- `hosts/_framework` is the only module that writes host files.

### Adapter contract
- `caps {id, version, cliRange, streaming, autonomy[], quotaChannel, pool, experimental}`
- `probe()` returns the CLI version, the available flags and the login state.
- `buildInvocation(task, resolved, autonomy, worktree, instance, probe)`
- `parseLine()` returns normalized events: `reading`, `editing`, `running`, `thinking`, `done`, `error`.
- `finalize()` returns `{outcome: success|failed|timeout|quota_exhausted|rejected, summary, usage, resetAt, durationMs}`.
- `readQuota?()` is optional.
- Each adapter ships a `models.yaml`: tier → model, native effort and relative cost, plus a reverse map from model to tier.

### Invocations
Every adapter runs with cwd set to the worktree and receives the prompt on stdin under a "task data" header.

**claude:**
```
claude -p --safe-mode --output-format stream-json --verbose --no-session-persistence --model M --effort E --max-turns N --settings '<S>'
```
- read-only adds `--permission-mode dontAsk --tools Read,Grep,Glob`.
- worktree adds `--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write,Bash --disallowedTools Agent`.
- `<S>` denies Read on credential paths (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.dispatch`, `~/.ssh`, `~/.aws`, `.env*`) and enables the sandbox with `denyRead`. If the sandbox is unavailable, the run fails closed.
- Quota is read passively from `rate_limit_event`. The run is `quota_exhausted` when the event status is `rejected`, when `api_error_status` is 429, or when the "hit your … limit" text appears.

**codex:**
```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --disable hooks --disable plugins -C <wt> -m M -c model_reasoning_effort=E -o <run>/last.txt -s read-only|workspace-write -
```
- `probe` validates the feature names; an unknown one makes the run fail closed.
- Quota comes from the app-server.

**agy** (read-only only):
```
agy -p --output-format stream-json --mode plan --sandbox --disable-slash-commands --model M --effort E --print-timeout S
```
- Never uses `--dangerously-skip-permissions`.
- Off by default, with a ToS opt-in for consumer logins.

### Child isolation
- The child's environment is built from an allow-list only: `PATH HOME USER LANG LC_* TMPDIR SHELL TERM=dumb`, the instance's config-dir variable, its `envPassthrough`, plus `DISPATCH_DEPTH=n+1` and `DISPATCH_RUN_ID`.
- `run` refuses when `DISPATCH_DEPTH ≥ max_depth` (default 1), and every hook does nothing when `DISPATCH_DEPTH` is set.
- Binary resolution order: config `binary:` → PATH → `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, the npm prefix.

### Sandbox
- Worktrees live in `~/.dispatch/worktrees/<repo-hash>/<id>`.
- The base is HEAD, or a `git stash create` snapshot when the tree is dirty; the result is flagged in that case.
- `worktree.bootstrap: none|symlink-readonly`.
- Submodules, LFS and non-git directories force read-only.
- The patch is built with a temporary index and `diff --binary`.
- The filter rejects `..`, absolute paths, symlinks, `.git*`, `.dispatch/`, host config directories, `.env*` and pinned paths.
- The secret scan is best-effort; a hit sets `needs_review`.
- `git apply --check` runs against the current working tree.
- The result returns the patch path plus a diffstat, never the patch inline.
- `gc` reaps orphaned worktrees.
- Dispatch never applies patches, commits or opens PRs.

### Runner
- Flow: decide → lease (per-instance concurrency, kept in SQLite) → sandbox → adapter → patch → record.
- Fallback is ordered; once options run out, the task returns to the host with the reason.
- Fanout (second opinion) uses two worktrees, returns two results and merges nothing.
- Detach and supervisor:
  - setsid, and on stop a SIGTERM to the process group, then SIGKILL after 10 s
  - timeouts on a monotonic clock
  - a heartbeat every 5 s, with liveness judged by pid plus start time
  - idempotency key: a hash of session and tool input
- `wait <id> --timeout` exits 75 while the run is still going. Default timeouts per host: Claude 100 s, Codex 300 s (the spike confirms this), no limit when there is no host.

### Config
- Global file `~/.dispatch/config.yaml`: providers and instances, plans, autonomy, pools, concurrency, quota readers, `trusted_repos`.
- Repo files: `.dispatch/config.yaml`, `profiles/` and `mappings/`.
- Every file has a `version:` and migrations.
- Precedence for ordinary keys: flags > trusted repo > global > defaults.
- Security keys take the most restrictive of global, repo and flags. They are autonomy, env passthrough, allowed providers, pools, concurrency, `max_depth`, network, bootstrap, `keep_worktrees` and `binary`. Runs started from a hook or through the Codex rule are capped further.
- Trust:
  - the hash covers the relative path and bytes of every file in the policy set;
  - it is computed on the same buffer that gets parsed, so no swap can happen in between;
  - it is keyed by `realpath(git common dir)`;
  - a symlink inside `.dispatch/` aborts trust;
  - on a mismatch, repo policy is ignored and the user is told.

### Rules
- Fixed order: pins → direct mappings → profile rules → tier preset → default (`host`). The first match in each layer wins.
- Match fields: `{task_type, paths, tier, quota, reliability}`.
- Actions: `provider`, `host`, `fallback[]` (ordered or most_remaining), `fanout[]`, `reject`.
- Soft and hard thresholds act as filters. The host itself is never chosen.
- `unspecified_model` defaults to `balanced`.
- Pins are also enforced at patch time.
- Profiles shipped: balance, preserve, specialize, off.
- Mappings shipped: mirror, economy, custom; best-of-breed is a commented example.

### Quota
- Sources, in order:
  1. a real reading, cached for N minutes
  2. the estimator, which projects runs onto the plan's windows
  3. the `quota_exhausted` signal, which marks the provider unavailable until a time
- Every number carries a reliability: real, estimated, stale or unknown.
- An incoherent reading is marked stale.
- The host's own quota is only ever real or unknown, never estimated.
- `status --set` overrides a value until it expires.
- Routing never blocks for lack of quota data.

### Determinism and shadow mode
- Each decision stores its canonical `DecisionInput`, redacted.
- `explain --replay <id>` re-runs the router on that stored input.
- Shadow mode evaluates every profile on the same snapshot at decision time, and `status --compare` aggregates them, labelled "estimated".

### State
- Everything lives in `~/.dispatch/state/dispatch.db`: SQLite in WAL mode, `busy_timeout` 5000, with migrations, redaction before every write, and retention limits.
- The hook path never opens the database; it reads two atomically written JSON caches instead.

### Host integration

**`dispatch setup`** (once per user):
- runs the global wizard;
- writes the launcher `~/.dispatch/bin/dispatch`, which holds absolute node and cli paths;
- installs the host integrations;
- records what it wrote in `~/.dispatch/setup-manifest.json`.

**`dispatch install`** (per repo):
- writes `.dispatch/` and `.dispatch/.gitignore`, then asks for trust;
- the first time, it runs `setup` automatically.

**Removal:** `uninstall` removes the repo part, and `uninstall --global` removes the host integrations.

**Hook command.** It is silent when Dispatch is absent, and its budget is 80 ms or less:
```
[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x /abs/node ] && [ -f /abs/hook.mjs ] || exit 0; exec /abs/node /abs/hook.mjs <host> <event>
```

**Claude Code** (soft only):
- A user-scope plugin installed from a local marketplace (`claude plugin install dispatch@dispatch-local -s user`), containing:
  - `agents/dispatch.md`, which runs `dispatch run --detach`, then `wait`;
  - a SessionStart hook that injects the policy via `additionalContext` and records the session model.
- There is no auto-allow hook. Instead, `doctor` prints the `Bash(<abs>/dispatch run:*)` permission rule for the user to add.

**Codex:**
- A skill in `~/.agents/skills/dispatch/`.
- Entries in `~/.codex/hooks.json`, written with jsonc-parser: SessionStart, plus PreToolUse on `spawn_agent` for hard mode. The hard-mode strategy comes from the spike.
- `~/.codex/rules/dispatch.rules`:
  - names the absolute launcher path;
  - allows only the `run|wait|cancel|status` subcommands;
  - guards against compound commands, based on the spike's results;
  - caps runs per session and per day.
- `setup` presents the rule and the `/hooks` approval step as an explicit trust grant.
- `doctor` checks trust through a SessionStart heartbeat.

**Antigravity:** no host integration in v0.1. The docs explain how to call `dispatch run` manually from `agy`.

### Commands
- `setup [--refresh]`, `install`, `uninstall [--global]`, `trust`
- `doctor [--live] [--from-host]`
- `status [--compare] [--set]`, `use`, `profiles`, `explain [--replay]`, `validate`, `providers`
- `run [--detach] [--dry-run] [--json] [--provider] [--tier] [--effort]`, `wait`, `cancel`
- `logs [--follow] [--task]`, `gc`

Exit codes: 0 ok, 2 usage, 3 rejected, 4 failed, 5 quota, 6 timeout or state error, 75 still running.

### Release
- A single semver version in the 0.x range with a hand-written CHANGELOG. Each adapter declares the CLI range it supports (`cliRange`).
- CI runs on macOS and Ubuntu with Node 22 and 24.
- Tagging `v0.1.0` publishes to npm with provenance, behind a manual-approval environment.

---

## 3. Test strategy

### Pyramid
- vitest covers unit, contract, integration and end-to-end tests that use fake CLIs; live tests are opt-in.
- Test names carry tags `[UCn]`, `[ACn]` and `[SEC-x]`.
- Coverage: 95% on router, config, the patch filter and redaction; 85% overall.
- Snapshot tests for `explain` output.
- fast-check properties on the router:
  - determinism;
  - never routes to the host itself;
  - a pin always wins;
  - when every provider is below its hard limit, the result is host or reject;
  - replay reproduces the decision.

### Fake CLIs (`test/fakes`)
- Shims for `claude`, `codex` and `agy` sit first on PATH and replay real recorded fixtures. Fixtures for all three CLIs now exist; only the quota-exhausted and crash cases are synthetic.
- Scenarios are selected per call index: success_edit, slow, quota_exhausted, malformed, crash, hang_ignore_term, recurse, escape_writes, symlink, leak_secret.
- A fake codex app-server returns: ok, changed format, always zero, garbage, hang, and responses with notifications interleaved.
- A fake `agy /usage`.
- `FAKE_LOG` records argv, env, cwd and process group id for assertions.
- A global guard fails the run if a real CLI gets resolved.

### Contract tests
- Parsers run over fixtures stored per CLI version.
- `doctor` warns when the installed CLI version has no fixtures.
- `scripts/record-fixtures` is opt-in and sanitizes what it records.

### Host tests (temporary HOME and repo)
- Repo `install` then `uninstall` leaves `git status` empty and the same tree hash (AC2).
- `setup` then `uninstall --global` leaves `~/.codex/hooks.json` byte-identical, including JSONC files that hold user entries and comments.
- For Claude, a fake `claude plugin` logs its argv, and the test confirms Dispatch writes nothing under `~/.claude`.
- The hook command runs under `env -i PATH=/usr/bin:/bin`, which simulates a host launched from the GUI. It must be silent when Dispatch is absent (UC9, AC5) and work when it is present.
- A p95 latency budget for the hook.

### Security suite (WP28)
- SEC-flags: no flag combination loosens a setting beyond the global config.
- SEC-trust: a file swapped between hashing and parsing, a file added or renamed, access through a symlink or a separate worktree.
- SEC-rules: a table of compound commands that must never match the Codex rule.
- SEC-hookpath.
- SEC-claude-cred: golden argv for the child, plus a live canary Read that must be denied.
- SEC-agy-ro.
- Env canaries: the child receives only allow-listed variables.
- Redaction canaries: zero hits in state, stdout or logs.
- The recursion guard.
- Credential canaries plus an fs-trace preload, to prove Dispatch never opens a credential path (AC7).

### Use cases

| UC | Automated test (with fakes) | Live part |
|---|---|---|
| UC1 | `setup`/`install --non-interactive` with an answers file: only `.dispatch/` in the diff, `doctor` passes, `status` lists 3 providers | `docs/manual-tests/UC1.md` |
| UC2 | Hook I/O fixtures, then `run` with `CLAUDECODE=1` and the preserve profile: picks codex, produces a patch, logs the winning rule, updates the codex estimate, makes zero `claude -p` calls | Semi-live: real `claude` as host, fake codex |
| UC3 | `[UC3-A]` deny+detach (idempotent; `wait`; `gc`) and `[UC3-B]` `updatedInput` proxy. The spike decides which one is required | `UC3.md` |
| UC4 | Codex below its hard limit → agy (read-only task) → quota_exhausted → back to host. Three decisions are logged and `status` shows both providers unavailable | – |
| UC5 | A pin wins in `explain` under every profile; property test; rejection at patch time | – |
| UC6 | `explain` snapshots for `balanced` and `inherit`; `decided_without` is logged | – |
| UC7 | Two worktrees, two results each tagged with its provider, working copy untouched | – |
| UC8 | `status --compare` on a seeded set of recorded decisions; output follows the data; an empty log prints "no data"; nothing executes | – |
| UC9 | Hook guard with an empty HOME and a minimal PATH | – |
| UC10 | A Python subprocess with no host env gets valid JSON, and self = none | – |
| UC11 | App-server returns a changed format, always zero, or hangs: `doctor` flags it, `status` shows stale, routing continues. Also with every reader disabled (AC4) | – |
| UC12 | A `claude-alt` instance with its own `CLAUDE_CONFIG_DIR`; self-exclusion works in both directions | `UC12.md` |
| UC13 | Timeout → partial patch. An unkillable child group is fully killed. A conflict gives `failed` with the diff. The working-copy hash is unchanged | – |
| UC14 | Repo and `--global` round trips | – |

### `doctor` as the live smoke test
Plain `doctor` spends no quota. It checks:
- binaries and their resolved paths;
- `codex login status`;
- `agy /usage`, which also proves auth;
- flag probes;
- `codex debug models` and `agy models`;
- reader health;
- hook trust;
- stale launcher paths;
- a sandbox probe from inside the host.

`doctor --live` runs one tiny task per provider other than the host. After each merge I run `doctor` and `doctor --live --provider claude,codex`.

### CI
- Jobs: lint, typecheck, a test matrix of {ubuntu, macos} × {22, 24}, coverage, pack-smoke, acceptance, and a guard job.
- pack-smoke runs `pnpm pack`, a global install, and an end-to-end run with fakes.
- No secrets in CI, no real CLIs, no `pull_request_target`.
- `scripts/acceptance` prints a pass/fail table by tag. STATUS.md is maintained by hand.

---

## 4. Work packages (one branch and one PR each)

Tier: Str = strong, Std = standard, Light = light. Size: S, M, L.

| WP | Title | Deps | UC/AC | Tier/Size |
|---|---|---|---|---|
| WP0 | Bootstrap, CI, core contracts (`src/core/contracts.ts`: Task, DecisionInput, Decision, QuotaSnapshot, RunResult v1, ports, exit codes), test stubs, router lint | – | all | Str/M |
| WP1 | Live spike and contract freeze. Probes: codex workspace-write edit; how rules match compound commands; codex hard mode (deny+detach vs `updatedInput` proxy); Claude `denyRead` and credential deny; agy `--mode plan`; hook PATH when the host is launched from the GUI; the SessionStart model field. Records fixtures, then freezes the Adapter, HostIntegration and EditOp contracts | WP0 | UC2, UC3, UC12 | Str/S |
| WP2 | Fake CLI harness, plus a temporary HOME/repo kit | WP0 | AC1 | Std/M |
| WP3 | Launcher, build entries, binary resolution, platform gate | WP0 | UC1, UC10 | Std/S |
| WP4 | Config: schema, versions, layering, tighten-only, trust | WP0 | UC5, UC6, UC12, AC3 | Std/L |
| WP5 | Router and explain (pure), with properties | WP0 | UC4–7, UC12, AC3 | Str/L |
| WP6 | State store: SQLite, migrations, redaction, leases, idempotency | WP0 | AC3, AC7 | Std/M |
| WP7 | Worktree sandbox: snapshot, bootstrap, read-only downgrade, gc | WP0 | UC13 | Std/M |
| WP8 | Host prototype on the real CLIs: Claude plugin, codex hooks, rules and skill, tool timeouts, what the host sandbox can write | WP0, WP1 | UC2, UC3, UC9 | Str/S |
| WP9 | `validate`, presets, model tables | WP4 | UC5, UC6 | Light/M |
| WP10 | Shadow decisions and the compare aggregator | WP5, WP6 | UC8 | Std/M |
| WP11 | Quota core: snapshot, estimator, reliability, override | WP6 | UC4, UC11, AC4 | Std/M |
| WP12 | Patch pipeline: filter, secret scan, apply-check | WP7 | UC13, AC7 | Str/M |
| WP13 | Process supervisor: process groups, monotonic timeouts, env allow-list, depth | WP0, WP2 | UC13, AC7 | Str/M |
| WP14 | Claude adapter | WP1, WP2, WP3 | UC2, UC12 | Str/M |
| WP15 | Codex adapter | WP1, WP2, WP3 | UC2, UC4 | Str/M |
| WP16 | Antigravity adapter (read-only, experimental) | WP1, WP2, WP3 | UC4 | Std/S |
| WP17 | Setup framework: manifest, jsonc edits, hook entry, `doctorChecks` registry, `uninstall --global` | WP1, WP3, WP4, WP8 | UC1, UC9, UC14, AC2, AC5 | Str/L |
| WP18 | Quota readers: Claude (passive), codex (app-server), agy (`/usage`) | WP11, WP1, WP2 | UC11, AC7 | Std/M |
| WP19 | Runner core: single run plus ordered fallback | WP5, WP6, WP11, WP12, WP13, WP1 | UC4, UC10, UC13, AC4 | Str/M |
| WP20 | CLI read commands: explain/replay, validate, use, profiles, providers, trust, `--dry-run` | WP4, WP5, WP9, WP11 | UC5, UC6, AC3 | Std/M |
| WP21 | Repo install/uninstall | WP4, WP9 | UC1, UC14, AC2 | Std/S |
| WP22 | Claude Code host (soft, as a plugin) | WP17, WP8 | UC1, UC2, UC9, UC12 | Std/M |
| WP23 | Runner multi: fanout, concurrency, detach/wait/cancel, idempotency | WP19 | UC7, UC3 | Str/M |
| WP24 | CLI `run --json` (RunResult schema) | WP19, WP20 | UC2, UC10 | Std/S |
| WP25 | CLI `status` (`--set`, `--compare`), `logs`, `gc` | WP6, WP7, WP10, WP11 | UC4, UC8, UC11 | Light/S |
| WP26 | `doctor` core and `--live` | WP3, WP14–16, WP17, WP18 | UC1, UC11 | Std/M |
| WP27 | Codex host: skill, hooks, rules, hard mode | WP17, WP8, WP23, WP24 | UC3 | Str/M |
| WP28 | Security suite and threat model | WP4, WP12–15, WP17, WP19 | AC5, AC7 | Str/M |
| WP29 | Acceptance end-to-end tests UC1–14, manual test scripts, STATUS table | all code WPs | AC1 | Std/M |
| WP30 | Docs: README (five-minute setup plus billing/ToS disclosure), config reference generated from the schema, adapter guide, host-integration guide | WP20 and later | AC6 | Std/M |
| WP31 | Release v0.1.0 | WP29, WP30 | – | Light/S |

**Waves.**

| Wave | Packages |
|---|---|
| W0 | WP0, WP1 (investigation starts right away) |
| W1 | WP2–WP8 |
| W2 | WP9–WP17 |
| W3 | WP18–WP22, and WP30 starts |
| W4 | WP23–WP26 |
| W5 | WP27, WP28 |
| W6 | WP29, WP30 |
| W7 | WP31 |

**Critical path:** WP0 → WP2 → WP13 → WP19 → WP23 → WP27 → WP29 → WP31.

**Rules for the waves.**
- Adapter and host packages can be developed against the provisional contracts, but they merge only after the WP1 freeze.
- Model and effort per package: see the next section.

### Model and effort per package (development sub-agents)
Only two profiles are used: **Opus 5.5 at medium effort** and **Sonnet 5.5 at high effort**.

How packages are assigned:
- **Opus medium** goes where a design mistake would spread or open a security hole: frozen contracts, router, trust, adapters for the two main CLIs, patch filter, orchestration, host setup, security suite. It is never used for size-S work that is already well specified.
- **Sonnet high** gets everything that is well specified by the plan, the contracts and the tests: CRUD/state, fakes, CLI wiring, presets, docs, release.

| Profile | Packages | Count |
|---|---|---|
| **Opus 5.5 · medium** | WP0 contracts, WP1 spike + freeze, WP4 config/trust, WP5 router, WP12 patch pipeline, WP14 Claude adapter, WP15 Codex adapter, WP17 setup framework, WP19 runner core, WP23 runner multi/detach, WP27 Codex host, WP28 security suite | 12 |
| **Sonnet 5.5 · high** | WP2 fakes, WP3 launcher, WP6 state, WP7 worktree, WP8 host prototype, WP9 presets/validate, WP10 shadow, WP11 quota core, WP13 supervisor, WP16 agy adapter, WP18 quota readers, WP20 CLI read, WP21 repo install, WP22 Claude host, WP24 CLI run, WP25 status/logs/gc, WP26 doctor, WP29 acceptance, WP30 docs, WP31 release | 20 |

Two Str-tier packages go to Sonnet high, and the reasons:
- **WP13 supervisor:** the behaviour is fully pinned by the fake scenarios (hang_ignore_term, pgid).
- **WP8 host prototype:** size S, throwaway code; the findings it produces matter more than the code.

Token-saving rules:
- **Briefs.** Each sub-agent gets a short brief: the WP row, the relevant plan section, the contract files, and the tests to write. It never gets research dumps.
- **Escalation.** A Sonnet package is re-run on Opus medium only after two failed attempts, meaning CI red or rejected in my review. Any escalation is recorded in STATUS.md.
- **Reviews.** Done by me, the lead, in this session, on the diff only; no review sub-agents.
- **Shared fixtures.** Recorded fixtures and the fake harness are reused, so no agent spends live quota except in WP1, WP8 and `doctor --live`.

**Traceability.** Every UC1–14 and AC1–7 maps to at least one package in the table above. WP29 owns every final end-to-end test, except AC6 (WP30) and AC5 and AC7 (WP28).

---

## 5. Phase 2 execution rules
1. Each WP gets its own branch `wp<N>-<slug>` and worktree, worked by one sub-agent. Its PR description lists the UCs and ACs it covers and how they were tested.
2. A dependent WP starts only after its dependencies are merged with green CI.
3. I review every PR, then run the full suite and `dispatch doctor` locally before merging.
4. After each merge, I update `STATUS.md`:
   - packages done;
   - the §12 risk table with each risk's current state;
   - deviations taken;
   - the acceptance table.
5. Live quota is used only in WP1, WP8, `doctor --live` and the manual UC scripts, always with tiny prompts.
6. Live agy calls are limited to the quota-free probes, plus at most one tiny run per `doctor --live`, out of caution about the ToS.
7. Before WP0, PRs and CI need a GitHub remote, and the repo has none yet. I'll check `gh repo view` first and ask you before creating one.
8. At the end: the README, the config reference, the two guides, the `v0.1.0` tag, and a final report. Publishing to npm needs your go-ahead.

---

## 6. Open risks (the §12 table, plus new ones)

| Risk | State after planning | Mitigation |
|---|---|---|
| Quota channels change or disappear | Lower: Codex is official, Claude is passive and official, agy uses an official CLI command | Versioned readers, `stale` state, estimator, the AC4 test |
| No hard interception in Claude Code | Changed: PreToolUse on `Agent` now exists. v0.1 stays soft, as the spec says | Revisit in v0.2 |
| Codex `SubagentStart` can't redirect | Confirmed: it can't | PreToolUse on `spawn_agent` (deny+detach or proxy); the spike picks |
| Antigravity streaming and hooks unverified | Technically resolved, but the ToS blocks consumer plans | Experimental, opt-in, read-only, no host integration |
| Billing or OAuth rules change | Active: Claude fan-out is a grey area, and Google forbids wrapping | `pool` field shown in `status`, README disclosure, no technical workarounds |
| Prompt injection | Open; inherent to the product | Native sandboxes, credential read denies, patch filter, external summaries marked and length-capped, no auto-apply |
| **New:** the Codex rules file can be used to escape the sandbox | Accepted as a trust grant | Absolute path, subcommand allow-list, compound-command tests, caps, flags can only tighten |
| **New:** Codex hooks need manual trust in `/hooks` | Open | Setup instructions; `doctor` checks for the heartbeat |
| **New:** host tool timeouts or the host sandbox block `run` | Mitigated | Detach plus `wait` with per-host timeouts; `doctor --from-host` |
| **New:** CLIs change under us (agy auto-updates, Codex removes flags) | Open | `cliRange`, probe gating, fail closed, fixtures per version |
| **New:** the worktree lacks dependencies or uncommitted changes | Mitigated | Snapshot base, bootstrap policy, a "deps absent" flag in the result |
| **New:** `node:sqlite` is still experimental | Low | `DbPort` interface; the warning is suppressed |

---

## 7. Deviations from the spec (each is also recorded in STATUS.md)
1. **Claude quota reader.** The undocumented OAuth quota endpoint is dropped because it violates §2.2. Official channels are used instead.
2. **No edits to AGENTS.md, CLAUDE.md or `.claude/settings.json`.** Integration lives at user scope only: the Claude plugin, and the Codex skill, hooks and rules. This resolves the contradiction between §2.3 and §5/§10, and meets §2.4 and UC9.
3. **UC1 and UC14.** The repo diff contains only `.dispatch/`; host changes live at user scope.
4. **Install and uninstall.** The spec's single install/uninstall becomes `setup` (once per user), `install` (per repo) and `uninstall [--global]`.
5. **Antigravity as a target** is experimental, off by default and read-only, with a ToS opt-in. There is no agy host integration, and its config paths are corrected to the verified ones.
6. **UC3 wording changes.** Either the native spawn is denied and the result arrives through `dispatch wait`, or the spawn is rewritten into a minimal proxy sub-agent. The spike decides which.
7. **New Codex host file.** `~/.codex/rules/dispatch.rules` is added to the files Dispatch writes. It is a new file, but it is a trust grant.
8. **Config precedence.** §10's "repo overrides global" is reversed for security keys, which are global-only and tighten-only, including against flags. Repo policy requires a hash-bound `dispatch trust`.
9. **No `.dispatch/hooks/` scripts.** Hooks are inline guards with absolute paths, because scripts in the repo would be an execution vector.
10. **Worktree location and patch check.** Worktrees live in `~/.dispatch/worktrees`, not `.dispatch/state`. The patch is checked against the current tree, not the origin branch (§9.6).
11. **Isolation boundary.** The boundary is each CLI's native sandbox, not the worktree. Without that sandbox, Dispatch fails closed; paths are also filtered at patch time.
12. **`reserve_for_host` and `unspecified_model`.** `reserve_for_host` is dropped because it can't be satisfied. `unspecified_model` defaults to `balanced`, not `inherit`, because the session model often can't be observed.
13. **Command set.** Added `setup`, `trust`, `wait`, `cancel` and `gc`. `watch` is replaced by `logs --follow`, and `status --history` is dropped.
14. **UC8 semantics.** Shadow mode recomputes decisions on real recorded snapshots; consumption figures are labelled "estimated".
15. **State storage** uses SQLite.
16. **Windows** is unsupported in v0.1.
17. **`doctor` spends no quota by default.** The live task runs only with `--live`.

## 8. Definition of done
- Every WP is merged with green CI.
- `scripts/acceptance` shows UC1–14 and AC1–7 passing, or marked manual and documented.
- `dispatch doctor` and `doctor --live` pass on this machine.
- `install` + `uninstall` leave an empty repo diff.
- `setup` + `uninstall --global` leave the Codex host files byte-identical.
- STATUS.md and the final report are written.
- `v0.1.0` is tagged.
