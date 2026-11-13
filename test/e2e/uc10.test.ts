/**
 * [UC10] Use without a host (spec §11 UC10). Verifica: a Python script calls
 * `dispatch run --task "..." --json` and reads the result; it works with no host CLI running, host
 * "self" is none, every provider is available.
 *
 * Also proven, at the same level, by test/unit/cli-run-python.test.ts and cli-run.test.ts ([UC10]).
 * This file adds the checks the spec words ask for: all providers are candidates, and an explicit
 * `--provider` works for a script too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_QUOTA_UNREAD,
  createWorld,
  EDIT_CODEX,
  parseJson,
  snapshotTree,
  THREE_PROVIDERS,
  useBundles,
} from "./harness.js";

const bundles = useBundles();

// Windows installs usually name the interpreter `python` (`python3` may be a Store stub).
const python = ["python3", "python"].find(
  (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0,
);
const hasPython = python !== undefined;
const script = resolve(import.meta.dirname, "../helpers/uc10_client.py");

describe.skipIf(!hasPython)("[UC10] dispatch as a subprocess of a Python framework", () => {
  it("[UC10] a Python script gets valid JSON with no host running (self = none)", () => {
    // Even when the test itself runs inside a Claude Code or Codex session, the script's own
    // environment has no host marker (it scrubs them, as a framework launched from cron would not
    // have them).
    const w = createWorld({
      global: THREE_PROVIDERS,
      scenarios: { ...EDIT_CODEX, ...CLAUDE_QUOTA_UNREAD },
    });
    const before = snapshotTree(w.repo.dir);
    const r = w.exec(
      python as string,
      ["-I", script, process.execPath, bundles().cli, w.repo.dir],
      {
        env: { CLAUDECODE: "1", CODEX_THREAD_ID: "leaked-from-the-test-runner" },
      },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      exit: 0,
      schemaVersion: 1,
      status: "completed",
      outcome: "success",
      marker: "EXTERNAL_AGENT_OUTPUT",
      self: null,
    });
    expect(readFileSync(out.patch, "utf8")).toContain("+changed by codex");
    expect(existsSync(join(w.repo.dir, ".dispatch"))).toBe(false);
    expect(snapshotTree(w.repo.dir)).toEqual(before);
    // No host CLI was involved: only the delegated codex run happened.
    expect(w.fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
    expect(
      w.fakes.readLog({ cli: "codex", kind: "run" }).filter((c) => c.args.includes("--json")),
    ).toHaveLength(1);
  });

  it("[UC10] without a host every provider is a candidate, and --provider picks one", () => {
    const w = createWorld({
      global: THREE_PROVIDERS,
      scenarios: {
        ...EDIT_CODEX,
        claude: [{ scenario: "success_edit", file: "math.js", content: "changed by claude\n" }],
      },
    });
    const dry = parseJson<{
      input: { host: { self: string | null } };
      decision: { targets: { instance: string }[]; chain: { effect: string }[] };
    }>(w.dispatch(["run", "--task", "x", "--dry-run", "--json"]));
    expect(dry.input.host.self).toBeNull();
    expect(dry.decision.targets.map((t) => t.instance).sort()).toEqual(["claude", "codex"]);
    expect(dry.decision.chain.some((c) => /self/.test(c.effect))).toBe(false);

    const viaClaude = w.run(["--provider", "claude"]);
    expect(viaClaude.code, viaClaude.stderr).toBe(0);
    expect(viaClaude.result?.externalAgent?.instance).toBe("claude");
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toEqual([]);
  });
});
