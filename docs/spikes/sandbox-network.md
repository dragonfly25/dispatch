# Spike: opt-in shell sandbox network for delegated agents (2026-11-07)

Goal: let a delegated builder agent run the app's API server, its database (Docker) and tests that
need them, when the owner opts in. Without it, the codex `workspace-write` shell cannot open any
port (`listen EPERM` even on 127.0.0.1), reach localhost, the Docker socket or the internet.
Real CLIs: codex 0.167.0, claude 2.1.301, Docker running, pnpm 10.30.1, npm 10.9.2. No user config was
touched (codex runs used `--ignore-user-config`; `codex sandbox` reads the user config, which sets
no sandbox or permission key). Test directory under HOME (same volume as the pnpm store, like
Dispatch worktrees under `~/.dispatch/worktrees`), with `listen.js` (an HTTP server on
`127.0.0.1:0` that fetches itself) and a `package.json` depending on `is-number@7.0.0`.

## codex 0.167.0

### Offline checks (no model call)

| Question | Result |
|---|---|
| Does `--strict-config` accept `sandbox_workspace_write.network_access`? | Yes; a non-boolean fails at load: ``invalid type: string "maybe", expected a boolean in `sandbox_workspace_write.network_access` ``. |
| Can the read-only sandbox get network? | **No.** `-c sandbox_read_only.network_access=true` fails at load: ``unknown configuration field `sandbox_read_only` ``. `codex exec -s` only takes read-only, workspace-write, danger-full-access. |
| `codex sandbox -P :workspace -c sandbox_workspace_write.network_access=true -- node listen.js` | `LISTEN_ERR EPERM`: the legacy key does not apply to permission profiles. |
| `codex sandbox -P p -c 'permissions.p.extends=":workspace"' -c permissions.p.network.enabled=true` | listen OK, `curl https://example.com` → 200, `docker ps -q` lists the 3 running containers; `touch ~/x` still `Operation not permitted`. With `network.enabled=false` (or absent): `LISTEN_ERR EPERM`. (Permission profiles are not what `codex exec -s` uses; recorded for a future switch.) |
| pnpm/npm in that sandbox, default caches | pnpm cannot use its store in `~/Library/pnpm/store` (`EPERM ... symlink ... store/v10/projects/...`); left alone it silently drops a `.pnpm-store/` into the project (it would end up in the patch). npm fails on `~/.npm` (its error suggests `sudo chown -R 501:20 "/Users/…/.npm"` and "Log files were not written due to an error writing to the directory"). |
| With `npm_config_cache` and `npm_config_store_dir` under `$TMPDIR` | `pnpm install` (online), `npm install`, then `pnpm install --offline` from that store: all succeed. |

### Live run (1 of the 3 allowed; `gpt-6-luna`, effort low)

Dispatch's isolation flags plus the network override, `workspace-write`:

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins --disable apps --disable memories -c agents.enabled=false \
  -c 'projects={"<dir>"={trust_level="untrusted"}}' \
  -c sandbox_workspace_write.network_access=true \
  --skip-git-repo-check -C <dir> -m gpt-6-luna -c model_reasoning_effort=low \
  -o <out> -s workspace-write -
```

Results from the `command_execution` items of the JSON events (not the model's words):

| Command | Exit | Output |
|---|---|---|
| `env \| grep -E '^(CODEX_SANDBOX\|TMPDIR)'` | 0 | `CODEX_SANDBOX=seatbelt`, `TMPDIR=/var/folders/…/T/` (no `CODEX_SANDBOX_NETWORK_DISABLED`) |
| (a) `node listen.js` (listen on 127.0.0.1, then curl it) | 0 | `LISTEN_OK 51425 pong` |
| internet: `curl https://example.com` | 0 | `200` |
| (b) `docker ps -q` (unix socket `~/.docker/run/docker.sock`; read-only command) | 0 | the 3 running container ids |
| (c) `pnpm store path` (defaults) | 0 | `<dir>/.pnpm-store/v10` (inside the worktree) |
| (c) pnpm with the real store, `--prefer-offline` | fail | EPERM writing the global store |
| (c) caches under `$TMPDIR`: `pnpm install`, `npm install`, `pnpm install --offline` | 0 | all `Done` / `added 1 package` |

No control run was needed: the read-only question was settled offline, and the control (no
override → `listen EPERM`, no network) is the brief's own finding.

Decision:
- Worktree runs that the `network` scope covers get `-c sandbox_workspace_write.network_access=true`.
  Never `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`.
- Read-only runs never get network (no setting exists for the read-only sandbox).
- The child env gets `npm_config_cache=<cache>/npm` and `npm_config_store_dir=<cache>/pnpm-store`,
  where `<cache>` is `<TMPDIR>/dispatch-net/<runId>-<attempt>` (0700, realpath), removed when the
  attempt ends. Per attempt, not shared: a shared store could be poisoned by one agent for the
  next. `pnpm install` therefore runs online (the network is on); `--offline` works within the run.

### End-to-end through Dispatch (live run 2 of 3, after implementation)

`dispatch run --tier fast --effort low` (this branch's build) in a scratch repo with a temp
`DISPATCH_HOME` whose config says `network: all` (claude and antigravity disabled), started from a
Claude Code session (so the run's agent is `general-purpose`): codex `gpt-6-luna` reported
`LISTEN_OK`, `200` from example.com, `npm_config_cache` / `npm_config_store_dir` under
`/private/var/folders/…/T/dispatch-net/<runId>-1/`, and `pnpm install` done. The patch held only
`pnpm-lock.yaml` (no `.pnpm-store/`), the cache directory was gone afterwards, the result carried
`sandboxNetwork: {enabled: true, scope: "all", agent: "general-purpose"}` and `dispatch logs`
showed `sandbox network on (network: all)`.

## claude 2.1.301 (three tiny haiku runs)

The settings schema in the binary documents `sandbox.network.allowLocalBinding` ("macOS only: …
bind to localhost ports"), `allowAllUnixSockets`, `allowUnixSockets`, `allowedDomains`
("Domains sandboxed commands may reach without a prompt (wildcards such as *.example.com
supported)") and `sandbox.filesystem.allowWrite`.

Dispatch's worktree child flags (`-p --safe-mode … --permission-mode acceptEdits --tools Bash
--disallowedTools Agent`) and its `--settings` (credential `Read` deny rules, `denyRead`,
`failIfUnavailable: true`), prompt: run `node listen.js`, `curl https://example.com`,
`docker ps -q`, `test -r ~/.codex/config.toml`.

| Run | listen 127.0.0.1 | curl example.com | docker ps | read `~/.codex/config.toml` |
|---|---|---|---|---|
| control (Dispatch's settings as today) | `LISTEN_ERR EPERM` | `CONNECT tunnel failed, response 403` + `deny network-outbound example.com:443` | `permission denied … docker.sock` | `DENIED` |
| `+ sandbox.network: {allowLocalBinding: true, allowAllUnixSockets: true, allowedDomains: ["*"]}` | `LISTEN_OK` | `200` | 3 container ids | `DENIED` |

A third run added `sandbox.filesystem.allowWrite: [<TMPDIR>/dispatch-spike-claude]` and the two
cache variables (the sandboxed shell sees `TMPDIR=/tmp/claude-501`, so absolute paths are needed):
`pnpm install`, `npm install` and `pnpm install --offline` all succeeded. (That run's JSON had a
second `filesystem` key by mistake, so it does not show `denyRead` alongside `allowWrite`; the
second row above does show the credential deny holding with the network open.)

Decision: claude instances are network-capable, so no capability hint is needed. A network run
adds exactly that `sandbox.network` object and `allowWrite: [<cache>]` inside the same
`filesystem` object as `denyRead`; the permission rules, `failIfUnavailable` and everything else
are unchanged. Read-only claude children have no Bash, so they get nothing. If a future CLI
rejected the bare `*` domain, the network would stay closed (fail closed), not open wider.

## antigravity

Read-only only, so never affected (the network applies to worktree runs).
