# Spike: web access for delegated agents (2026-11-07)

Goal: give a delegated Claude Code custom agent whose `tools:` list `WebSearch` or `WebFetch` the
same capability in the external child, without widening the shell sandbox's network and without
loading any user configuration. Real CLIs: codex 0.167.0, claude 2.1.301. No user config was
touched; the runs used a scratch directory.

## codex 0.167.0

Offline checks (no model call):

| Question | Result |
|---|---|
| Is `--search` usable with `codex exec`? | **No.** `--search` is a top-level (TUI) flag; `codex exec --search` fails with `unexpected argument '--search'`. Its help says it sets live web search. |
| Which `web_search` values does the config accept under `--ignore-user-config --strict-config`? | `codex exec ... -c 'web_search="bogus"'` fails at config load with ``unknown variant `bogus`, expected one of `disabled`, `cached`, `indexed`, `live` `` (no model call). |
| Legacy keys? | `codex features list`: `web_search_cached` and `web_search_request` are `deprecated`. Dispatch uses the top-level `web_search` key only. |
| What is the tool? | The native Responses `web_search` tool (binary strings: `external_web_access`, `indexed_web_access`; actions `search`, `open_page`, `find_in_page`). It runs model-side, on OpenAI's servers, not in the agent's shell. |

One tiny live run (`gpt-6-luna`, effort low), Dispatch's isolation flags plus `web_search="live"`,
read-only sandbox:

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config \
  --disable hooks --disable plugins --disable apps --disable memories -c agents.enabled=false \
  -c 'web_search="live"' --skip-git-repo-check -C <dir> -m gpt-6-luna \
  -c model_reasoning_effort=low -s read-only -
```

Prompt: open `https://example.com` with the web tool and report its heading, then run
`curl -sS -m 5 https://example.com -o /dev/null` once and report whether it succeeded.

| Question | Result (JSON events) |
|---|---|
| Does `-c web_search="live"` apply with `--ignore-user-config --strict-config`? | **Yes.** A `web_search` item was emitted. |
| Can the web tool open a GIVEN URL (to cover `WebFetch`)? | **Yes.** `item.completed` `{type: "web_search", action: {type: "open_page", url: "https://example.com"}, results: [{title: "Example Domain", url: "https://example.com/"}]}`. The model reported "Example Domain". |
| Does web search widen the shell sandbox network? | **No.** In the same run, the `command_execution` `curl` failed: `curl: (6) Could not resolve host: example.com`, exit 6. |
| Does Dispatch's codex parser cope? | Yes: `web_search` items are already parsed as progress (`src/adapters/codex/parse.ts`). |

Decision:
- `WebSearch` only → `-c web_search="cached"` (OpenAI's index, no live fetch: the least network-y
  mode that searches). Not exercised live (one run allowed); it is the mode codex documents as its
  default and was accepted by `--strict-config`.
- `WebFetch` (opening a given URL) → `-c web_search="live"`, verified above.
- No web requested → no override, exactly as before (codex's own default applies; codex documents
  `cached` as that default, not verified live here).
- `-s read-only` / `workspace-write` unchanged; Dispatch never adds a shell network override.

## claude 2.1.301 (one tiny haiku run)

Dispatch's read-only child invocation plus the web tools:

```
claude -p --safe-mode --output-format stream-json --verbose --no-session-persistence --model haiku \
  --max-turns 6 --permission-mode dontAsk --tools Read,Grep,Glob,WebSearch,WebFetch \
  --allowedTools WebSearch,WebFetch --settings <credential denyRead + fail-closed sandbox JSON>
```

Prompt: fetch `https://example.com` with WebFetch and report its heading, then WebSearch
"IANA example domain" and report the first result's title.

| Question | Result |
|---|---|
| Does `--safe-mode` keep the built-in web tools listed in `--tools`? | **Yes.** The init event listed tools `Glob, Grep, Read, WebFetch, WebSearch` (and `mcp_servers: []`). |
| Can the child call them under `dontAsk` with `--allowedTools`? | **Yes.** `WebFetch {url: "https://example.com"}` returned "Example Domain"; `WebSearch {query: "IANA example domain"}` returned links. `permission_denials: []`, result `success`. |
| Settings? | The same `--settings` (credential `Read` deny rules, `sandbox.filesystem.denyRead`, `failIfUnavailable`) were passed unchanged. |

Decision: claude targets are web-capable. Dispatch adds `WebSearch` (and `WebFetch` when the agent
declares it) to `--tools` and pre-approves exactly those with `--allowedTools`; the credential deny
settings are unchanged. The web tools run in the claude process, not in the Bash sandbox, whose
network stays as it is.

## antigravity

Never: read-only and experimental (owner decision). The router excludes it for web tasks and the
adapter refuses a run with web access (fail closed).
