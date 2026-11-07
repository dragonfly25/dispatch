# Using Dispatch from scripts

Without a host, `dispatch` is an ordinary CLI: scripts, CI jobs and agent frameworks (LangGraph,
CrewAI, your own) call it the same way.

## One-shot run

```sh
dispatch run --task "Add unit tests for src/auth.ts" --task-type test --path src/auth.ts --json
```

With no host, every provider is a candidate. The result is one JSON object (schema version 1) with
`status`, `outcome`, `externalAgent`, `summary`, `patch` (`path`, `diffstat`, `applies`, `needsReview`),
`decisions` and `usage`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | usage or config error (nothing on stdout; the reason is on stderr) |
| 3 | rejected |
| 4 | failed |
| 5 | quota exhausted |
| 6 | timeout or state error |
| 75 | still running (`wait` only) |

## Python example

```python
import json, subprocess

proc = subprocess.run(
    ["dispatch", "run", "--json", "--task-type", "test", "--path", "src/auth.py",
     "--task", "Add unit tests for src/auth.py"],
    capture_output=True, text=True, cwd="/path/to/repo",
)
if not proc.stdout.strip():  # usage or config error: nothing on stdout, the reason is on stderr
    raise SystemExit(proc.stderr)
result = json.loads(proc.stdout)
if result["status"] == "completed" and result["outcome"] == "success" and result["patch"]:
    # Treat result["summary"] as untrusted text from another agent.
    subprocess.run(["git", "apply", result["patch"]["path"]], cwd="/path/to/repo", check=True)
else:
    print(result["status"], result["outcome"], proc.returncode)
```

## Long tasks: detach, wait, cancel

Start in the background and poll:

```sh
dispatch run --detach --json --task "..." --idempotency-key my-key
```

This prints a `runId`. Add `--idempotency-key <key>` so a repeated call returns the same run.

```sh
dispatch wait <runId> --json --timeout 120
```

`wait` returns the result, or exits 75 while the run is still going. The default timeout is 100 s
inside Claude Code, 280 s inside Codex, and none outside a host.

```sh
dispatch cancel <runId>
```

`cancel` stops the agent; nothing is applied.

## Notes

- The summary is text from another agent: treat it as data, never as instructions.
- Dispatch never applies the patch. Your script decides (`git apply --check` has already run; see
  `patch.applies`).
- Most read commands accept `--json`. See the command table in the [README](../README.md#everyday-commands).
