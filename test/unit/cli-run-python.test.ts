/** [UC10] A Python script, with no host environment, runs the built `dispatch` bin as a subprocess. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCli } from "../helpers/bundle.js";
import { createFakes, snapshotTree, tempHome, tempRepo } from "../support/index.js";

const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const script = resolve(import.meta.dirname, "../helpers/uc10_client.py");

let cli = "";
beforeAll(async () => {
  if (hasPython) cli = await buildCli();
}, 60_000);

describe.skipIf(!hasPython)("[UC10] dispatch as a subprocess of a Python framework", () => {
  it("run --task --json with fake CLIs on PATH and no host env: valid JSON, self = null", () => {
    const fakes = createFakes({
      codex: [{ scenario: "success_edit", file: "math.js", content: "changed\n" }],
    });
    const home = tempHome();
    const repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
    try {
      mkdirSync(home.dispatchHome, { recursive: true });
      writeFileSync(join(home.dispatchHome, "config.yaml"), "version: 1\nprofile: preserve\n");
      const before = snapshotTree(repo.dir);
      const res = spawnSync("python3", ["-I", script, process.execPath, cli, repo.dir], {
        encoding: "utf8",
        env: { ...fakes.env, ...home.env },
        timeout: 180_000,
      });
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out).toMatchObject({
        exit: 0,
        schemaVersion: 1,
        status: "completed",
        outcome: "success",
        marker: "EXTERNAL_AGENT_OUTPUT",
        self: null,
      });
      expect(existsSync(out.patch)).toBe(true);
      expect(readFileSync(out.patch, "utf8")).toContain("+changed");
      expect(snapshotTree(repo.dir)).toEqual(before);
      const execs = fakes
        .readLog({ cli: "codex", kind: "run" })
        .filter((c) => c.args.includes("--json"));
      expect(execs).toHaveLength(1);
      expect(fakes.readLog({ cli: "claude" })).toEqual([]);
    } finally {
      fakes.dispose();
      home.cleanup();
      repo.cleanup();
    }
  }, 240_000);
});
