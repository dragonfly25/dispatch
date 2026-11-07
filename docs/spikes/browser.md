# Spike: an isolated browser for delegated agents (2026-11-07)

Goal: let a delegated builder agent whose Claude Code definition lists the desktop app's browser
tools (`mcp__Claude_Browser__*`) run on codex with a Dispatch-managed browser: Playwright MCP
driving the installed Google Chrome with a temporary empty profile. Never the user's Chrome
profile, cookies or logins; never a CDP attach to a running browser. Real tools: codex 0.167.0,
`@playwright/mcp@0.0.84` (installed with `npm install --ignore-scripts` into temp dirs; no browser
download), Google Chrome on macOS, Node 22. No user config was touched: codex runs used
`--ignore-user-config`, Dispatch runs used a temp `HOME` and `DISPATCH_HOME`.

## Playwright MCP 0.0.84 (direct, a minimal stdio MCP client, no codex)

| Question | Result |
|---|---|
| Install size and contents | `@playwright/mcp`, `playwright`, `playwright-core` `1.65.0-alpha-2026-10-30` (3 packages, ~19 MB); the lockfile has no `hasInstallScript`. Integrities are pinned in `src/browser/index.ts`. |
| Default tools | 25: `browser_close, resize, console_messages, handle_dialog, emulate_media, evaluate, file_upload, drop, find, fill_form, press_key, type, navigate, navigate_back, network_requests, network_request, run_code_unsafe, take_screenshot, snapshot, click, drag, hover, select_option, tabs, wait_for`. |
| `browser_run_code_unsafe` | A `core` capability tool ("executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent"); no flag or capability turns it off. The server runs outside the codex shell sandbox, so it must not be offered (see codex below). |
| Which Chrome, which profile? | `--isolated --headless --browser chrome` launched `/Applications/Google Chrome.app` with `--user-data-dir=<TMPDIR>/playwright_chromiumdev_profile-*`, `--remote-debugging-pipe` (no port) and `--use-mock-keychain` (sampled with `ps` while open); the temp profile is removed on close. Nothing is written under `~/Library/Application Support/Google/Chrome`, and `~/Library/Caches/ms-playwright-mcp` (the persistent-profile root) is never created. |
| Stray files outside the run | An empty registry dir `~/Library/Caches/ms-playwright/b`, from `os.homedir()` (`PLAYWRIGHT_BROWSERS_PATH` does not move it). With the server's `HOME` set to a scratch dir it lands there and the user's cache is unchanged. A per-run `TMPDIR` is not usable: Playwright's socket path then exceeds the Unix limit (`Socket directory path is too long`). Chrome leaves an empty `com.google.Chrome.chrome_chrome_url_fetcher_*` dir in the system TMPDIR. |
| `--output-dir` | Snapshots (`page-*.yml`), console logs and screenshots without a file name go there; without it they land in `.playwright-mcp/` under the cwd (the worktree). |
| `--allowed-origins "http://127.0.0.1:47821;http://localhost:47821"` | The listed origin loads; `http://127.0.0.1:47822/` fails with `net::ERR_BLOCKED_BY_CLIENT`. The help says it is not a security boundary and does not affect redirects. |
| `file://` | `file:///etc/hosts` → `Access to "file:" protocol is blocked` (default; `--allow-unrestricted-file-access` is never passed). |

## codex 0.167.0

Offline (temp `CODEX_HOME` without credentials, so no model call): `--strict-config` accepts
`mcp_servers.<name>.enabled_tools`, `disabled_tools`, `cwd`, `env` (inline table),
`startup_timeout_sec` and `tool_timeout_sec`; an unknown key fails at load
(`unknown configuration field mcp_servers.b.bogus_key`).

Live runs (3 allowed, `gpt-6-luna`, effort low, workspace-write, Dispatch's isolation flags):

| Run | Setup | Result (from the JSON events, not only the model's words) |
|---|---|---|
| earlier spike (2 runs, network off) | `dispatch_browser` server, no network | The MCP server runs outside the shell sandbox and reached a host-side server on 127.0.0.1; the shell could not listen on any port (`listen EPERM`). |
| 1 (raw codex) | `-c sandbox_workspace_write.network_access=true`, `enabled_tools` allowlist (22 tools), server `env={HOME=<scratch>}`, `cwd=<scratch>` | The tool list had the 22 allowlisted tools and **no `browser_run_code_unsafe`**. A dev server started with `node server.mjs 47831 > log 2>&1 &` was gone before the next command (`kill: no such process`, empty log): a job backgrounded with `&` dies when its command returns, so the browser got `ERR_CONNECTION_REFUSED`. |
| 2 (Dispatch, this branch) | `dispatch run --handoff` from a real hook handoff, `network: delegated-agents`, browser installed by `dispatch setup --refresh --yes` | Server started as a long-running command (`exec node server.mjs 47831 > "$TMPDIR/…log" 2>&1`, no `&`): codex kept it in a background exec session. The wait loop saw it up, `browser_navigate` + `browser_snapshot` returned `heading "hello-47831"`. `kill "$(cat pidfile)"` from another command was **denied by the sandbox**; the agent then stopped the session itself and curl confirmed the port closed. |
| 3 (Dispatch, final note) | as run 2, the note says to stop with Ctrl-C to the session | Start, wait, navigate, snapshot (`hello-47831`), stop via the session, curl `exit 7` (closed). Tool list again without `browser_run_code_unsafe`. After the run: port 47831 not listening, user's `~/Library/Caches/ms-playwright` unchanged, no `ms-playwright-mcp`, snapshot and console log in `<runDir>/attempt-1/browser/`, the registry dir in `<runDir>/attempt-1/browser-home/`, empty patch. |

Chrome launched by Playwright from codex's MCP process on macOS: no sandbox or permission errors
(runs 1-3).

## Decisions

- Provisioning: `dispatch setup` runs the npm next to Dispatch's node: `npm install --prefix
  ~/.dispatch/tools/playwright-mcp --ignore-scripts --save-exact @playwright/mcp@0.0.84` with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, as a recorded `cli-command` (refresh reinstalls a missing
  copy, `uninstall --global` removes the dir). Never as root. Every use checks the pinned version
  and the three lockfile integrities.
- Codex invocation: `-c mcp_servers.dispatch_browser.*` with node + the pinned `cli.js`,
  `--isolated --headless --browser chrome --output-dir <attempt>/browser --allowed-origins
  <localhost and 127.0.0.1 for the launch.json ports, else any port>`, `env={HOME=<attempt>/browser-home}`,
  `cwd=<attempt>/browser`, `enabled_tools=[22 tools]` (no `run_code_unsafe`, `file_upload`, `drop`),
  `default_tools_approval_mode="approve"`. Worktree runs only; codex targets only.
- Eligibility: only with the browser enabled, installed and Chrome found **and** the sandbox
  network for the agent (`network: delegated-agents` or `all`); the agent must list Bash (dev
  servers run in its shell). Otherwise it stays on Claude with the reason in `doctor`.
- The translation note tells the agent to start `.claude/launch.json` servers as long-running
  commands without `&`, wait for the port, browse, and stop them with Ctrl-C to the session
  (not `kill`, which the sandbox denies across commands) before finishing.
