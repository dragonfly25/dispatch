# WP1 spike: Codex CLI 0.167.0

Tested on 2026-11-07 with codex-cli 0.167.0 (Homebrew cask) on macOS 26, logged in with ChatGPT (Plus). Source citations are relative to `codex-rs/` at tag [`rust-v0.167.0`](https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs). Fixtures are in `test/fixtures/codex/0.167.0/`.

Model: `gpt-6-luna`, the cheapest listed slug in `codex debug models`, with `-c model_reasoning_effort=low`.

## Q1. Isolated edit under `workspace-write`

Command (fixture `edit_workspace_write`):

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins -C <tmp-git-repo> -m gpt-6-luna \
  -c model_reasoning_effort=low -o <run>/last.txt -s workspace-write -   # prompt on stdin
```

- **The edit works.** Exit code 0. The stream holds `command_execution` items (`/bin/zsh -lc "…"`), then one `file_change` item (`changes:[{path, kind:"update"}]`, `status: completed`), then `agent_message`, then `turn.completed{usage}`. `git diff` shows `sub()` added and exported (stored in `meta.gitDiff`).
- **There is no network.** `curl https://example.com` failed with `Could not resolve host`, exit 6. The item has `status:"failed"` and `exit_code:6`.
- **Feature names are valid.** `codex features list` includes `hooks`, `plugins`, `multi_agent`, `multi_agent_v2`, `apps`, `unified_exec` and `memories`. There is no `skills` feature. Skills are still injected, and a trivial edit used about 76k input tokens, 67k of them cached.
- **`file_change` paths are absolute.** The adapter must strip the worktree prefix.

### Finding (not in the plan): `codex exec` writes project trust into `~/.codex/config.toml`

- **What happens.** After an editing run in a git repo, Codex appended this to the user's global config:

  ```
  [projects."<repo>"]
  trust_level = "trusted"
  ```

  It does this even with `--ignore-user-config` and `--ephemeral`.
- **Where.** `app-server/src/request_processors/thread_processor.rs:1466-1495`. Exec runs an in-process app-server. When a cwd is requested and the project has no trust level, Codex persists `Trusted` if the effective permissions can write the cwd.
- **Worktrees.** In a linked git worktree the entry is written for the main repo root (`resolve_root_git_project_for_trust`), not the worktree. A Dispatch child would therefore silently mark the user's real repo as trusted.
- **Probes.** All quota-free, using an invalid model so the turn fails before generation:

| Variant | Trust written? |
|---|---|
| plain, `workspace-write` | yes (repo path) |
| `-c 'project_root_markers=[]'` | yes |
| `-s read-only` | no |
| linked worktree | yes, **main repo root** |
| `-c 'projects={"<wt>"={trust_level="untrusted"}}'` | no |
| same for root only / for both | no |

- **Mitigation (required).** Pass `-c 'projects={"<worktree>"={trust_level="untrusted"},"<repo-root>"={trust_level="untrusted"}}'`. Use an inline table, because `-c projects."<path>".trust_level=…` does not survive the dotted-key split. "Untrusted" also disables the worktree's `.codex/` layer (repo hooks, rules and config), which is what we want for a child.
- **Cleanup.** My runs triggered the write twice. `~/.codex/config.toml` was restored and its sha256 verified (see README, "Global files").

### Finding: `--ephemeral` breaks `spawn_agent`

With `--ephemeral`, a `spawn_agent` call fails with `collab spawn failed: … no rollout found for thread id …`. For children this is harmless, but explicit is better: add `-c agents.enabled=false`.

`--disable multi_agent` alone does **not** disable multi-agent tools when the model catalog requests V2. See `core/src/config/mod.rs:1687-1712`: the precedence is the `multi_agent_v2` feature, then `agents.enabled=false`, then the catalog's `multi_agent_version`, then the `multi_agent` feature.

### Recommended child invocation

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins --disable apps --disable memories \
  -c agents.enabled=false \
  -c 'projects={"<wt>"={trust_level="untrusted"},"<repo-root>"={trust_level="untrusted"}}' \
  -C <wt> -m <model> -c model_reasoning_effort=<effort> -o <run>/last.txt \
  -s read-only|workspace-write -
```

Not every flag in this line was exercised. The editing run used everything except `--disable apps`, `--disable memories`, `-c agents.enabled=false` and the `projects=` override. The `projects=` override was verified by the quota-free probes. The other three use names confirmed by `codex features list` and the config source, but WP15 must cover them in its first `doctor --live` run.

`probe()` must run `codex features list` and fail closed if any `--disable` name is unknown, because `--strict-config` rejects it anyway.

## Q2. Rules (`prefix_rule`) for the Dispatch launcher

### Where rules load from
- Every enabled config layer that has a folder contributes `<folder>/rules/*.rules` (`core/src/exec_policy.rs:688-711`, `config/src/state.rs:219-231`). That gives:
  - **System:** the dir of `/etc/codex/config.toml`.
  - **User:** `~/.codex/rules/`.
  - **Project:** `<repo>/.codex/rules/`, only when the project is trusted (untrusted project layers are disabled).
- Session flags (`-c`) have no folder, so **there is no session-only way to add a rule**. The global file is necessary, as accepted in the plan.
- `--ignore-rules` (exec only) drops User and Project rules. System rules and managed requirements still apply.

### How a command is matched (source + `codex execpolicy check`)
- **Splitting.** A shell call arrives as `["/bin/zsh","-lc","<script>"]`, the form seen in every fixture. `parse_shell_lc_plain_commands` (`shell-command/src/bash.rs:30-95`) uses tree-sitter-bash. It accepts only words, single- or double-quoted strings without expansions, and the operators `&&`, `||`, `;` and `|`. Each piece is then matched separately.
- **Fallback.** Anything else makes the parse return `None`, and the whole `zsh -lc …` argv is matched as one command, which our rule never matches. That covers `$(…)`, backticks, `$VAR`, redirections, heredocs, subshells, braces and words containing `~ * ? [ ] { } \ $ # ^` or a leading `=` (`bash.rs:260-274`).
- **Verdict.** The decision is the most restrictive over all pieces, so an unmatched piece gets the fallback heuristics (`execpolicy/src/policy.rs` `from_matches`). **The sandbox is bypassed only if every piece is explicitly allowed by a rule** (`core/src/exec_policy.rs:466-480`, `bypass_sandbox: commands.iter().all(…)`). Tests `heredoc_script_stays_in_sandbox_despite_inner_allow_rule` and `heredoc_with_variable_assignment_is_not_reduced_to_allowed_prefix` (`core/src/exec_policy_tests.rs:770-910`) confirm this.

| Command the model runs | Result |
|---|---|
| `/abs/dispatch run --json 'task'` | allow, unsandboxed |
| `/abs/dispatch run x && rm -rf ~` | `~` is not a literal word, so parse fails; the whole script is unmatched and runs sandboxed/default |
| `/abs/dispatch run x && rm -rf /tmp/y` | split; `rm` is unmatched, so the decision is not a pure allow and **runs sandboxed** |
| `/abs/dispatch run x; sh` | same: `sh` piece unmatched, so sandboxed |
| `/abs/dispatch run "$(cat f)"` / backticks | parse fails, so unmatched |
| `bash -lc "/abs/dispatch run x"` nested | inner `bash` is argv[0], no rule, so unmatched |
| `printf … \| /abs/dispatch run` | `printf` unmatched, so sandboxed |
| `dispatch run x` (bare name) | no match; basename resolution only maps absolute argv[0] onto basename rules, not the reverse |
| `/tmp/evil/dispatch run x` | no match (checked with `--resolve-host-executables` too) |
| `/abs/dispatch install` / `setup` | no match |

- **What `execpolicy check` covers.** `codex execpolicy check -r <file> <argv…>` (`execpolicy/src/execpolicycheck.rs`) matches argv literally with no shell splitting. Its JSON output is `{"matchedRules":[{"prefixRuleMatch":{"matchedPrefix":[…],"decision":"allow",…}}],"decision":"allow"}`, or `{"matchedRules":[]}`. Use it in `doctor` and SEC-rules for argv-level checks. Compound-command behaviour comes from source and tests, and was not exercised live (quota).
- **Bypass is real.** `Allow` with all pieces matched gives `Skip{bypass_sandbox:true}`, then `SandboxOverride::BypassSandboxFirstAttempt` (`core/src/tools/sandboxing.rs:269-278`). Network and writes outside cwd work.
- **Exception.** If the filesystem policy has deny-read entries, "a command allow rule does not authorize removing filesystem restrictions" (`sandboxing.rs:259-267`).
- **Detection.** Sandboxed commands get `CODEX_SANDBOX=seatbelt` and `CODEX_SANDBOX_NETWORK_DISABLED=1` (`core/src/spawn.rs:21-26`). **`dispatch run|wait` must detect these and fail fast** with "rule not matched: use the absolute launcher path, single quotes, no `cd`/pipes/`$`".

### Recommended rule text (`~/.codex/rules/dispatch.rules`)

Generated by `setup` with the real absolute path. Validated with `codex execpolicy check`; the `match`/`not_match` examples are checked at load time, and a violating example makes the whole file fail to parse.

```python
# Dispatch (https://github.com/dragonfly25/dispatch). Trust grant: lets ONLY these
# launcher subcommands run outside the Codex sandbox (network + writes to ~/.dispatch).
prefix_rule(
    pattern = ["/Users/<you>/.dispatch/bin/dispatch", ["run", "wait", "cancel", "status"]],
    decision = "allow",
    justification = "Dispatch launcher: delegates tasks to other providers; needs network and writes under ~/.dispatch",
    match = [
        ["/Users/<you>/.dispatch/bin/dispatch", "run", "--json", "fix the bug"],
        ["/Users/<you>/.dispatch/bin/dispatch", "wait", "abc", "--timeout", "280"],
    ],
    not_match = [
        ["/Users/<you>/.dispatch/bin/dispatch", "install"],
        ["/Users/<you>/.dispatch/bin/dispatch", "setup"],
        ["dispatch", "run"],
        ["/tmp/evil/dispatch", "run"],
    ],
)
```

**Skill guidance needed (WP27).** Call the launcher by its absolute path, never `~`. No `cd …&&`, pipes, `$`, backticks, redirects or heredocs. Quote the task with single quotes, or with double quotes when it contains `'` but no `$`, backtick, `\` or `"`. Otherwise write it with apply_patch to `.dispatch/inbox/<id>.md` and pass `--prompt-file`. Per-session and per-day caps cannot be expressed in rules; they belong in `dispatch run`, keyed on `CODEX_THREAD_ID`, which Codex exports to shell commands (`core/src/exec_env.rs`).

## Q3. Hard mode: PreToolUse on `spawn_agent`

### Payloads (real)
- **Session-only hook config works.** `-c 'hooks.PreToolUse=[{matcher="…",hooks=[{type="command",command="…"}]}]'` with `--dangerously-bypass-hook-trust` (spike only). It needs no files.
- **SessionStart** (`hook_session_start.json`): `session_id, transcript_path, cwd, hook_event_name, model, permission_mode, source`. **`model` is present** (`gpt-6-luna`); `permission_mode` was `bypassPermissions` in exec.
- **SubagentStart** (`hook_subagent_start.json`): adds `turn_id, agent_id, agent_type`. It cannot block.
- **PreToolUse** (`hook_pre_tool_use_spawn_agent_v2.json`):
  - `tool_name: "collaborationspawn_agent"`
  - `tool_input: {task_name, message: "<ENCRYPTED>"}`

### Finding: current models use multi-agent V2, and the plan's assumptions break
- **Matcher.** `codex debug models` shows `multi_agent_version: "v2"` for gpt-6.1-sol, gpt-6-astra, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol and gpt-5.6-terra (v1 only for gpt-reserve and gpt-5.6-luna). V2 tools live in namespace `collaboration`. The hook name is the flat `namespace+name` with no separator, i.e. `collaborationspawn_agent` (`core/src/tools/mod.rs:50-64`). The canonical `spawn_agent` name and its `Agent` alias are only applied for the default and V1 namespaces (`core/src/tools/registry.rs:1129-1135`). **A matcher of `spawn_agent` or `Agent` does not fire on V2** (fixture `spawn_agent_v2_unmatched_hook`). Use `spawn_agent|collaborationspawn_agent|Agent`. A matcher made of `[A-Za-z0-9_|]` is an exact alternation; anything else is a regex.
- **Encrypted message.** The V2 `message` the model emits is an encrypted blob (`gAAAAA…`). **The hook cannot read the task.** So the plan's "deny + detach" (hook starts `dispatch run` with the task text) is impossible on V2.
- **(b) `updatedInput` proxy fails on V2.** I rewrote `message` to plaintext ("run `echo PROXY-<token>` and return stdout"). The child errored with `400 invalid_encrypted_content`, and the parent got `Agent errored: …` (fixture `spawn_agent_v2_hook_updated_input`). The handler treats any non-direct-plaintext message as `AgentMessage::Encrypted` (`core/src/tools/handlers/multi_agents_v2.rs:54-66`). On V1 models `updatedInput` would plausibly work, since `with_updated_function_input` is supported, but this was not tested.
- **(a) Deny with a reason works.** Fixture `spawn_agent_v2_hook_deny`. The model sees the tool error `Tool call blocked by PreToolUse hook: <reason>. Tool: collaborationspawn_agent` (`core/src/hook_runtime.rs`, `registry.rs:857-870`) and acts on it.
- **Deny + redirect works end-to-end** (fixture `spawn_agent_v2_hook_deny_redirect`).
  - **Setup.** The deny reason said: "Do not retry spawn_agent. Instead run `<launcher> run --detach --json '<task>'` then `<launcher> wait <id> --timeout 100`…".
  - **What the model did.** It immediately ran `/bin/zsh -lc "<launcher> run --detach --json 'Write a haiku about git.'"`, then `<launcher> wait dsp_FAKE1 --timeout 100`. It returned the (fake) result as its answer.
  - **Rule fit.** The script shape (single-quoted task, absolute path, no operators) is exactly what the rule matches.

### Recommendation for UC3: `deny_redirect` (a new variant of deny_detach)
- **Mechanism.** PreToolUse `matcher: "spawn_agent|collaborationspawn_agent|Agent"` returns `permissionDecision:"deny"`, with a reason that tells the model to run the absolute launcher itself (`run --detach --json '<task>'`, then `wait`). The hook stays dumb: it never needs the task text, never spawns anything, and fits the 80 ms budget.
- **Why not proxy_subagent.** It is broken on V2 (encrypted messages). Even on V1 it doubles model cost (a sub-agent that only runs a shell command) and hides the delegation from the user.
- **Why not hook-side detach.** The task text is unreadable on V2.
- **Residual risks.**
  - The model may ignore the instruction. Mitigate with the skill plus SessionStart `additionalContext`.
  - The rule must match. Mitigate with sandbox detection in the launcher.
  - Hooks need `/hooks` trust once. Trust is stored as `[hooks.state."<key>"].trusted_hash` in `~/.codex/config.toml` (`config/src/hook_config.rs:30-38`); Dispatch must not write it itself.

### Shell tool timeout → `wait` timeout for the Codex host
- The default shell for these models is unified exec (`shell_type: "unified_exec"`).
- `timeout_ms` is ignored, and there is no completion timeout (`core/src/unified_exec/preparation.rs:245`).
- `exec_command` returns after `yield_time_ms` (default 10 000, clamped 250–30 000; `unified_exec/mod.rs:66-70`) with a session id, while the process keeps running. The model polls with `write_stdin`, and an empty poll can wait up to `background_terminal_max_timeout` = 300 000 ms (`config/mod.rs:4141`).
- The legacy one-shot shell (unified exec disabled) defaults to 10 000 ms (`core/src/exec.rs:63`).
- **Recommendation:** Codex host `wait --timeout 280` (just under one 300 s poll) and exit 75 when still running. The skill says "if exit 75, run the same wait again". If unified exec is disabled, `doctor` warns and the default drops to 8 s.

## Quota-exhaustion shape (synthetic fixture `quota_exhausted`)

- **Emission.** `{"type":"error","message":…}` followed by `{"type":"turn.failed","error":{"message":…}}`, exit 1 (`exec/src/event_processor_with_jsonl_output.rs:449-558`). The real `turn.failed` shape is in `invalid_model_turn_failed`.
- **Text.** Messages come from `protocol/src/error.rs:740-835` and start with `You’ve hit your usage limit` (U+2019 apostrophe). The suffix depends on the plan. Workspace variants: `Your workspace is out of credits…` and `You hit your spend cap…`.
- **Rule.** Match `/(you[’']ve hit your usage limit|out of credits|hit your spend cap)/i` on `turn.failed.error.message` and classify the run as `quota_exhausted`. Then confirm via app-server `account/rateLimits/read`.
