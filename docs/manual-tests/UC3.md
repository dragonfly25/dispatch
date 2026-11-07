# UC3: the same from Codex, hard interception (real accounts)

**Spec §11 UC3, as amended by the plan.** The client is Codex. A `PreToolUse` hook intercepts the
native sub-agent spawn and **denies** it; the deny reason tells the model to run
`<launcher> run --detach --json --task '<task>'` and then `<launcher> wait <runId>` (mechanism
`deny_redirect`; `proxy_subagent` was dropped because multi-agent V2 encrypts the spawn message).
**Verifica:** Codex's native sub-agent does not start; the result arrives as a tool result.

Automated twin: `test/e2e/uc03.test.ts`. It covers the launcher side (detached run, idempotent
repeat, `wait` exit 75, `CODEX_SANDBOX` refusal) and the Codex host files and hook replies (setup
output, `deny_redirect` reason, silence outside trusted repos, heartbeat) against fake CLIs. This
script is the only place that proves what the real Codex does with those files.

## What Dispatch writes for Codex (user scope; nothing in the repo)

| File | Content | Why you should read it |
| --- | --- | --- |
| `~/.agents/skills/dispatch/SKILL.md` | How to call the launcher | Codex loads it as a skill |
| `~/.codex/hooks.json` | Two entries appended: `SessionStart` and `PreToolUse` (matcher `spawn_agent\|collaborationspawn_agent\|Agent`) | Hooks run commands; Codex asks you to trust them |
| `~/.codex/rules/dispatch.rules` | `prefix_rule` allowing only `<launcher> run\|wait\|cancel\|status` outside the sandbox | **A trust grant**: it lets those launcher commands run with network access and write under `~/.dispatch`. Setup shows it before writing it |

Dispatch never writes `[hooks.state...]` trust entries into `~/.codex/config.toml`; Codex does that
when you approve the hooks in `/hooks`.

## Prerequisites

- `codex` 0.167.x logged in (`codex login status`); `claude` logged in, as the external provider
  that will receive the task (the host is Codex, so Dispatch never sends the task back to Codex).
- A scratch repo with a small module (the same as in [UC2](UC2.md), under a new name):

  ```sh
  mkdir -p ~/dispatch-scratch/uc3/src && cd ~/dispatch-scratch/uc3
  git init -q -b main
  printf 'export function validatePassword(pw: string): boolean {\n  return pw.length >= 12;\n}\n' > src/auth.ts
  printf 'export const add = (a: number, b: number) => a + b;\n' > math.ts
  git add -A && git commit -qm "scratch" && dispatch install
  ```
- A backup of the `~/.codex/hooks.json` and `~/.codex/config.toml` hashes (see
  [README](README.md#ground-rules)).
- Multi-agent enabled in your Codex (the default for current models): `codex features list` shows
  `multi_agent` or `multi_agent_v2` as enabled.

## Steps

### 1. Setup and inspect

```sh
dispatch setup          # review the plan and the "Trust grants" section, answer y
cat ~/.codex/hooks.json
cat ~/.codex/rules/dispatch.rules
shasum -a 256 ~/.codex/config.toml      # note it: setup must not change it
```

Expected (hard mode is on by default; `hosts.codex.hard: false` in `~/.dispatch/config.yaml` keeps only the SessionStart context): `hooks.json` has the two Dispatch entries, each command starting with absolute paths to
`node` and `hook.mjs` (no reliance on PATH); your own entries and comments are untouched. The rules
file's `pattern` is the absolute launcher path only. `config.toml` is unchanged.

### 2. Trust the hooks (this is yours to do)

```sh
cd ~/dispatch-scratch/uc3 && codex
```

In the Codex TUI run `/hooks`, review the two Dispatch hooks, and trust them. Dispatch cannot and
does not do this for you. Until you do, Codex ignores the hooks and the native sub-agent still
works (step 4 checks this).

`dispatch doctor` warns about untrusted hooks; after trusting, the hooks heartbeat check is `ok`.

### 3. The rule matches inside Codex

In the Codex session ask: "Run `<launcher> status` and show me the output" (use the absolute path
from the rules file).

Expected: it runs **without an approval prompt**, shows the quota table, and does not fail with
network or sandbox errors. If it fails with "rule not matched" or the output says
`CODEX_SANDBOX is set`, the rule did not match: the command had a pipe, `cd`, `$` or a relative
path. `dispatch doctor --from-host`, run from inside the session, names the cause.

### 4. Negative control: before the hooks are trusted

Skip if you already trusted them. In a fresh Codex session **without** step 2, ask: "Spawn a
sub-agent to add a comment to math.ts." Expected: Codex spawns its native sub-agent (the hook is not
active). This shows the denial in step 5 is Dispatch's doing.

### 5. Hard interception

With the hooks trusted, in a new Codex session in the scratch repo ask:

> Spawn a sub-agent to write a docstring for every function in src/auth.ts, then apply its result.

Expected, in order:
1. Codex tries `spawn_agent`; the call is **denied** with a message starting
   `Dispatch: native sub-agents are redirected to Dispatch in this repository. Do not retry spawn_agent.`
   No native sub-agent thread appears (**Verifica 1**).
2. Codex runs `<launcher> run --detach --json --task '...'` (no approval prompt), then
   `<launcher> wait <runId> --timeout 280`. The wait can take minutes; Codex keeps polling the same
   shell session until it exits (exit 75 means "still running", it repeats).
3. The result arrives as the tool result of `wait` (**Verifica 2**): provider `claude`, a summary in
   an `EXTERNAL_AGENT_OUTPUT` block, a patch path. Codex reviews the patch and applies it itself.

### 6. Verify

```sh
dispatch logs                           # one new run, instance claude (not codex)
dispatch logs --task <runId>            # decision: host codex excluded; targets claude
```

- Exactly one run for the task, even if Codex repeated the `run` command (the repeat returns the
  same `runId`: idempotent per session and task).
- `git status --porcelain` shows only what Codex itself applied.
- `ls ~/.dispatch/worktrees` has no leftover directory for the finished run (unless you configured
  `worktree.keep`); `dispatch gc` would remove old ones.

## Pass criteria

- Step 3: the launcher runs inside Codex without a prompt.
- Step 4 (if run): native spawn works without the hooks.
- Step 5: denial message, no native sub-agent, result delivered through `wait`.
- Step 6: one run, on Claude.

## If it does not work

| Symptom | Check |
| --- | --- |
| Native sub-agent still starts | `/hooks` shows the Dispatch hooks as trusted? Matcher includes the tool name your Codex uses (V2 reports `collaborationspawn_agent`)? |
| Denied, but the model never calls the launcher | Does the skill exist (`~/.agents/skills/dispatch/SKILL.md`)? Open the deny reason in the transcript |
| `run` asks for approval | The command shape differs from the rule (compound command, `cd`, `$`); see `dispatch doctor --from-host` |
| Exit 3 "CODEX_SANDBOX" | Same: the rule did not match, so the launcher ran sandboxed and refused |

## Cleanup

```sh
dispatch uninstall                # repo part
dispatch uninstall --global       # hooks.json entries, rules file, skill, launcher
shasum -a 256 ~/.codex/hooks.json ~/.codex/config.toml
```

Compare with the step 1 hashes. `hooks.json` must be byte-identical to before `setup` (including your
comments). `config.toml` may differ **only** by `[hooks.state."..."]` entries that Codex itself wrote
when you trusted the hooks in step 2; remove those through `/hooks` if you want them gone.

## Results

| Date | Tester | dispatch | claude | codex | agy | OS | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |
