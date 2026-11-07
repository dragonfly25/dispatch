"""UC10 client: a plain Python process that uses Dispatch as a framework subprocess.

Usage: uc10_client.py <node> <cli.mjs> <repo-dir>

It scrubs every host marker from the environment, runs `dispatch run --task ... --json`, reads
the RunResult the way a script would (schemaVersion 1, status, marker), and asks the router
(`run --dry-run --json`) which host it saw. Prints one JSON object on stdout.
"""
import json
import os
import subprocess
import sys

node, cli, repo = sys.argv[1:4]
HOST_MARKERS = (
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_SANDBOX",
    "ANTIGRAVITY_AGENT",
    "DISPATCH_DEPTH",
)
env = {k: v for k, v in os.environ.items() if k not in HOST_MARKERS}


def dispatch(*args):
    return subprocess.run(
        [node, cli, *args], cwd=repo, env=env, capture_output=True, text=True, timeout=120
    )


task = ["--task", "add sub to math.js", "--path", "math.js"]
run = dispatch("run", *task, "--json")
result = json.loads(run.stdout)
dry = json.loads(dispatch("run", *task, "--dry-run", "--json").stdout)
print(
    json.dumps(
        {
            "exit": run.returncode,
            "schemaVersion": result["schemaVersion"],
            "status": result["status"],
            "outcome": result["outcome"],
            "marker": (result["externalAgent"] or {}).get("marker"),
            "patch": (result["patch"] or {}).get("path"),
            "self": dry["input"]["host"]["self"],
            "stderr": run.stderr,
        }
    )
)
