# Spike: host integrations on native Windows

Date: 2026-11-13. Desk research only: no Windows machine was available, so nothing here was run
on Windows. Sources are the official docs and, where the docs are silent, the Codex source on
`main` (openai/codex, read 2026-11-13). Confidence is given per finding.

## a) Claude Code: which shell runs hook commands

- Shell form (`command` without `args`) runs through **Git Bash** on Windows, or **PowerShell**
  when Git Bash is not installed; a per-hook `shell: "bash" | "powershell"` field selects one
  explicitly. Source: [Hooks reference, "Exec form and shell form" and the `shell` field](https://code.claude.com/docs/en/hooks).
- **Exec form** (`args` set) spawns `command` directly with `args` as the argument vector: "There
  is no shell ... No shell tokenization happens on any platform". On Windows `command` must be a
  real executable (`node.exe` qualifies; `.cmd`/`.bat` shims do not). Absolute paths with spaces
  such as `C:\Program Files\nodejs\node.exe` are valid. Same page.
- `args` (exec form) was added in Claude Code **2.1.139** ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):
  "Added hook `args: string[]` field (exec form) that spawns the command directly without a
  shell"). Older versions ignore `args` and run `command` alone in a shell.
- A hook that fails to start (missing executable or script) is a non-blocking failure unless
  `onFailure: "block"` is set. Shell-form PreToolUse hooks **without Git Bash** count any exit
  code other than 0/2 as a failure that can block the tool call. Same hooks page.
- Without Git for Windows there is no Bash tool (the PowerShell tool replaces it); Git Bash is
  found automatically or via `CLAUDE_CODE_GIT_BASH_PATH`. Source: [Advanced setup, "Set up on Windows"](https://code.claude.com/docs/en/setup).

**Decision.** On Windows the plugin's `hooks.json` uses exec form:
`{"command": "<node.exe>", "args": ["<hook.mjs>", "claude-code", "<event>"]}`. No shell parses
the paths; `DISPATCH_DEPTH` is already handled inside the hook handlers (silent exit 0). Missing
node/hook files give a visible but non-blocking hook error instead of POSIX's silent exit.
The `dispatch` sub-agent (`tools: Bash`) needs the Bash tool, i.e. Git for Windows.

Confidence: high (documented).

## b) Codex: hook shell, rules matching on Windows

- Hooks: `hooks.json` command handlers take one `command` string; an optional `commandWindows`
  overrides it on Windows. No argv/exec form. Source: [Codex hooks](https://developers.openai.com/codex/hooks)
  (redirects to learn.chatgpt.com/docs/hooks).
- The shell is not documented. In the source, hooks run with the session's user shell
  (`core/src/session/mod.rs`: `shell.derive_exec_args("", false)`), which on Windows is always
  PowerShell (`shell-command/src/shell_detect.rs`: `if cfg!(windows) { get_shell(PowerShell) }`),
  i.e. `powershell.exe -NoProfile -Command <command>`; only when no shell is configured does
  `hooks/src/engine/command_runner.rs` fall back to `%COMSPEC% /C "<command>"`.
- Rules: `prefix_rule` compares the command's argv to `pattern`, exact prefix. Source: [Codex rules](https://developers.openai.com/codex/rules)
  (redirects to learn.chatgpt.com/docs/agent-configuration/rules). The page covers only
  `bash/zsh/sh -lc` splitting. The source (`core/src/exec_policy.rs`,
  `shell-command/src/command_safety/powershell_tree_sitter.rs`) also lowers a
  `powershell -Command <script>` body into argv on Windows, but only a small literal subset:
  unquoted bare words and single/double-quoted strings. The call operator `& 'C:\path with
  space\x' ...` is **opaque** (fixture `invocation_operator` → no parse), so a launcher path that
  needs quoting can never match a rule; a bare path without spaces or `$@'"(){}[];|&<>,` can.
- Even when the rule matches, the launcher on Windows is `dispatch.cmd`. Starting a batch file
  makes cmd.exe re-parse the arguments (`%*`), so a model-written `--task` containing `"` and `&`
  would run a command outside the sandbox (the "BatBadBut" class, CVE-2024-24576). That breaks
  docs/security.md T11 ("compound commands stay sandboxed").

**Decision.** No Codex rules file on Windows (fail closed). Setup prints a warning, doctor
(`codex.rules-launcher`, `--from-host`) says Codex-hosted runs stay sandboxed and need the user's
per-call approval to run outside the sandbox. The Windows skill and hook texts call
`& '<node.exe>' '<cli.mjs>' ...` (no batch file) with `--task-file`. Hook commands are a
PowerShell script: `$env:DISPATCH_DEPTH` and `Test-Path -LiteralPath` guards, single-quoted
literal paths, stdin forwarded via `$input` with `$OutputEncoding` set to UTF-8, `exit
$LASTEXITCODE`.

Possible follow-up: a rule on `["<node.exe>", "<cli.mjs>", ["run", ...]]` would avoid cmd.exe,
but matches only when both paths are bare words (no spaces; the default
`C:\Program Files\nodejs` has one). Not done.

Confidence: medium. The shell choice and the PowerShell lowering come from source, not docs,
and may change; `$input` forwarding to a native command was not run.

## c) Config locations on Windows

- Claude Code: `%USERPROFILE%\.claude` and `%USERPROFILE%\.claude.json` ([setup, "Remove
  configuration files"](https://code.claude.com/docs/en/setup)); `CLAUDE_CONFIG_DIR` overrides the
  directory as on POSIX.
- Codex: `~/.codex` (`%USERPROFILE%\.codex`), overridable with `CODEX_HOME`; rules in
  `<codex home>/rules/`, hooks in `<codex home>/hooks.json` ([Codex rules](https://developers.openai.com/codex/rules),
  [Codex hooks](https://developers.openai.com/codex/hooks), `core/src/exec_policy.rs`
  `default_policy_path`).
- Windows env names are case-insensitive; Dispatch reads `CLAUDE_CONFIG_DIR`/`CODEX_HOME` with
  `envGet` and accepts only drive/UNC-absolute values.

Confidence: high for the defaults, medium for env-var overrides (same code paths as POSIX).

## Other notes

- The Playwright MCP server resolves its registry under `%LOCALAPPDATA%\ms-playwright` on
  Windows (`os.homedir()` reads `USERPROFILE`, not `HOME`). Not verified.
- Installed Chrome: `%LOCALAPPDATA%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` +
  `\Google\Chrome\Application\chrome.exe` (Playwright's `chrome` channel lookup order).
- npm on Windows ships `npm-cli.js` at `<node dir>\node_modules\npm\bin\npm-cli.js`; setup runs it
  with node directly, never `npm.cmd`.
