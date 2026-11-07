# WP1 spike: Antigravity CLI (`agy`) 1.5.2

Tested on 2026-11-07 with `/opt/homebrew/bin/agy` 1.5.2 (cask `antigravity-cli`) and model `gemini-3.8-flash-low`. Quota-free probes: `--help`, `models`, `/usage`. Two model runs were made, one of them accidental (see below). Fixtures are in `test/fixtures/agy/1.5.2/`.

## Q5. Read-only child: `--mode plan --sandbox --disable-slash-commands`

Fixture `plan_mode_write_denied`. Cwd is a temp git repo (agy has no cwd flag), and the env is allow-listed:

```
agy -p='Create a file named hello.txt … Then reply DONE or explain why you could not.' \
  --output-format stream-json --mode plan --sandbox --disable-slash-commands \
  --model gemini-3.8-flash-low --print-timeout 120s
```

- **No file was created.**
- **Exit code 0.** The result is `{"status":"SUCCESS","response":"","denied_actions":[{"action":"write_file","display_name":"WriteFile"}]}`.
- **Events.**
  - `init{model, cwd, permission_mode:"request-review", tools[60]}`
  - `step_update` (`user_input`, `agent_response` with usage)
  - `tool` `write_file` going from `ACTIVE` to `ERROR`, with `error{type:"TOOL_ERROR", message:"permission check failed for write_file … user denied permission …"}`
  - `result`
- **stderr:**
  - `warning: --mode plan has no effect while slash command expansion is disabled.`
  - `jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied. …`

**Finding (contradicts the plan): `--mode plan` is not an enforcement mechanism.** It is a `/plan` prompt prefix, and it is a no-op together with `--disable-slash-commands`. Read-only is actually enforced by headless permission mode `request-review`: any tool needing approval is auto-denied in `-p`. The flag to avoid is `--dangerously-skip-permissions`, which the plan already bans. Also, `--sandbox` is documented as "no effect if the sandbox is unavailable", so it cannot be the guarantee either.

**Second finding: `SUCCESS` does not mean success.** A run can end with `status:"SUCCESS"`, an empty `response` and a non-empty `denied_actions`. The adapter must map that to `rejected` or `failed` (proposed: `failed` with `nativeError: "denied: write_file"`), not `success`.

**Recommended read-only invocation (WP16).** Drop `--mode plan`, and keep slash commands disabled so prompt text cannot expand skills or commands:

```
agy -p=<prompt> --output-format stream-json --sandbox --disable-slash-commands \
    --model <m> --effort <e> --print-timeout <s>s
```

Optionally add `--settings '{"permissions":{"deny":[…]}}'` as defence in depth. The deny-rule syntax for agy is `tool(target)` per the stderr hint, but it was not verified, so headless auto-deny is the guarantee for now. Verify `--effort` with a flash model in WP16.

## Prompt delivery: no stdin (contradicts the plan's "prompt on stdin")

- `-p` **takes a value**. `agy -p --output-format …` used `--output-format` as the prompt (exit 2 with an explanatory error), and `agy … -p` with no value is a usage error.
- `agy --output-format json -p -` used the **literal string `-`** as the prompt and ignored stdin. It still ran a model turn: 7k input tokens, and it tried a command that was auto-denied. This is fixture `prompt_dash_is_literal`, and it was the accidental run.
- **Options.** Pass the prompt as `-p=<prompt>` in argv, which is visible in `ps` to the same user. Or use `--input-format stream-json` (one NDJSON message per line on stdin), but that message schema is not documented in `--help` and was not tested. **Decision for v0.1:** argv (`-p=<prompt>`). The prompt is the user's own task, and `ps` visibility is limited to local processes. Add `promptChannel: "argv"` to the adapter capabilities.

## `/usage` (quota-free)

Fixture `usage.json`, from `agy -p /usage --output-format json`, returns:

```json
{"status":"SUCCESS","num_turns":0,"usage":{…zeros},
 "command":{"name":"usage","data":{"groups":[
   {"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-14T07:18:55Z"}]},
   {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"…"}]}]}}}
```

## Disabling user hooks and plugins in the child: not possible via settings

- **Hooks.** The docs say they load from `~/.gemini/config/hooks.json`, `<project>/.agents/hooks.json` and installed plugins. A `hooks` key in settings.json is "kept but never loaded", and no settings key disables or relocates hooks. Individual entries have `"enabled": false`, which is a user edit and not something Dispatch may touch.
- **Plugins.** The binary has an `enabledPlugins` map, but it is undocumented. Changing `HOME` would break Keychain auth.
- **Consequence.** User hooks may run inside agy children. Dispatch's own hook command must stay a no-op under `DISPATCH_DEPTH` (already in the plan). The worktree's `.agents/hooks.json` comes from the repo, so the patch filter should also reject `.agents/` changes.

## Quota-exhaustion shape (synthetic fixture `quota_exhausted`)

The binary contains the format `AGY_ERROR: {"short_error":%q}` and the message `You have exhausted your quota on this model.`. The embedded 1.5.x changelog says model and agent errors in `-p` now "exit with code `3` and print the `AGY_ERROR` line", and that `--print-timeout` cuts also exit 3.

The fixture is stderr `AGY_ERROR: {"short_error":"You have exhausted your quota on this model."}` with exit 3. The stdout preceding it is unverified.

**Rule (WP16).**
- Exit 3 with `short_error` matching `/exhausted your quota|RESOURCE_EXHAUSTED/i` → `quota_exhausted`. Cross-check with `/usage` (`remaining_fraction == 0`).
- Exit 3 with `print timeout` on stderr → `timeout`.
