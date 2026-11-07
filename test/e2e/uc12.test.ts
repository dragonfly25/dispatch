/**
 * [UC12] A second account of the same provider (spec §11 UC12). Verifica: the invariant "the host
 * does not invoke itself" holds for the session's account, not for the second one.
 *
 * `claude-alt` is a second Claude account (own `CLAUDE_CONFIG_DIR`); `claude-api` is an API-credit
 * pool of the same adapter. From a Claude Code session on the default account, delegable tasks may
 * go to `claude-alt` (the child runs with that account's config dir) but never to `claude`; from a
 * session started with `CLAUDE_CONFIG_DIR=<alt dir>` the roles swap.
 *
 * Lower-level proofs: test/unit/cli-read.test.ts ([UC12] host detection), router/decide.test.ts
 * (self exclusion), runner-env.test.ts. Real second account: docs/manual-tests/UC12.md.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld, parseJson, THREE_PROVIDERS, useBundles, type World } from "./harness.js";

useBundles();

interface ExplainJson {
  input: { host: { self: string | null } };
  decision: {
    action: string;
    targets: { instance: string }[];
    chain: { ruleId: string; effect: string }[];
  };
}

/** Claude Code host, two Claude accounts plus an API pool; the fake claude replies with a patch. */
function accounts(): World & { alt: string } {
  const w = createWorld({
    env: { CLAUDECODE: "1" },
    scenarios: { claude: [{ scenario: "success_edit", file: "math.js", content: "by claude\n" }] },
  });
  const alt = join(w.home.home, ".claude-alt");
  w.writeGlobal(`${THREE_PROVIDERS}  claude-alt: { adapter: claude, config_dir: "${alt}", plan: pro }
  claude-api: { adapter: claude, pool: api_credit }
profile: accounts
`);
  w.writeDispatchFile(
    "profiles/accounts.yaml",
    `version: 1
rules:
  - id: any-claude-account
    action: { type: fallback, instances: [claude, claude-alt], strategy: ordered }
`,
  );
  return Object.assign(w, { alt });
}

const claudeRuns = (w: World) =>
  w.fakes
    .readLog({ cli: "claude", kind: "run" })
    .filter((c) => c.args.includes("-p") || c.args.includes("--print"));

describe("[UC12] second account of the same provider", () => {
  it("[UC12] from the default account the task may go to claude-alt, whose child uses its own config dir", () => {
    const w = accounts();
    const e = parseJson<ExplainJson>(
      w.dispatch(["explain", "--json", "--task", "x", "--autonomy", "worktree"]),
    );
    expect(e.input.host.self).toBe("claude");
    const filtered = e.decision.chain.find((c) => c.ruleId === "claude");
    expect(filtered?.effect).toMatch(/self/);

    const r = w.run(["--provider", "claude-alt"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({
      status: "completed",
      outcome: "success",
      externalAgent: { provider: "claude", instance: "claude-alt" },
    });
    const runs = claudeRuns(w);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.env.CLAUDE_CONFIG_DIR).toBe(w.alt);
    // The session's own account was never invoked.
    expect(runs.every((c) => c.env.CLAUDE_CONFIG_DIR === w.alt)).toBe(true);
  });

  it("[UC12] the session's own account is never chosen, even when asked for explicitly", () => {
    const w = accounts();
    const r = w.run(["--provider", "claude"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result?.status).toBe("returned_to_host");
    expect(r.result?.externalAgent).toBeNull();
    expect(claudeRuns(w)).toEqual([]);
  });

  it("[UC12] the roles swap when the session runs on the second account (CLAUDE_CONFIG_DIR)", () => {
    const w = accounts();
    const env = { CLAUDE_CONFIG_DIR: w.alt };
    const e = parseJson<ExplainJson>(
      w.dispatch(["explain", "--json", "--task", "x", "--autonomy", "worktree"], { env }),
    );
    expect(e.input.host.self).toBe("claude-alt");
    expect(e.decision.chain.find((c) => c.ruleId === "claude-alt")?.effect).toMatch(/self/);
    const status = w.dispatch(["status"], { env }).stdout;
    // The claude-usage reader sees the whole account, interactive sessions included.
    expect(status).toMatch(/^claude-alt .*\(host — includes interactive usage\)/m);
    expect(status).not.toMatch(/^claude .*\(host — interactive/m);

    const viaDefault = w.run(["--provider", "claude"], { env });
    expect(viaDefault.result).toMatchObject({
      status: "completed",
      externalAgent: { instance: "claude" },
    });
    const runs = claudeRuns(w);
    expect(runs).toHaveLength(1);
    // The default account's child must not inherit the host session's (alt) config dir.
    expect(runs[0]?.env.CLAUDE_CONFIG_DIR).not.toBe(w.alt);
    const refused = w.run(["--provider", "claude-alt"], { env });
    expect(refused.result?.status).toBe("returned_to_host");
    expect(claudeRuns(w)).toHaveLength(1);
  });

  it("[UC12] an API-credit pool is another instance, with its pool visible in status", () => {
    const w = accounts();
    const status = w.dispatch(["status"]).stdout;
    expect(status).toMatch(/^claude-api .*pool api_credit/m);
    expect(status).toMatch(/^claude-alt .*pool subscription.*plan pro/m);
    const providers = w.dispatch(["providers", "--json"]);
    expect(providers.code, providers.stderr).toBe(0);
    expect(providers.stdout).toContain("claude-api");
  });
});
