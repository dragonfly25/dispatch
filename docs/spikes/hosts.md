# WP1 spike: host environment and binary resolution

## Q6. What hook processes of GUI-launched hosts see

### Observed
- **Claude desktop app.** This spike ran inside it: `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `__CFBundleIdentifier=com.anthropic.claudefordesktop`, `XPC_SERVICE_NAME=application.com.anthropic.claudefordesktop.*`.
  - **PATH.** Bash (and therefore hooks, which inherit the parent env) gets the user's **full login-shell PATH**: `~/.local/bin`, `/opt/homebrew/bin`, pnpm and so on. The launchd GUI domain has no PATH (`launchctl getenv PATH` is empty; `launchctl print gui/<uid>` sets only `SSH_AUTH_SOCK`). So the desktop app rebuilds PATH from the login shell itself. Other GUI hosts are not guaranteed to, and their children get the macOS default `/usr/bin:/bin:/usr/sbin:/sbin`.
  - **The host's own `claude` is not on PATH.** The desktop app runs a bundled Claude Code (2.1.317 at `~/Library/Application Support/Claude/claude-code/<ver>/…/claude`, exposed as `CLAUDE_CODE_EXECPATH`). `claude` on PATH is a different install (2.1.301). Host version ≠ PATH CLI version, which matters for `cliRange` checks and self-detection.
  - **Env markers seen:** `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_EFFORT`. There is no model variable.
- **Claude hooks** (from the `--plugin-dir` run under `env -i`): PATH is exactly the parent's, plus `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDECODE=1`. Commands run via `sh -c`.
- **Codex hooks** (`codex exec`, from captures): PATH is the parent's PATH **prefixed** with `~/.codex/tmp/arg0-macos/codex-arg0XXXX` and `/opt/homebrew/Caskroom/codex/<ver>/codex-path`. Shell commands also get `CODEX_THREAD_ID`, `CODEX_VERSION` and `CODEX_CI`, plus `CODEX_SANDBOX=seatbelt` and `CODEX_SANDBOX_NETWORK_DISABLED=1` when sandboxed (`core/src/exec_env.rs`, `core/src/spawn.rs`).

### Recommendation: binary resolution
1. **Hook commands never rely on PATH.**
   - `setup` writes absolute paths to node and to `hook.mjs`, as in the plan's guard: `[ -x /abs/node ] && [ -f /abs/hook.mjs ] || exit 0; exec /abs/node /abs/hook.mjs <host> <event>`.
   - The plan's test under `env -i PATH=/usr/bin:/bin` is the right simulation of a non-desktop GUI host.
2. **The launcher `~/.dispatch/bin/dispatch` embeds absolute node and cli paths.** Its first line resets `PATH` to `"$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"`, so child CLIs resolve even from a bare GUI env.
3. **Child CLI resolution order:** config `binary:` → `PATH` → `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `$(npm prefix -g)/bin`. Record the resolved realpath and version in each run. `doctor` warns when it resolves a symlink into `/opt/homebrew/Caskroom/<x>/<ver>/` that differs from the version the fixtures cover.
4. **Host self-detection:**
   - Claude: `CLAUDECODE=1` (desktop: `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, version from `CLAUDE_CODE_EXECPATH`'s path segment).
   - Codex: `CODEX_THREAD_ID` (with `CODEX_VERSION`).
   - Otherwise self = none.
   - Never infer the host from the PATH binary.
5. **The Codex host sandbox is visible.** If `CODEX_SANDBOX` is set when `dispatch run|wait` starts, the rule did not match. Exit 3 with an instruction to call the absolute launcher in the rule-compatible form (see `codex.md`).

## Shell/tool timeouts per host → `wait --timeout` defaults

| Host | Shell tool behaviour | `wait` default |
|---|---|---|
| Claude Code | Bash tool default 120 s (max 600 s) | 100 s (plan, unchanged) |
| Codex (unified exec, default) | no hard timeout; the call yields after ≤30 s and the model polls via `write_stdin` for up to 300 s per poll | **280 s** (plan said 300; keep it under one poll ceiling) |
| Codex (legacy shell) | 10 s default `timeout_ms` | 8 s (when `doctor` sees `unified_exec` disabled) |
| none | — | unlimited |
