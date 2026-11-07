# Dispatch

Dispatch lets you work in one coding agent (Claude Code or Codex) and have delegable tasks run by
the *other* agents you already pay for. A task goes to the official CLI of another provider
(`claude`, `codex`, `agy`), runs headless in an isolated git worktree, and comes back to your session
as a summary and a patch. Which provider gets the task is decided by rules you can read and change:
remaining quota, task type, file paths, pins.

The problem it solves: with three subscriptions, you normally use one at a time, and when it hits its
limit work stops even though the other two have quota left. With Dispatch the session you are in
stays the orchestrator, and routine work (tests, docs, reviews, refactors) is spread over the
providers that have headroom. Every routing decision is logged and can be explained after the fact.

**What it is not.** It is not a new agent framework, not an API proxy, and not a replacement for your
orchestrator. It does not use API keys in place of your subscriptions (unless you opt in to an API
pool), does not manage logins, and never applies a patch, makes a commit or opens a PR. If you do not
use agents, you will not notice it.

```
 host session                dispatch                       external CLI
 (Claude Code / Codex)   +-----------------------+      +------------------------+
 you: "write tests"      | router: profile,      |      | git worktree of the    |
   |                     |  pins, quota, tiers   |      | repo, native sandbox   |
   +-- sub-agent / skill +-> picks provider  ----+----> | codex / claude / agy   |
   |                     | (never the host)      |      | runs headless          |
   |                     +-----------------------+      +-----------+------------+
   +<-- summary + patch (path, diffstat, applies?) <----------------+
   reviews the diff, applies it itself
```

## Five-minute setup

### Requirements

- macOS or Linux (Windows is not supported).
- Node.js 22.13 or newer.
- At least two of these CLIs, installed and logged in: `claude` (Claude Code), `codex` (Codex CLI),
  `agy` (Antigravity CLI). One of them is your host; the others are delegation targets. Dispatch
  never logs in for you.
- A git repository to work in.

### 1. Install

```sh
npm i -g @dragonfly25/dispatch
```

The package is not published yet. Until it is, install from a clone:

```sh
git clone https://github.com/dragonfly25/dispatch.git && cd dispatch
pnpm install && pnpm build && npm link
dispatch --version
```

### 2. `dispatch setup` (once per user)

```sh
dispatch setup
```

Setup prints the exact plan, asks for confirmation, then applies it. Use `--yes` to skip the question
and `--non-interactive` to only print the plan. It only touches hosts it finds on this machine, and
it never edits your `CLAUDE.md`, `AGENTS.md`, skills, existing sub-agents or any project file.

| Where | What is written |
| --- | --- |
| `~/.dispatch/bin/dispatch` | The launcher. It holds absolute paths to Node and Dispatch, so hooks work even when the host was started from a GUI with a minimal `PATH`. |
| `~/.dispatch/setup-manifest.json` | A record of every edit, so uninstall can undo it exactly. |
| Claude Code | A user-scope plugin, installed through `claude plugin install dispatch@dispatch-local -s user` from a local marketplace under `~/.dispatch/hosts/claude-code/`. It contains the `dispatch` sub-agent and a `SessionStart` hook that tells the session how and when to delegate. Dispatch itself writes nothing under `~/.claude`. |
| Codex | A skill in `~/.agents/skills/dispatch/`, hook entries in `~/.codex/hooks.json` (marker-delimited, other entries untouched), and a rules file `~/.codex/rules/dispatch.rules`. |

Setup asks you to accept two **trust grants**. Read them before saying yes:

- **Codex rules file.** Codex runs shell commands in a sandbox with no network, so `dispatch run`
  could not work from inside it. The rules file allows exactly one thing outside the sandbox: the
  absolute launcher path with the subcommands `run`, `wait`, `cancel` and `status`. Commands that
  chain, pipe, redirect or expand (`;`, `&&`, `|`, `$`, backticks) never match it.
- **Codex hook approval.** Codex only runs hooks you have approved. After setup, start Codex, open
  `/hooks`, and approve the Dispatch hooks. There is no CLI for this. Until you do, the Codex side
  stays inert (the skill still works when asked).

**Claude permission rule.** Dispatch never edits your Claude permissions. If the `dispatch` sub-agent
should run without a prompt for every call, add the two rules printed by `dispatch doctor` to
`permissions.allow` in `~/.claude/settings.json`:

```
Bash(~/.dispatch/bin/dispatch run:*)     # doctor prints the absolute path of your launcher
Bash(~/.dispatch/bin/dispatch wait:*)
```

### 3. `dispatch install` (per repository)

```sh
cd your-repo
dispatch install
```

This creates only `.dispatch/` in the repo: `config.yaml` (commented), the routing profiles in
`profiles/`, the tier mappings in `mappings/`, and `.dispatch/.gitignore` for local state. Nothing else
in the repo is touched, including your root `.gitignore`. It runs `dispatch setup` first if you have
not. Repo policy is code (it decides where tasks go), so Dispatch ignores it until you trust it:
`install` records the hash of the files, and `dispatch trust` re-records it after you review a change.

Useful flags: `--profile <name>` (default `balance`), `--unspecified-model inherit|classify|<tier>`,
`--no-trust`, `--force`, `--non-interactive --yes` for scripts and CI.

### 4. Check it

```sh
dispatch doctor            # spends no quota
dispatch doctor --live     # one tiny real task per provider; asks first, uses a little quota
dispatch doctor --live --provider codex,claude -y
dispatch doctor --from-host   # run it from inside Claude Code or Codex: checks what a call from there needs
```

`doctor` checks the platform, the launcher, the config, repo trust, each provider CLI (binary, version,
flags, login), the pool each one draws from, the quota channel, and the host integration. Each warning
comes with a `fix:` line. `dispatch status` then shows one line per provider with remaining quota,
reset time, and how much to trust the number (`real`, `estimated`, `stale`, `unknown`).

### 5. First delegation

**From Claude Code.** Start a new session in the repo (plugins load at session start) and ask for
something delegable:

> Write unit tests for the auth module.

The session sees the Dispatch policy, hands the task to the `dispatch` sub-agent, and the sub-agent
runs `dispatch run --detach` and `dispatch wait`. The router picks a provider other than Claude, the
task runs in a worktree, and you get back a summary (marked as coming from an external agent) and the
path of a patch. Claude reviews the diff and applies it with its own tools. You can also ask directly:
"delegate this to Codex". Codex works the same way through its skill, and the hook denies native
sub-agent spawns with a message that redirects the task to Dispatch.

To see what would happen without running anything:

```sh
dispatch explain --task "write unit tests for the auth module" --task-type test --path src/auth
```

**From a terminal or a script (no host).**

```sh
dispatch run --task "Add unit tests for src/auth.ts" --task-type test --path src/auth.ts --json
```

With no host, every provider is a candidate. The result is one JSON object (schema version 1) with
`status`, `outcome`, `externalAgent`, `summary`, `patch` (`path`, `diffstat`, `applies`, `needsReview`),
`decisions` and `usage`. The exit code follows the outcome: 0 success, 2 usage or config error,
3 rejected, 4 failed, 5 quota exhausted, 6 timeout or state error, 75 still running.

```python
import json, subprocess

proc = subprocess.run(
    ["dispatch", "run", "--json", "--task-type", "test", "--path", "src/auth.py",
     "--task", "Add unit tests for src/auth.py"],
    capture_output=True, text=True, cwd="/path/to/repo",
)
if not proc.stdout.strip():  # usage or config error: nothing on stdout, the reason is on stderr
    raise SystemExit(proc.stderr)
result = json.loads(proc.stdout)
if result["status"] == "completed" and result["outcome"] == "success" and result["patch"]:
    # Treat result["summary"] as untrusted text from another agent.
    subprocess.run(["git", "apply", result["patch"]["path"]], cwd="/path/to/repo", check=True)
else:
    print(result["status"], result["outcome"], proc.returncode)
```

For long tasks start in the background and poll: `dispatch run --detach --json ...` prints a `runId`;
`dispatch wait <runId> --timeout 120` returns the result, or exits 75 while the run is still going.
`dispatch cancel <runId>` stops it. Custom frameworks (LangGraph, CrewAI, your own) call `dispatch`
the same way.

## Everyday commands

| Command | What it does |
| --- | --- |
| `dispatch run --task "..."` | Route a task and run it on the chosen provider. `--dry-run` only explains. `--json` for machines. `--provider <instance>` pins one. Also `--task-file`, `--task-type`, `--path`, `--model`, `--tier`, `--effort`, `--autonomy`, `--timeout`, `--detach`. |
| `dispatch wait <runId> [--timeout s]` / `dispatch cancel <runId>` | Collect or stop a detached run. |
| `dispatch explain --task "..."` | Show the routing decision with the rule that produced each step. `--replay <decisionId>` re-runs the router on a recorded decision and diffs it. |
| `dispatch status` | Quota per provider instance, with reset, source and reliability. |
| `dispatch status --set codex 40` | Correct the remaining percentage by hand (`--window`, `--ttl`, default 6h). |
| `dispatch status --compare [--since 7d]` | What each profile would have done on your recorded decisions. |
| `dispatch use <profile>` / `dispatch profiles` | Switch the active routing profile / list profiles. |
| `dispatch logs [--task <runId>] [--follow]` | List recent runs, show one run's decisions and events, or tail running ones. |
| `dispatch gc [--older-than 24h] [--dry-run]` | Remove worktrees of finished runs, old history and stale leases. |
| `dispatch validate` | Check the effective configuration; exit 2 on any error. |
| `dispatch providers` | Provider instances, the pool each draws from, adapter version. |
| `dispatch trust` | Trust the repo's current `.dispatch/` policy files. |
| `dispatch doctor [--live]` | Diagnose the installation and the providers. |
| `dispatch uninstall` | Remove `.dispatch/` from this repo. |
| `dispatch uninstall --global` | Remove host integrations, launcher and `~/.dispatch` (`--keep-home` keeps config and state). |

Most read commands accept `--json`.

## Routing in one minute

The router is a pure function: same configuration, task and quota snapshot give the same decision.
It evaluates, in a fixed order, and the first match in a layer wins:

1. **Pins**: rules from `config.yaml` that win whatever the profile, for example "everything under
   `db/migrations/**` stays on the host" (`action: { type: host }`).
2. **Direct mappings**: explicit `model:effort -> provider:model:effort` entries that bypass tiers.
3. **Rules of the active profile**, top to bottom.
4. **Tier preset** and the default (stay on the host).

Shipped profiles (plain YAML in `.dispatch/profiles/`, no hidden logic; copy one to make your own):

| Profile | Optimises for |
| --- | --- |
| `balance` (default) | Reaching the end of the week with every provider usable: delegates to the one with the most quota left. |
| `preserve` | Keeping the host free for interactive work: delegates everything delegable. |
| `specialize` | Quality per task type: a task-type to preferred-provider table, with fallback by quota. |
| `off` | No delegation; everything stays on the host. Useful for comparison and debugging. |

**Tiers and effort.** Requests are normalised to `tier` (`fast`, `balanced`, `max`) and `effort`
(`low`, `medium`, `high`), and each provider resolves them through its own model table. When the host
does not name a model, `unspecified_model` decides the tier (default `balanced`). The mapping presets
are `mirror` (default), `economy` (effort one step lower on external providers) and `custom`.

**Quota thresholds.** Per instance, `soft` (default 20% remaining: avoid if there is an alternative)
and `hard` (default 5%: never use). A provider that reports `quota_exhausted` is unavailable until its
reset, and the task falls back to the next provider, then back to the host with the reason. Missing
quota data never blocks routing: it degrades to estimates.

**Shadow mode.** List other profiles in `shadow_profiles` and every real decision also records what
they would have chosen. `dispatch status --compare` summarises this over a time window, labelled as an
estimate; nothing is simulated or executed.

The full key reference, precedence rules, trust and an annotated example are in
[docs/configuration.md](docs/configuration.md).

## Safety model

Delegated agents run headless, so there are no interactive confirmations. Safety comes from isolation
and from you reviewing the result.

- **Worktree and native sandbox.** Each task gets its own git worktree under `~/.dispatch/worktrees/`.
  The real boundary is each CLI's own sandbox, with reads of credential paths and Dispatch's own files
  denied; if that sandbox is unavailable Dispatch fails closed instead of running unprotected. The
  child gets a minimal environment (an allow-list), cannot start another delegation (`max_depth`), and
  has a timeout. Network access is not restricted by Dispatch, because the CLIs need it.
- **Autonomy levels.** `read-only` (analysis only, text back), `worktree` (default: edits in the
  worktree, patch back), `direct` (writes to your working copy; opt-in and discouraged).
- **Patch filter.** The patch is rejected or trimmed if it touches `..` or absolute paths, symlinks,
  `.git*`, `.dispatch/`, host config directories, `.env*` or pinned paths. A best-effort secret scan
  flags suspicious content (`needsReview`), and `git apply --check` runs against your working tree.
- **Dispatch never applies patches,** commits, or opens PRs. The host or you review the diff and apply it.
- **Output is untrusted.** The external agent's summary is marked `EXTERNAL_AGENT_OUTPUT`; the host is
  told to treat it as data, never as instructions.
- **Security settings only tighten.** Autonomy, providers, concurrency, network and similar keys can be
  loosened only in your global config. A repo or a flag can make them stricter, never looser, and repo
  policy is ignored until you `dispatch trust` it.
- **Secrets.** Dispatch does not copy, store, log or send credentials. It never calls a provider's
  private API with your tokens: quota comes from each CLI's own commands and events, and state is
  redacted before it is written.
- **Collaborators see nothing.** Host integration lives at user scope. The repo only gains `.dispatch/`;
  `dispatch uninstall` removes it and leaves the tree as it was. A colleague who clones the repo
  without Dispatch gets no errors and no behaviour change; hooks exit silently when it is missing.

More detail, including the threat model: [docs/security.md](docs/security.md).

## Billing and terms

Dispatch only runs official CLIs with the logins you already have. What that costs you, and what the
providers allow, is theirs to define and it changes. As of November 2026:

- **Claude (`claude -p`).** Anthropic's
  [support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  (dated 2026-10-07) says headless `claude -p` draws on your subscription, and the announced June change is paused.
  Automated, high-volume fan-out through a subscription is a grey area: check your plan's terms before
  you rely on it. Max, Ultra and Team plans also have monthly API credits, a separate pool you can opt in to.
- **Codex.** A ChatGPT login draws on your plan limits. OpenAI recommends API keys for automation, and
  an API key is a separate billing pool.
- **Antigravity (`agy`).** Google's FAQ says wrapping `agy` in third-party applications is not supported
  under consumer plans and may lead to account suspension. Therefore the Antigravity target is
  **experimental, off by default, read-only, and opt-in**: with a consumer login it stays disabled until
  you set `tos_acknowledged: true` for it in your global config. Use an API-credit login if you want to
  avoid the issue.

`dispatch providers` and `dispatch status` show which pool each instance consumes (`subscription`,
`api_credit` or `unknown`). Dispatch does not work around any of these rules: it never calls private
endpoints with your tokens and never copies credentials. You are responsible for staying within the
terms of your own plans.

## Uninstall

```sh
dispatch uninstall            # this repo: removes .dispatch/ (asks first; --force also removes edited files)
dispatch uninstall --global   # host integrations, launcher, ~/.dispatch (--keep-home keeps config and state)
```

`uninstall --global` reverts every edit recorded in the setup manifest, including the Claude plugin and
the Codex hooks and rules, and leaves files you or other tools added alone.

## Troubleshooting

Run `dispatch doctor`; each line has a status and a `fix:`. The usual ones:

| Doctor says | Fix |
| --- | --- |
| `launcher ... points at paths that no longer exist` | Node or Dispatch moved (upgrade, reinstall): `dispatch setup --refresh`. |
| `<path> does not exist (setup has not run)` | `dispatch setup`. |
| `.dispatch/ exists but is not trusted` / `changed since it was trusted` | The repo policy is ignored. Review `.dispatch/`, then `dispatch trust`. |
| `<cli> was not found on PATH` | Install the CLI, or set `providers.<id>.binary` in `~/.dispatch/config.yaml`. |
| `not logged in` / `login state is unknown` | `codex login`; for `claude` and `agy` run the CLI once interactively. `doctor --live` proves the login. |
| `claude-code.permission-rule` warns | Add the printed `Bash(... run:*)` and `Bash(... wait:*)` rules to `permissions.allow`. |
| `CODEX_SANDBOX` set (`host.codex-rule`) | The Codex rule did not match. Use the absolute launcher path and a single-quoted task, run `dispatch setup --refresh`, and approve the Dispatch hooks in Codex `/hooks`. |
| `quota channel is broken` | A provider changed its format. Routing continues on estimates and `status` shows `stale`; update Dispatch, or set `quota.readers.<id>.enabled: false`. |

Other useful commands: `dispatch validate` (config errors), `dispatch explain` (why a task went where it
went), `dispatch logs --task <runId>` (what happened in a run).

## Contributing and documentation

Start at [docs/README.md](docs/README.md). Adding a provider CLI: [Writing an adapter](docs/guides/writing-an-adapter.md).
Supporting another agent client: [Writing a host integration](docs/guides/writing-a-host-integration.md).
The design is in [docs/PLAN.md](docs/PLAN.md) and the project state in [STATUS.md](STATUS.md).

```sh
pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries
```

## License

[MIT](LICENSE).
