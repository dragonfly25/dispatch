# Setup and install reference

The [Quick start](../README.md#quick-start) covers the happy path. This page has the details:
what `dispatch setup` asks and writes, the trust grants it requests, the Claude permission rule,
the flags of `dispatch install`, and what `dispatch doctor` checks.

## `dispatch setup` (once per user)

```sh
dispatch setup
```

Setup asks four questions, because they are the only things it cannot find out by itself:

1. the client you mainly use (Claude Code, Codex, or no preference);
2. the plan of each provider it found (for example `max5x` or `pro` for Claude, `plus` for Codex;
   "unknown" is fine and skips it), which feeds the quota estimates;
3. your starting strategy (`balance`, `preserve` or `specialize`);
4. the autonomy ceiling for delegated agents (`read-only`, `worktree`, `direct`; `worktree` is the default); `direct` is not implemented in v0.1 and adapters refuse it).

Antigravity stays off unless you opt in: setup shows Google's terms and enables it only if you type
"yes" and `agy` is installed (see [Billing and terms](../README.md#billing-and-terms)). Setup then prints
the exact plan of files it will write, asks for confirmation, applies it, and writes a commented
`~/.dispatch/config.yaml` with your answers. Re-run `dispatch setup --reconfigure` to change them later.
It only touches hosts it finds on this machine, and it never edits your `CLAUDE.md`, `AGENTS.md`,
skills, existing sub-agents or any project file.

### Non-interactive setup (scripts and CI)

Give the answers as flags (or a YAML file with `--answers <file>`; flags win over the file) and add
`--yes` to apply without asking:

```sh
dispatch setup --non-interactive --yes --plan claude=max5x --plan codex=plus --profile balance
```

Other answer flags: `--host claude-code|codex|none`, `--autonomy read-only|worktree|direct`,
`--enable-antigravity --accept-agy-terms`. Without `--yes`, `--non-interactive` only prints the plan.

### What setup writes

| Where | What is written |
| --- | --- |
| `~/.dispatch/bin/dispatch` | The launcher. It holds absolute paths to Node and Dispatch, so hooks work even when the host was started from a GUI with a minimal `PATH`. |
| `~/.dispatch/config.yaml` | Your answers, commented. Edit it for thresholds, extra accounts and the like; see [configuration.md](configuration.md). |
| `~/.dispatch/setup-manifest.json` | A record of every edit, so uninstall can undo it exactly. |
| Claude Code | A user-scope plugin, installed through `claude plugin install dispatch@dispatch-local -s user` from a local marketplace under `~/.dispatch/hosts/claude-code/`. It contains the `dispatch` sub-agent, a `SessionStart` hook that tells the session how and when to delegate, and a `PreToolUse` hook on the `Agent` tool that redirects `general-purpose` sub-agents to Dispatch in trusted repos (hard mode, `hosts.claude-code.hard` / `hosts.claude-code.intercept`). Claude Code reads the plugin from that folder, so `dispatch setup --refresh` updates it for every new session without a reinstall. Dispatch itself writes nothing under `~/.claude`. |
| Codex | A skill in `~/.agents/skills/dispatch/`, hook entries in `~/.codex/hooks.json` (marker-delimited, other entries untouched), and a rules file `~/.codex/rules/dispatch.rules`. |

### Trust grants

Setup asks you to accept two trust grants. Read them before saying yes.

- **Codex rules file.** Codex runs shell commands in a sandbox with no network, so `dispatch run`
  could not work from inside it. The rules file allows exactly one thing outside the sandbox: the
  absolute launcher path with the subcommands `run`, `wait`, `cancel` and `status`. Commands that
  chain, pipe, redirect or expand (`;`, `&&`, `|`, `$`, backticks) never match it.
- **Codex hook approval.** Codex only runs hooks you have approved. After setup, start Codex, open
  `/hooks`, and approve the Dispatch hooks. There is no CLI for this. Until you do, the Codex side
  stays inert (the skill still works when asked).

### Claude permission rule

Dispatch never edits your Claude permissions. If the `dispatch` sub-agent should run without a prompt
for every call, add the two rules printed by `dispatch doctor` to `permissions.allow` in
`~/.claude/settings.json`:

```
Bash(~/.dispatch/bin/dispatch run:*)     # doctor prints the absolute path of your launcher
Bash(~/.dispatch/bin/dispatch wait:*)
```

## `dispatch install` (per repository)

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
`--no-trust`, `--force`, `--skip-setup`, and `--non-interactive --yes` for scripts and CI. When it has
to run setup first, it accepts the setup answer flags too (`--plan`, `--host`, `--autonomy`, `--answers`,
`--enable-antigravity`, `--accept-agy-terms`).

## `dispatch doctor`

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

## Troubleshooting

Run `dispatch doctor`; each line has a status and a `fix:`. The usual ones:

| Doctor says | Fix |
| --- | --- |
| `launcher ... points at paths that no longer exist` | Node or Dispatch moved (upgrade, reinstall): `dispatch setup --refresh`. |
| `<path> does not exist (setup has not run)` / `config.global ... does not exist` | `dispatch setup`. |
| `.dispatch/ exists but is not trusted` / `changed since it was trusted` | The repo policy is ignored. Review `.dispatch/`, then `dispatch trust`. |
| `<cli> was not found on PATH` | Install the CLI, or set `providers.<id>.binary` in `~/.dispatch/config.yaml`. |
| `not logged in` / `login state is unknown` | `codex login`; for `claude` and `agy` run the CLI once interactively. `doctor --live` proves the login. |
| `claude-code.permission-rule` warns | Add the printed `Bash(... run:*)` and `Bash(... wait:*)` rules to `permissions.allow`. |
| `claude-code.hard-mode` warns (no PreToolUse hook, or the cache does not say) | The plugin predates hard mode: `dispatch setup --refresh`, then restart Claude Code sessions. |
| `CODEX_SANDBOX` set (`host.codex-rule`) | The Codex rule did not match. Use the absolute launcher path and a single-quoted task, run `dispatch setup --refresh`, and approve the Dispatch hooks in Codex `/hooks`. |
| `quota channel is broken` | A provider changed its format. Routing continues on estimates and `status` shows `stale`; update Dispatch, or set `quota.readers.<id>.enabled: false`. |

Other useful commands: `dispatch validate` (config errors), `dispatch explain` (why a task went where it
went), `dispatch logs --task <runId>` (what happened in a run).

Updating, reconfiguring and uninstalling are covered in the
[README](../README.md#update-reconfigure-uninstall).
