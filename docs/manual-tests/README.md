# Manual acceptance tests

Spec §12 criterion 1: every use case passes with automated tests (fake CLIs) where possible and
with documented manual tests where a real account is needed. The automated suite
(`pnpm acceptance`, tags `[UC1]` to `[UC14]`) proves everything that does not need a login. These
scripts cover the four parts that cannot be faked:

| Script | Use case | What only a real account can show |
| --- | --- | --- |
| [UC1.md](UC1.md) | First setup on an existing repo | `setup`, `install`, `doctor` and `doctor --live` against the three real CLIs and a real Claude Code plugin install |
| [UC2.md](UC2.md) | Automatic delegation from Claude Code | A real Claude Code session delegating through the `dispatch` sub-agent to a real Codex, with no `claude -p` call |
| [UC3.md](UC3.md) | The same from Codex (hard interception) | The Codex `/hooks` approval, the rules file, and the `deny_redirect` of a native `spawn_agent` |
| [UC12.md](UC12.md) | Second account of the same provider | A second Claude login in its own `CLAUDE_CONFIG_DIR`, used from a session on the first account and the other way round |

## Ground rules

- **Use a scratch repository**, not a project you care about: a fresh `git init` with two or three
  small files. Dispatch never applies patches or commits, but the agents it starts do write (in
  worktrees outside your repo).
- **Quota is spent.** `doctor --live` uses a few requests per provider; a delegated task uses what
  the task needs. Pick small tasks.
- **Dispatch never reads, copies or prints credentials**, and the steps never ask you to. You log
  in to each CLI yourself, with the CLI's own login command. If a step asks you to paste a token
  anywhere, stop: the script is wrong.
- **Back up what Dispatch edits** before `dispatch setup`, so you can compare bytes after
  `dispatch uninstall --global`:

  ```sh
  mkdir -p ~/dispatch-manual-backup
  for f in ~/.claude/settings.json ~/.codex/hooks.json ~/.codex/config.toml; do
    [ -f "$f" ] && shasum -a 256 "$f" >> ~/dispatch-manual-backup/before.sha256
  done
  ```

  (The `shasum` line is enough to compare; copy the files too if you want to diff them.)
- Commands use `dispatch`. If it is not on your PATH, replace it with
  `node /path/to/dispatch/dist/cli.mjs` after `pnpm build`.
- Record the versions you tested: `dispatch --version`, `claude --version`, `codex --version`,
  `agy --version`. The CLIs change often; a failure on an untested version is information, not
  necessarily a bug. `dispatch doctor` prints whether each version is inside the tested range.

## Recording a result

Every script ends with a results table. Add one row per run:

| Column | Content |
| --- | --- |
| Date | `YYYY-MM-DD` |
| Tester | your name or handle |
| dispatch | `dispatch --version` (and the commit if built from source) |
| claude / codex / agy | the versions you ran |
| OS | e.g. macOS 15.4 arm64 |
| Result | `PASS`, `FAIL` or `PARTIAL` (list which steps in Notes) |
| Notes | anything unexpected; link to a log (`dispatch logs --task <id>`) or an issue |

A use case counts as accepted for a release when its latest row for the release candidate is
`PASS`. Keep failed rows: they are the history of what broke.

## Cleaning up

Each script has a cleanup section. In every case the last step is `dispatch uninstall --global`
(after `dispatch uninstall` in the repo), followed by the byte comparison against the backup. That
comparison is itself part of UC14 on a real machine.
