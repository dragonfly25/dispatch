# WP1 spike: Claude Code 2.1.301

Tested on 2026-11-07 with `~/.local/bin/claude` 2.1.301, a subscription login (`apiKeySource: "none"`), and model `haiku` (`claude-haiku-5-5`). Fixtures are in `test/fixtures/claude/2.1.301/`.

Every child ran under an allow-listed environment, like the plan's runner:

```
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin HOME USER LANG TMPDIR SHELL TERM=dumb DISPATCH_DEPTH=1
```

Subscription auth via the Keychain still worked.

## Q4a. Child isolation: settings, deny rules and sandbox under `--safe-mode`

Command (fixture `child_isolation_canary`):

```
claude -p --safe-mode --output-format stream-json --verbose --no-session-persistence \
  --model haiku --max-turns 8 --permission-mode acceptEdits \
  --tools Read,Grep,Glob,Edit,Write,Bash --disallowedTools Agent \
  --settings '{"permissions":{"deny":["Read(//<canary>/**)","Read(//<canary>)"]},
               "sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,
                          "allowUnsandboxedCommands":false,"filesystem":{"denyRead":["<canary>"]}}}'
```

The canary file `<tmp>/canary/secret.txt` held a random token. The prompt asked the model to read it via Read, then via `cat`, then to write a file in cwd, then to `curl`.

| Step | Result |
|---|---|
| Read tool on the canary | `File is in a directory that is denied by your permission settings.`, listed in `result.permission_denials` |
| `cat` canary (Bash) | `Operation not permitted` (OS sandbox) |
| `echo hi > out.txt && ls` | works; the file was created in cwd |
| `curl https://example.com` | blocked: `<sandbox_violations> deny network-outbound example.com:443` |
| canary token in stdout | **0 occurrences** |

**Conclusions.**
- **`--settings` applies under `--safe-mode`.** Both the permission deny rules and the sandbox took effect. `init` shows `tools` limited to `Bash, Edit, Glob, Grep, Read, Write`, with no `Agent`, `mcp_servers: []` and `apiKeySource: "none"`.
- **Bash works inside the sandbox on macOS** (seatbelt), with `autoAllowBashIfSandboxed` and `acceptEdits`. The sandbox's default network policy is deny-all, which suits read-only and worktree children.
- **`sandbox.filesystem.denyRead` alone blocks `cat`** (fixture `sandbox_denyread_bash`, a sandbox-only settings run). Plain absolute paths with a single leading `/` work in `denyRead`.
- **Permission rules use a different path syntax.** In `permissions.deny`, absolute paths need `//` (`Read(//abs/**)`). A single `/` anchors at the settings source (docs: code.claude.com/docs/en/permissions).
- **Reads outside cwd are denied anyway in `-p`.** With sandbox-only settings, a Read outside cwd was auto-denied ("requested permissions … haven't granted it yet", a `system/permission_denied` event; fixture `read_outside_cwd_needs_permission`). Credential deny rules are still needed for paths inside the worktree (`.env*`) and as defence in depth.
- **Some built-ins still load under `--safe-mode`.**
  - Built-in plugins `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-plugin-authoring`.
  - The built-in skills list.
  - `agents` (claude, Explore, general-purpose, Plan, web-fetch). They are unusable, because `Agent` is not in `tools`.

**Recommended `<S>` for children** (WP14). Absolute paths are expanded at build time; the deny list is the plan's:

```json
{
  "permissions": {
    "deny": [
      "Read(//$HOME/.claude/**)", "Read(//$HOME/.codex/**)", "Read(//$HOME/.gemini/**)",
      "Read(//$HOME/.dispatch/**)", "Read(//$HOME/.ssh/**)", "Read(//$HOME/.aws/**)",
      "Read(./.env*)", "Read(./**/.env*)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["$HOME/.claude", "$HOME/.codex", "$HOME/.gemini", "$HOME/.dispatch", "$HOME/.ssh", "$HOME/.aws"]
    }
  }
}
```

`failIfUnavailable: true` gives the plan's "fail closed" for free: Claude exits at startup if the sandbox cannot start. Linux needs bubblewrap and socat, so `doctor` should check for them.

## Q4b. `--plugin-dir` in `-p` and the SessionStart payload

Fixture `plugin_dir_session_start`: `claude -p … --plugin-dir <dir>`, without `--safe-mode`. The plugin has a SessionStart command hook that dumps stdin and returns `additionalContext`.

- **The plugin loads and the hook runs in `-p`.** The stream shows `system/hook_started` and `system/hook_response`, and `init.plugins` contains `{"name":"dspike","source":"dspike@inline"}`. The injected context reached the model, which answered with the secret word from `additionalContext`.
- **SessionStart input in `-p` has no `model` field** (fixture `hook_session_start_print_mode.json`). It contains `session_id, transcript_path, cwd, hook_event_name, source:"startup"`. The docs say the field is optional, and in practice it is absent in print mode. **The host session model is therefore "unknown" unless observed elsewhere** (statusline input, or `CLAUDE_EFFORT` for effort only).
- **Hook environment.** The hook inherits the parent env (PATH as given), plus `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/<name>-inline`), `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=sdk-cli`.
- **Side effects even with `--no-session-persistence`.** Claude created `~/.claude/plugins/data/dspike-inline/` and `~/.claude/projects/<slug>/memory/`, both empty. I removed them after the test. Children using `--safe-mode` created neither.
- **Without `--safe-mode` the child inherits all the user's claude.ai connectors.** In this run that was 12 MCP servers, including trading and Drive connectors; they are redacted in the fixture. This confirms that `--safe-mode` is mandatory for children.

## Quota-exhaustion shape (synthetic fixture `quota_exhausted`)

The field names come from `@anthropic-ai/claude-agent-sdk` 0.3.319 `sdk.d.ts`:
- `SDKRateLimitInfo.status: 'allowed'|'allowed_warning'|'rejected'`, plus `rateLimitType`, `resetsAt`, `utilization`, `overageStatus` and `overageDisabledReason`.
- `SDKAssistantMessage.error?: 'rate_limit'|…`.
- `SDKResultSuccess.api_error_status?: number|null`.

The text `You've hit your session limit · resets 3:45pm` (and the weekly, Opus and Sonnet variants) comes from code.claude.com/docs/en/errors.

The real `allowed` shape is in every live fixture:

```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":…,"rateLimitType":"seven_day","overageStatus":"allowed",…,"unifiedWindows":{"seven_day":{"utilization":0.26,"resetsAt":…}}}}
```

`unifiedWindows` is not in the SDK types but appears live; the passive quota reader should prefer it when present.

**Classification rule (WP14).** Return `quota_exhausted` if any of these holds:
- `rate_limit_event.rate_limit_info.status == "rejected"` and `overageStatus != "allowed"`;
- `assistant.error == "rate_limit"`;
- `result.api_error_status == 429`;
- the result text matches `/hit your (session|weekly|opus|sonnet)? ?limit/i`.

`resetAt` comes from `resetsAt`, in epoch seconds.
