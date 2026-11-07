# UC1: first setup on an existing repo (real accounts)

**Spec §11 UC1.** A developer with Claude Code as the client, and Codex and Antigravity logged in,
installs Dispatch. **Verifica:** no pre-existing file is modified; `git status` shows only
`.dispatch/` (plan deviation 3: host integration lives at user scope, so there is no edit of the
repo's `.claude/settings.json`); `doctor` passes with a test task per provider; `status` shows
three quotas.

Automated twin: `test/e2e/uc01.test.ts` (fake CLIs). This script adds the real Claude plugin
install, real `doctor --live` and real quota readers.

## Prerequisites

- `claude` (2.1.301 or a later 2.1.x), `codex` (0.167.x) and `agy` (1.5.x) installed and logged in:
  `codex login status` says "Logged in", `agy` answers `agy -p="/usage"`, and `claude` starts
  without a login prompt. Antigravity is optional: skip the lines marked (agy) if you do not use it.
- A scratch repo with an existing Claude setup, so there is something to leave alone:

  ```sh
  mkdir -p ~/dispatch-scratch/uc1 && cd ~/dispatch-scratch/uc1
  git init -q -b main
  printf 'export const add = (a: number, b: number) => a + b;\n' > math.ts
  printf '# Rules\nBe brief.\n' > CLAUDE.md
  mkdir -p .claude/agents
  printf '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n' > .claude/settings.json
  printf -- '---\nname: reviewer\ndescription: reviews code\n---\nReview code.\n' > .claude/agents/reviewer.md
  git add -A && git commit -qm "scratch"
  find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 > /tmp/uc1-before.sha256
  ```

- The backup of the user-level host files (see [README](README.md#ground-rules)).
- `dispatch` is not set up yet: `ls ~/.dispatch` does not exist (or you accept that `setup` finds an
  existing one and says what it keeps).

## Steps

### 1. Setup (once per user)

```sh
dispatch setup
```

Expected:
- A plan lists the files it will create (the launcher `~/.dispatch/bin/dispatch`, the plugin under
  `~/.dispatch/hosts/claude-code/`) and the two commands it will run:
  `claude plugin marketplace add ... --scope user` and
  `claude plugin install dispatch@dispatch-local -s user`.
- A **Trust grants** section names the Claude plugin ("installs the Dispatch plugin (a sub-agent and
  a SessionStart hook) for every Claude Code session of this user"). Read it, then answer `y`.
- `Hosts detected: claude-code` (and `codex` once the Codex host module is installed).
- The wizard asks four questions (the client you mainly use, the plan of each provider, the
  starting strategy, the autonomy of delegated agents) and writes a commented
  `~/.dispatch/config.yaml` (mode 0600; an existing file is never overwritten). Answer them with
  your real plans. For Antigravity answer yes only after reading the disclosure it prints; it is
  probed only after you accept. Scripted equivalent:
  `dispatch setup --non-interactive --yes --host claude-code --plan claude=max5x --plan codex=plus --profile balance --autonomy worktree`.
- Last line: `Setup done: N applied, 0 unchanged, 0 removed.`

Check: `claude plugin list` shows `dispatch@dispatch-local` enabled.

### 2. Install in the repo

```sh
cd ~/dispatch-scratch/uc1
dispatch install
```

Answer the confirmation. Expected: `Installed: 10 file(s) in .dispatch/ (trusted).`

**Verifica (diff):**

```sh
git status --porcelain      # exactly:  ?? .dispatch/
git diff                    # empty
find . -path ./.git -prune -o -path ./.dispatch -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 | diff - /tmp/uc1-before.sha256 && echo "existing files unchanged"
```

`.claude/settings.json`, `.claude/agents/reviewer.md`, `CLAUDE.md` and the repo's `.gitignore` are
byte-identical.

### 3. Doctor

```sh
dispatch doctor
```

Expected: exit code 0 and no line starting with `FAIL`. Warnings that are fine here:
`claude.login` (Claude Code has no quota-free login check), `claude-code.permission-rule` (it prints
two `Bash(...)` rules you may add to `permissions.allow` yourself; Dispatch never edits your
permissions), the Antigravity terms-of-service note. Every `*.binary`, `*.version`, `*.flags`,
`*.fixtures` and `*.quota` line is `ok`; `claude-code.plugin` is `ok`; `repo.trust` is `ok`.

Then, with the CLIs idle:

```sh
dispatch doctor --live
```

This runs one tiny task per provider other than the host (here, from a plain terminal, all three)
and asks for confirmation first. Expected: `live.claude`, `live.codex` (and `live.antigravity`)
are `ok`. This is the spec's "three test tasks succeeded".

### 4. Status

```sh
dispatch status
```

Expected: three blocks, `claude`, `codex`, `antigravity`. Codex shows `5h` and `weekly` windows
with `[real]` and source `codex-app-server`; Antigravity shows its weekly buckets from `agy-usage`;
Claude shows `unknown` until Claude Code has reported a rate-limit event (its quota reader is
passive), or a window if it already has.

### 5. The plugin in a Claude Code session

```sh
cd ~/dispatch-scratch/uc1 && claude
```

In the session run `/agents`: `dispatch:dispatch` is listed. Ask: "What does the Dispatch policy in
your context say about delegating tasks?" Expected: the answer names the active profile and says
delegable tasks go to Codex and tasks no rule delegates stay on the host (this is the SessionStart
hook's `additionalContext`; the repo is trusted because `install` trusted it).

## Pass criteria

- Step 2: the three `Verifica` commands behave as stated.
- Step 3: `doctor` exits 0 and `doctor --live` passes for every provider you use.
- Step 4: every enabled provider is listed.
- Step 5: the sub-agent exists and the policy is in the session.

## Cleanup

```sh
cd ~/dispatch-scratch/uc1 && dispatch uninstall && git status --porcelain   # empty
dispatch uninstall --global
rm -rf ~/dispatch-scratch/uc1
```

Compare `~/dispatch-manual-backup/before.sha256` with the same `shasum` of the host files: all equal
(UC14 on real files).

## Results

| Date | Tester | dispatch | claude | codex | agy | OS | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |
