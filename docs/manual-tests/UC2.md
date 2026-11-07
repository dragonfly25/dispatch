# UC2: automatic delegation from Claude Code, soft mode (real accounts)

**Spec §11 UC2.** In a Claude Code session on Opus, the user asks "write the tests for the auth
module". The injected context says test tasks are delegated with the `preserve` profile. The
orchestrator calls the `dispatch` sub-agent, which runs the launcher; the router picks Codex, the
task runs in a worktree, a patch and a summary come back; the orchestrator reads the summary,
applies the patch, runs the tests and reports. **Verifica:** the log has the winning rule; `status`
shows Codex consumption; there is no `claude -p` call.

Automated twin: `test/e2e/uc02.test.ts` (hook, sub-agent command shape, `run --detach` + `wait`, log,
status, zero `claude` runs, all with fake CLIs). This script proves the real Claude Code actually
follows the injected policy and the real sub-agent works.

## Prerequisites

- [UC1](UC1.md) passed: `dispatch setup` done, Claude plugin enabled, Codex logged in.
- A scratch repo with something to test (the model needs a real module to write tests for):

  ```sh
  mkdir -p ~/dispatch-scratch/uc2/src && cd ~/dispatch-scratch/uc2
  git init -q -b main
  cat > src/auth.ts <<'EOF'
  export function validatePassword(pw: string): boolean {
    return pw.length >= 12 && /[0-9]/.test(pw) && /[A-Z]/.test(pw);
  }
  export function hashToken(token: string): string {
    return token.split("").reverse().join("");
  }
  EOF
  printf '{ "name": "uc2", "scripts": { "test": "node --test" } }\n' > package.json
  git add -A && git commit -qm "scratch"
  dispatch install --profile preserve
  ```
- Claude Code running Opus (check with `/model`). The session model is not visible to Dispatch
  (Claude's SessionStart has no model field), so the external agent gets the default tier
  (`balanced`); the point of this test is the routing and the invariants, not the model name.
- Optional: add the two rules `dispatch doctor` prints (`claude-code.permission-rule`) to
  `permissions.allow` in `~/.claude/settings.json`, so the sub-agent is not interrupted by
  permission prompts. Without them, approve the two `Bash(<launcher> run ...)` and
  `Bash(<launcher> wait ...)` prompts when they appear.

## Steps

### 1. Before

```sh
dispatch status          # note the Codex "5h" and "weekly" remaining %
dispatch logs            # note the last run id, if any
```

### 2. Delegate

In a second terminal, from the scratch repo, start the session and give this prompt:

```sh
cd ~/dispatch-scratch/uc2 && claude
```

> Write the unit tests for src/auth.ts. This is a self-contained task, so delegate it with Dispatch.

Expected, in order:
1. Claude calls the `dispatch:dispatch` sub-agent (shown as an Agent tool call).
2. The sub-agent runs `<launcher> run --detach --json --task '...' --task-type test --path src/auth.ts`,
   gets a `runId`, then runs `<launcher> wait <runId> --timeout 100` (repeating while the exit code
   is 75).
3. Claude receives a reply built from the result: the provider (`codex`), the summary inside an
   `EXTERNAL_AGENT_OUTPUT` block, the patch path, and the line "Dispatch never applies patches".
4. Claude reads the patch, applies it itself (`git apply` or an edit), runs `npm test`, and reports.

### 3. Verify (second terminal)

```sh
cd ~/dispatch-scratch/uc2
dispatch logs                     # newest run: instance codex, outcome success, patch yes
dispatch logs --task <runId>      # see below
dispatch status                   # Codex remaining % dropped (or the estimate rose)
pgrep -fl 'claude .*-p' || echo "no claude -p process"
```

- `dispatch logs --task <runId>` shows `Decisions (1)` with
  `delegate fallback -> codex: ... (profile preserve rule preserve-delegate-all)`. That is the winning
  rule (**Verifica 1**). The events list shows only Codex work.
- `dispatch status` shows the Codex windows changed compared to step 1; with the real app-server
  reader they are `[real]`, so a small change is expected (**Verifica 2**). If you want to see the
  estimator instead, set `quota.readers.codex.enabled: false` in `~/.dispatch/config.yaml` and
  repeat: the window becomes `[estimated]` with source `estimator`.
- No `claude -p` is started by Dispatch (**Verifica 3**): the run log has no Claude attempt
  (`instance claude` never appears), and `pgrep` finds nothing while Dispatch is idle. Dispatch
  never invokes the host's own account.

### 4. Reproduce the decision

```sh
dispatch explain --replay <decisionId>      # id printed by `dispatch logs --task`
```

Expected: `IDENTICAL`.

## Pass criteria

- Claude chose to delegate and used the sub-agent (not its own sub-agent for the tests).
- The run ran on `codex`, produced a patch, and the working tree changed only because Claude applied
  it (check `git status` before applying: clean).
- Steps 3 and 4 as described.

## If it does not work

| Symptom | Check |
| --- | --- |
| Claude writes the tests itself | `/agents` lists `dispatch:dispatch`? `claude plugin list` shows it enabled? Is the repo trusted (`dispatch status` says "repo policy trusted")? The session started after `install`? |
| Permission prompts every time | Add the two rules from `dispatch doctor` to your `permissions.allow`. |
| `wait` never ends | `dispatch logs --task <runId>` and `dispatch doctor --from-host` (run it from inside the session) |
| Run goes to Claude's other account | Expected only if you configured one (see [UC12](UC12.md)) |

## Cleanup

```sh
cd ~/dispatch-scratch/uc2 && git checkout -- . && dispatch uninstall && cd ~ && rm -rf ~/dispatch-scratch/uc2
```

Keep `dispatch setup` in place if you go on with [UC3](UC3.md) or [UC12](UC12.md); otherwise
`dispatch uninstall --global`.

## Results

| Date | Tester | dispatch | claude | codex | agy | OS | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |
