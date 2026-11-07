# WP1 live spike: results

This spike ran on 2026-11-07 on macOS 26 (arm64) against claude 2.1.301, codex 0.167.0 and agy 1.5.2, all logged in on subscription or consumer plans. The details are in:
- [`codex.md`](codex.md)
- [`claude-code.md`](claude-code.md) (not named `claude.md`, because on a case-insensitive filesystem that name would be loaded as a `CLAUDE.md` memory file)
- [`agy.md`](agy.md)
- [`hosts.md`](hosts.md)

The frozen contract shapes are proposed in [`contracts-proposal.md`](contracts-proposal.md). Sanitized fixtures are in `test/fixtures/<cli>/<version>/`. Each fixture has a `meta.json` with its argv, exit code, `synthetic` flag and notes.

## Decision table

| # | Question | Answer (evidence) | Decision |
|---|---|---|---|
| 1 | Does a Codex edit work under `workspace-write` with the isolation flags? | **Yes.** It emits `file_change` and `command_execution` items, the `git diff` is correct, and there is no network (DNS fails). **But** `codex exec` persists `[projects."<repo-root>"] trust_level="trusted"` into `~/.codex/config.toml`, including for the main repo when run inside a linked worktree. `--ephemeral` breaks `spawn_agent`. | Add `-c 'projects={"<wt>"={trust_level="untrusted"},"<root>"={trust_level="untrusted"}}'` (verified to stop the write) and `-c agents.enabled=false`. `probe` validates `--disable` names against `codex features list`. |
| 2 | How do Codex rules handle compound commands? Where do rules live? Do they bypass the sandbox? | Scripts are split with tree-sitter on `&& \|\| ; \|`, and **every** piece must match an allow rule for the sandbox to be bypassed. Otherwise the decision is the most restrictive one, and the command runs sandboxed. Substitution, `$`, `~`, redirects and heredocs make the parse fail, so the script is unmatched. Rules load from `~/.codex/rules`, from trusted `<repo>/.codex/rules` and from system rules; there is no session-only path. `allow` means `bypass_sandbox`, so network and outside writes work. | Use the rule text in `codex.md` (absolute launcher plus `run\|wait\|cancel\|status`, with load-time `match`/`not_match`). The launcher detects `CODEX_SANDBOX` and fails fast. The skill teaches the rule-compatible call form. |
| 3 | Codex hard mode: deny vs `updatedInput` proxy? Shell timeout? Does SessionStart give the model? | Current models use **multi-agent V2**. The hook `tool_name` is `collaborationspawn_agent`, so `spawn_agent` and `Agent` do not match. The `message` is **encrypted**. A plaintext `updatedInput` fails with `400 invalid_encrypted_content`. Deny with a reason works, and a reason that tells the model to run `<launcher> run --detach '<task>'` and then `wait` was followed end-to-end. Unified exec has no hard timeout (≤30 s yield, then up to 300 s per poll). Codex SessionStart includes `model`. | **UC3 = `deny_redirect`** with matcher `spawn_agent\|collaborationspawn_agent\|Agent`. Drop `proxy_subagent`. Codex `wait --timeout 280`. |
| 4 | Claude child isolation. Does `--settings` work under `--safe-mode`? Does the sandbox work? Does `--plugin-dir` work? Does SessionStart include `model`? | `--settings` applies under `--safe-mode`. The Read deny rule blocked the Read tool. `sandbox.filesystem.denyRead` made `cat` fail with "Operation not permitted". Writes in cwd work, network is blocked, and the canary appeared 0 times in stdout. `--plugin-dir` loads in `-p`, and the SessionStart hook plus `additionalContext` work. **SessionStart in `-p` has no `model`.** Without `--safe-mode`, the child loads all of the user's claude.ai MCP connectors. | Keep the plan's invocation. Use the `<S>` JSON from `claude-code.md` (`failIfUnavailable:true`; `//` prefix in permission rules, plain absolute paths in `denyRead`). The host model stays "unknown/inherit" for Claude hosts. |
| 5 | agy `--mode plan` read-only? `/usage`? Can hooks and plugins be disabled? | No file was created, but **`--mode plan` is a no-op** together with `--disable-slash-commands`. Writes are blocked by headless auto-deny (`request-review`), and the run still ends `status:"SUCCESS"`, exit 0, with `denied_actions`. **The prompt cannot come from stdin**, and `-p -` is taken literally. `/usage` JSON was recorded. No setting disables user hooks or plugins. | Drop `--mode plan` and pass the prompt as `-p=<prompt>` (`promptChannel: "argv"`). Map `SUCCESS` plus `denied_actions` to `failed`. Isolation is `not_disableable`, so rely on `DISPATCH_DEPTH` and filter `.agents/` in patches. |
| 6 | Hook environment under a GUI-launched host? | The Claude desktop app rebuilds the login-shell PATH, but launchd's GUI domain has none, so other GUI hosts give `/usr/bin:/bin:/usr/sbin:/sbin`. The desktop host runs a bundled claude 2.1.317 (`CLAUDE_CODE_EXECPATH`), while PATH has 2.1.301. Codex prepends its arg0 dirs and exports `CODEX_THREAD_ID` and `CODEX_VERSION`. | Hooks use absolute node and hook paths, and the launcher appends the well-known dirs to PATH. Self-detection is env-only (`CLAUDECODE`, `CODEX_THREAD_ID`), never via the PATH binary. |
| 7 | What do quota-exhaustion events look like? | Claude: SDK types (`rate_limit_event.status:"rejected"`, `assistant.error:"rate_limit"`, `api_error_status`) plus the docs' message text. Codex: `error.rs` messages (`You’ve hit your usage limit…`, U+2019 apostrophe) arrive as `turn.failed`, exit 1. agy: the binary's `AGY_ERROR: {"short_error":…}` with "You have exhausted your quota on this model.", exit 3. | Synthetic fixtures (`synthetic:true`, with sources) and classification rules per adapter in each topic doc. |

## Contradictions with the plan
1. **Codex hard mode.** The plan assumed `updatedInput` and deny work on the `spawn_agent` matcher. On V2 models the matcher name differs, the message is encrypted, and `updatedInput` fails. Use `deny_redirect`.
2. **`codex exec` is not side-effect-free.** It writes project trust to `~/.codex/config.toml`, so a new mandatory guard flag is needed.
3. **agy `--mode plan` does not enforce read-only**, and agy **cannot take the prompt on stdin**. The plan said "every adapter … receives the prompt on stdin".
4. **SessionStart and `model`.** Codex SessionStart does include `model`. Claude `-p` SessionStart does not.
5. **Codex `wait` default** is 280 s, not 300 s. **`--disable multi_agent` does not disable V2 tools**; use `-c agents.enabled=false`.

## Recommended invocations

```
# claude (worktree; read-only swaps to --permission-mode dontAsk --tools Read,Grep,Glob)
claude -p --safe-mode --output-format stream-json --verbose --no-session-persistence \
  --model M --effort E --max-turns N --permission-mode acceptEdits \
  --tools Read,Grep,Glob,Edit,Write,Bash --disallowedTools Agent --settings '<S>'     < prompt

# codex
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins --disable apps --disable memories -c agents.enabled=false \
  -c 'projects={"<wt>"={trust_level="untrusted"},"<root>"={trust_level="untrusted"}}' \
  -C <wt> -m M -c model_reasoning_effort=E -o <run>/last.txt -s read-only|workspace-write -   < prompt

# agy (read-only only; cwd = worktree)
agy -p=<prompt> --output-format stream-json --sandbox --disable-slash-commands \
  --model M --effort E --print-timeout S
```

## How it was tested
- Every child ran in temp git repos under the session scratch directory, with an `env -i` allow-listed environment (the plan's runner env) and `DISPATCH_DEPTH=1`.
- Codex hooks were injected session-only via `-c hooks.<Event>=[…]` with `--dangerously-bypass-hook-trust`, used only in the temp repo. A fake launcher logged argv for the redirect test.
- Codex rule semantics come from `codex execpolicy check` (argv level) plus source and tests at `rust-v0.167.0`. Compound-command splitting was **not** exercised live.
- Claude and agy documentation was cross-checked on code.claude.com and antigravity.google. The Claude SDK types come from `@anthropic-ai/claude-agent-sdk` 0.3.319.

## Quota used
- **claude:** 4 tiny `-p` runs on haiku (3 isolation, 1 plugin).
- **codex:** 6 tiny exec runs on `gpt-6-luna`, low effort (1 edit, 5 hook runs). There were also 7 quota-free probes with an invalid model, rejected before generation, to study the trust write.
- **agy:** 2 tiny runs on `gemini-3.8-flash-low`. One was unintended: `-p -` ran with a literal prompt. Also quota-free `--help`, `models` and `/usage`.

## Global files
- **`~/.codex/config.toml`** was modified **by codex itself**: auto-trust entries from the editing and hook runs. It was restored byte-exact; the sha256 matches the pre-spike hash recorded before the first run. During the trust probes it was backed up and restored after each probe, with the sha256 re-verified.
- **`~/.claude/plugins/data/` and `~/.claude/projects/<tmp-slug>/memory/`** were created as empty directories by the `--plugin-dir` run and then removed.
- **Runtime state written by the CLIs and left in place:** Codex session rollouts for the 4 non-ephemeral hook runs (plus their sub-agent rollouts) under `~/.codex/sessions/2026/11/07/`, and agy conversation history.
- No settings, hooks or rules files were written by me. `~/.claude/settings.json` and `~/.gemini/antigravity-cli/settings.json` hashes are unchanged.
