/**
 * [UC5] Pinned task (spec §11 UC5). Verifica: `explain` shows the pin rule as the winner, under any
 * active profile, and a task touching the pinned paths is never delegated (nothing is spawned).
 *
 * The pin lives in the repo policy (`.dispatch/config.yaml`), which only counts once the user has
 * trusted it. Lower-level proofs: test/unit/router/properties.test.ts (a pin always wins),
 * test/unit/config/validate.test.ts ([UC5]), test/unit/sandbox-filter.test.ts and
 * sandbox-patch.test.ts (rejection at patch time).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld, parseJson, THREE_PROVIDERS, useBundles } from "./harness.js";

useBundles();

const PIN = `pins:
  - id: migrations-stay-on-host
    description: Never delegate database migrations.
    match: { paths: ["db/migrations/**"] }
    action: { type: host }
`;

interface ExplainJson {
  decision: {
    action: string;
    reason: string;
    chain: { layer: string; ruleId: string; matched: boolean }[];
  };
}

function pinnedWorld() {
  const w = createWorld({
    global: THREE_PROVIDERS,
    files: { "db/migrations/001_init.sql": "create table t(id int);\n" },
    scenarios: {
      codex: [{ scenario: "success_edit", file: "db/migrations/002.sql", content: "x\n" }],
      claude: [{ scenario: "success_edit", file: "db/migrations/002.sql", content: "x\n" }],
    },
  });
  expect(w.dispatch(["install", "--yes", "--skip-setup"]).code).toBe(0);
  const config = join(w.repo.dir, ".dispatch", "config.yaml");
  writeFileSync(config, `${readFileSync(config, "utf8")}\n${PIN}`);
  // The edit made the policy untrusted until the user reviews it.
  const untrusted = w.dispatch(["status", "--json"]);
  expect(parseJson<{ repo: { status: string } }>(untrusted).repo.status).toBe("changed");
  expect(w.dispatch(["trust"]).code).toBe(0);
  return w;
}

describe("[UC5] pinned task", () => {
  it("[UC5] explain shows the pin as the winning rule under every profile", () => {
    const w = pinnedWorld();
    const args = ["explain", "--json", "--task", "add a column", "--path", "db/migrations/003.sql"];
    for (const profile of ["balance", "preserve", "specialize", "off"]) {
      expect(w.dispatch(["use", profile]).code, profile).toBe(0);
      const e = parseJson<ExplainJson>(w.dispatch(args));
      expect(e.decision.action, profile).toBe("host");
      const winner = e.decision.chain.find((c) => c.matched && c.layer === "pin");
      expect(winner?.ruleId, profile).toBe("migrations-stay-on-host");
      expect(e.decision.reason, profile).toContain("migrations-stay-on-host");
      // The text form names the rule too.
      const text = w.dispatch(args.filter((a) => a !== "--json"));
      expect(text.stdout, profile).toContain("migrations-stay-on-host");
    }
    // A task that does not touch the pinned paths is still delegated (the pin is not a blanket).
    expect(w.dispatch(["use", "preserve"]).code).toBe(0);
    const other = parseJson<ExplainJson>(
      w.dispatch(["explain", "--json", "--task", "x", "--path", "src/a.ts"]),
    );
    expect(other.decision.action).toBe("delegate");
  });

  it("[UC5] run never delegates a task that touches the pinned paths", () => {
    const w = pinnedWorld();
    expect(w.dispatch(["use", "preserve"]).code).toBe(0);
    const r = w.run(["--path", "db/migrations/003.sql", "--task-type", "refactor"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ status: "returned_to_host", externalAgent: null });
    expect(r.result?.decisions[0]?.action).toBe("host");
    expect(r.result?.decisions[0]?.reason).toContain("migrations-stay-on-host");
    expect(w.fakes.readLog({ kind: "run" })).toEqual([]);
    // The same task without the pinned path does run on an external provider.
    const free = w.run(["--path", "math.js"]);
    expect(free.result?.status).toBe("completed");
  });

  it("[UC5] a pin in a repo policy the user has not trusted is ignored and says so", () => {
    const w = createWorld({ global: THREE_PROVIDERS });
    w.repo.write(".dispatch/config.yaml", `version: 1\n${PIN}`);
    const status = w.dispatch(["status"]);
    expect(status.stdout).toContain("repo policy NOT trusted, ignored");
    const e = parseJson<ExplainJson>(
      w.dispatch(["explain", "--json", "--task", "x", "--path", "db/migrations/003.sql"]),
    );
    expect(e.decision.chain.some((c) => c.ruleId === "migrations-stay-on-host")).toBe(false);
  });
});
