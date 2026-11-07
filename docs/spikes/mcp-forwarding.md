# Spike: forwarding MCP servers to external agents (2026-11-07)

Goal: give a delegated agent the MCP servers its Claude Code agent definition uses, without loading
any other user configuration in the child and without copying secret values.

Setup: a 40-line stdio MCP server (Node, no dependencies) exposing one `echo` tool that returns
`echo:<message> var=<$DISPATCH_SPIKE_VAR>`. Runs in a scratch directory, with the real CLIs:
claude 2.1.301, codex 0.167.0. No user config was touched.

## codex 0.167.0 (two tiny `gpt-6-luna` runs)

Command (Dispatch's isolation flags plus the overrides):

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins --disable apps --disable memories -c agents.enabled=false \
  -C <dir> -m gpt-6-luna -c model_reasoning_effort=low -s read-only \
  -c 'mcp_servers.echo.command="/usr/local/bin/node"' -c 'mcp_servers.echo.args=["<dir>/echo-server.mjs"]' \
  -c 'mcp_servers.echo.env_vars=["DISPATCH_SPIKE_VAR"]' [-c 'mcp_servers.echo.default_tools_approval_mode="approve"'] -
```

with `DISPATCH_SPIKE_VAR=canary-123` in codex's own environment.

| Question | Result |
|---|---|
| Do `-c mcp_servers.<name>.*` overrides apply with `--ignore-user-config --strict-config`? | Yes: the `echo` server started and its tool was listed and called. |
| Does `--disable plugins` disable MCP servers? | No: the server loaded with plugins disabled. |
| Can a variable pass by NAME? | Yes: `env_vars=["DISPATCH_SPIKE_VAR"]` delivered `canary-123` to the server (`echo:ping var=canary-123`). The value never appeared in argv. |
| Approval in `codex exec`? | Run 1 (no approval key): the call failed with "MCP tool call requires approval, but approval policy is never". Run 2 with `default_tools_approval_mode="approve"` on the server: the call succeeded. |

Other keys found in the 0.167 config schema (binary strings, not exercised live): `env_http_headers`
(header name to env var name, streamable HTTP), `bearer_token_env_var`, `env` (literal values, never
used by Dispatch), `shell_environment_policy.exclude`. Dispatch uses `env_http_headers` for HTTP
servers and `shell_environment_policy.exclude=[<referenced vars>]` so the agent's own shell commands
do not inherit the forwarded variables (only the server process should see them). Those two were
not run live. SSE servers are not supported by codex (stdio and streamable HTTP only).

Note: codex starts MCP servers itself, outside the `read-only`/`workspace-write` sandbox of the
agent's shell commands. A forwarded stdio server runs with the user's privileges, exactly as it
does under Claude Code.

## claude 2.1.301 (one tiny haiku run, two killed-at-init runs)

```
claude -p --safe-mode --output-format stream-json --verbose --no-session-persistence --model haiku \
  --max-turns 3 --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools 'mcp__echo__*' \
  --mcp-config <0600 file: {"mcpServers":{"echo":{...,"env":{"DISPATCH_SPIKE_VAR":"${DISPATCH_SPIKE_VAR}"}}}}> \
  --strict-mcp-config
```

| Question | Result |
|---|---|
| Does `--safe-mode` honour `--mcp-config`? | **No.** The init event listed `mcp_servers: []` and tools `Glob, Grep, Read`; the model reported no echo tool. |
| Same flags without `--safe-mode` (process killed after the init event, no model turn)? | `mcp_servers: [{name: echo, status: connected, source: dynamic}]`, tools include `mcp__echo__echo`. |
| Does `--tools` restrict MCP tools? | No: `mcp__echo__echo` was listed next to `--tools Read,Grep,Glob`. |

Conclusion: `--safe-mode` is the guard that keeps the user's CLAUDE.md, hooks, plugins, skills and
custom agents out of the child, and it drops `--mcp-config` servers. Dropping it is not acceptable,
so **claude targets cannot receive MCP servers in v0.x**. The claude adapter refuses forwarded
servers (fail closed) and the router never picks a claude instance for a task that needs MCP.

## antigravity

Never: read-only and experimental (owner decision); the adapter refuses forwarded servers.
