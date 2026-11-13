/** Web access for delegated agents: golden argv per adapter, the router capability hint, the plan. */
import { describe, expect, it } from "vitest";
import { buildAgyInvocation } from "../../../src/adapters/agy/invocation.js";
import { buildClaudeInvocation, webTools } from "../../../src/adapters/claude/invocation.js";
import { buildCodexInvocation, webOverride } from "../../../src/adapters/codex/invocation.js";
import { forwardWebFor, type HookCache } from "../../../src/hook/cache.js";
import { decide } from "../../../src/router/decide.js";
import { planWeb } from "../../../src/runner/web.js";
import {
  adapterCanBrowse,
  type BuildInvocationWithWeb,
  refuseWeb,
  type WebAccess,
  webAccessOf,
  webCapableAdapters,
  withWeb,
} from "../../../src/web/index.js";
import { probeResult, task } from "../../fixtures/contracts.js";
import { makeConfig, makeInput } from "../router/fixtures.js";

function args(
  adapter: "codex" | "claude" | "antigravity",
  web?: WebAccess,
  autonomy: "read-only" | "worktree" = adapter === "antigravity" ? "read-only" : "worktree",
): BuildInvocationWithWeb {
  return {
    task,
    target: { instance: adapter, tier: "fast", model: "m1", effort: "low" },
    autonomy,
    worktree: "/w/wt",
    repoRoot: "/w",
    runDir: "/w/run",
    instance: { id: adapter, adapter, pool: "subscription" },
    probe: {
      ...probeResult,
      binaryPath: `/bin/${adapter}`,
      flags: ["--safe-mode"],
      features: ["hooks", "plugins"],
    },
    baseEnv: { PATH: "/bin", HOME: "/home/u" },
    ...(web ? { web } : {}),
  };
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("codex web search (golden argv) [UC2]", () => {
  it("no web: argv unchanged; search: cached; fetch: live, before -C, isolation intact", () => {
    const none = buildCodexInvocation(args("codex"));
    expect(none.argv.join(" ")).not.toContain("web_search");
    expect(none.sideEffectGuards).not.toContain("codex-web-model-side-only");
    expect(webOverride(undefined)).toEqual([]);
    expect(webOverride("search")).toEqual(["-c", 'web_search="cached"']);
    expect(webOverride("fetch")).toEqual(["-c", 'web_search="live"']);
    for (const [web, mode] of [
      ["search", '"cached"'],
      ["fetch", '"live"'],
    ] as const) {
      const inv = buildCodexInvocation(args("codex", web, "read-only"));
      const at = inv.argv.indexOf("-C");
      expect(inv.argv.slice(at - 2, at)).toEqual(["-c", `web_search=${mode}`]);
      // The shell sandbox is untouched: still read-only, no network override.
      expect(flagValue(inv.argv, "-s")).toBe("read-only");
      expect(inv.argv.join(" ")).not.toMatch(/network_access|danger-full-access|--search/);
      for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config"]) {
        expect(inv.argv).toContain(flag);
      }
      expect(inv.sideEffectGuards).toContain("codex-web-model-side-only");
      // Otherwise identical to the run without web.
      const base = buildCodexInvocation(args("codex", undefined, "read-only")).argv;
      expect(inv.argv.filter((a) => !a.startsWith("web_search="))).toEqual([
        ...base.slice(0, at - 2),
        "-c",
        ...base.slice(at - 2),
      ]);
    }
  });
});

// claude and antigravity are built for POSIX: native Windows refuses both (adapterPlatformBlocker).
describe("claude web tools (golden argv) [UC2]", () => {
  it("adds only the requested web tools to --tools and pre-approves them; settings unchanged", () => {
    expect(webTools(undefined)).toEqual([]);
    expect(webTools("search")).toEqual(["WebSearch"]);
    expect(webTools("fetch")).toEqual(["WebSearch", "WebFetch"]);
    const plain = buildClaudeInvocation(args("claude", undefined, "read-only"), "linux");
    expect(plain.argv).not.toContain("--allowedTools");
    expect(flagValue(plain.argv, "--tools")).toBe("Read,Grep,Glob");

    const ro = buildClaudeInvocation(args("claude", "search", "read-only"), "linux");
    expect(flagValue(ro.argv, "--tools")).toBe("Read,Grep,Glob,WebSearch");
    expect(flagValue(ro.argv, "--allowedTools")).toBe("WebSearch");
    expect(flagValue(ro.argv, "--permission-mode")).toBe("dontAsk");
    expect(ro.sideEffectGuards).toContain("claude-web-tools-only");

    const wt = buildClaudeInvocation(args("claude", "fetch", "worktree"), "linux");
    expect(flagValue(wt.argv, "--tools")).toBe("Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch");
    expect(flagValue(wt.argv, "--allowedTools")).toBe("WebSearch,WebFetch");
    expect(flagValue(wt.argv, "--disallowedTools")).toBe("Agent");
    expect(wt.argv).toContain("--safe-mode");
    // The credential deny rules are the same with or without web [SEC-claude-cred].
    const plainWt = buildClaudeInvocation(args("claude", undefined, "worktree"), "linux");
    expect(flagValue(wt.argv, "--settings")).toBe(flagValue(plainWt.argv, "--settings"));
  });
});

describe("antigravity never gets web access", () => {
  it("refuses a run with web (fail closed) and builds without", () => {
    expect(() => buildAgyInvocation(args("antigravity", "search"), "linux")).toThrow(
      /never gets web access/,
    );
    expect(() =>
      buildAgyInvocation(
        { ...args("antigravity"), probe: { ...probeResult, binaryPath: "/bin/agy", flags: [] } },
        "linux",
      ),
    ).not.toThrow();
    expect(() => refuseWeb("other", { web: "fetch" })).toThrow(/other cannot be given web/);
    expect(() => refuseWeb("other", {})).not.toThrow();
  });

  it("capability table and handoff mapping", () => {
    expect(webCapableAdapters().sort()).toEqual(["claude", "codex"]);
    expect(adapterCanBrowse("antigravity", undefined)).toBe(true);
    expect(adapterCanBrowse("antigravity", "search")).toBe(false);
    expect(adapterCanBrowse("claude", "fetch")).toBe(true);
    expect(webAccessOf({ web: false, webFetch: true })).toBeUndefined();
    expect(webAccessOf({ web: true, webFetch: false })).toBe("search");
    // A handoff written before `webFetch` existed: assume the agent may fetch.
    expect(webAccessOf({ web: true })).toBe("fetch");
    expect(withWeb(undefined)).toEqual({});
    expect(withWeb({ web: false })).toEqual({});
    expect(withWeb({ web: true, webFetch: true })).toEqual({ web: "fetch" });
  });
});

describe("router capability hint for web [UC2]", () => {
  const routing = makeConfig();

  it("is a no-op without web; returns to host when off or when no instance can give it", () => {
    expect(planWeb({ wanted: undefined, forwardWeb: false, routing })).toEqual({
      ok: true,
      web: undefined,
      routing,
      excluded: [],
    });
    expect(planWeb({ wanted: "search", forwardWeb: false, routing })).toEqual({
      ok: false,
      reason: expect.stringContaining("hosts.claude-code.forward_web"),
    });
    const agyOnly = makeConfig({
      instances: routing.instances.map((i) => ({ ...i, enabled: i.adapter === "antigravity" })),
    });
    expect(planWeb({ wanted: "fetch", forwardWeb: true, routing: agyOnly })).toEqual({
      ok: false,
      reason: "no enabled provider can give the agent web access (only codex and claude can)",
    });
  });

  it("a web task is never routed to an incapable instance", () => {
    const plan = planWeb({ wanted: "search", forwardWeb: true, routing });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.excluded).toEqual(["agy"]);
    // The balance profile tries codex, agy, claude-alt in order: with codex exhausted, the
    // unrestricted router would pick agy; the restricted one skips it.
    const input = (r: typeof routing) =>
      makeInput({ used: { codex: 100 }, config: r, task: { autonomy: "read-only" } });
    const unrestricted = decide(input(routing));
    expect(unrestricted.targets.map((t) => t.instance)).toContain("agy");
    const restricted = decide(input(plan.routing));
    expect(restricted.action).toBe("delegate");
    expect(restricted.targets.map((t) => t.instance)).not.toContain("agy");
    expect(restricted.chain.find((c) => c.ruleId === "agy")?.effect).toMatch(/disabled/);
  });
});

describe("hook cache web switch [SEC-flags]", () => {
  const cache = (policy: Partial<HookCache["policy"]>, repoOff = false): HookCache => ({
    version: 1,
    writtenAt: "x",
    trustedRepos: [{ root: "/r", policyHash: null, ...(repoOff ? { forwardWeb: false } : {}) }],
    policy: { profile: "p", hardMode: true, summary: "s", ...policy },
  });

  it("absent means on; global false or the repo's false turns it off", () => {
    expect(forwardWebFor(cache({}), "/r/sub")).toBe(true);
    expect(forwardWebFor(cache({ forwardWeb: true }), "/elsewhere")).toBe(true);
    expect(forwardWebFor(cache({ forwardWeb: false }), "/r")).toBe(false);
    expect(forwardWebFor(cache({}, true), "/r/sub")).toBe(false);
    expect(forwardWebFor(cache({}, true), "/elsewhere")).toBe(true);
  });
});
