/** Opt-in sandbox network: golden argv per adapter, the scope decision, tighten-only config, doctor. */
import { afterEach, describe, expect, it } from "vitest";
import { buildAgyInvocation } from "../../src/adapters/agy/invocation.js";
import { buildClaudeInvocation, SANDBOX_NETWORK } from "../../src/adapters/claude/invocation.js";
import { buildCodexInvocation, networkOverride } from "../../src/adapters/codex/invocation.js";
import { defaultSettings } from "../../src/config/defaults.js";
import { mergeLayers } from "../../src/config/merge.js";
import {
  type GlobalConfigFile,
  GlobalConfigFileSchema,
  type Overlay,
  OverlaySchema,
} from "../../src/config/schema.js";
import {
  type BuildInvocationWithNetwork,
  cacheDirFor,
  decideNetwork,
  describeNetwork,
  GENERAL_PURPOSE,
  packageCacheEnv,
  runAgent,
} from "../../src/sandbox/network.js";
import { probeResult, task } from "../fixtures/contracts.js";
import { type DoctorHarness, doctorHarness, lineOf } from "./doctor.helpers.js";

const NET = { cacheDir: "/tmp/dispatch-net/r1-1" };

function args(
  adapter: "codex" | "claude" | "antigravity",
  network: boolean,
  autonomy: "read-only" | "worktree" = "worktree",
): BuildInvocationWithNetwork {
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
    baseEnv: { PATH: "/bin", HOME: "/home/u", TMPDIR: "/tmp" },
    ...(network ? { network: NET } : {}),
  };
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const settingsOf = (argv: string[]) =>
  JSON.parse(flagValue(argv, "--settings") ?? "{}") as {
    sandbox: { filesystem: Record<string, unknown>; network?: unknown; failIfUnavailable: boolean };
    permissions: unknown;
  };

describe("codex sandbox network (golden argv) [SEC-network]", () => {
  it("off: no override, no cache env; on: network_access before -C, caches, isolation intact", () => {
    const off = buildCodexInvocation(args("codex", false));
    expect(off.argv.join(" ")).not.toContain("network_access");
    expect(off.env.npm_config_cache).toBeUndefined();
    expect(off.sideEffectGuards).not.toContain("codex-network-opt-in");

    const on = buildCodexInvocation(args("codex", true));
    const at = on.argv.indexOf("-C");
    expect(on.argv.slice(at - 2, at)).toEqual([
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
    expect(flagValue(on.argv, "-s")).toBe("workspace-write");
    expect(on.argv.join(" ")).not.toMatch(/danger-full-access|dangerously-bypass/);
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config"]) {
      expect(on.argv).toContain(flag);
    }
    expect(on.env).toMatchObject({
      npm_config_cache: "/tmp/dispatch-net/r1-1/npm",
      npm_config_store_dir: "/tmp/dispatch-net/r1-1/pnpm-store",
    });
    expect(on.sideEffectGuards).toContain("codex-network-opt-in");
    // Otherwise identical to the run without network.
    expect(on.argv.filter((a) => !a.includes("network_access"))).toEqual([
      ...off.argv.slice(0, at - 2),
      "-c",
      ...off.argv.slice(at - 2),
    ]);
  });

  it("read-only runs never get network: the read-only sandbox has no network setting", () => {
    const ro = buildCodexInvocation(args("codex", true, "read-only"));
    expect(ro.argv.join(" ")).not.toContain("network_access");
    expect(flagValue(ro.argv, "-s")).toBe("read-only");
    expect(ro.env.npm_config_cache).toBeUndefined();
    expect(networkOverride(NET, "read-only")).toEqual([]);
    expect(networkOverride(undefined, "worktree")).toEqual([]);
  });
});

describe("claude sandbox network (golden argv) [SEC-network] [SEC-claude-cred]", () => {
  it("adds sandbox.network and the cache allowWrite; credential denyRead unchanged", () => {
    const off = buildClaudeInvocation(args("claude", false));
    const on = buildClaudeInvocation(args("claude", true));
    const a = settingsOf(off.argv);
    const b = settingsOf(on.argv);
    expect(a.sandbox.network).toBeUndefined();
    expect(b.sandbox.network).toEqual({
      allowLocalBinding: true,
      allowAllUnixSockets: true,
      allowedDomains: ["*"],
    });
    expect(b.sandbox.network).toEqual(SANDBOX_NETWORK);
    expect(b.sandbox.filesystem.denyRead).toEqual(a.sandbox.filesystem.denyRead);
    expect(b.sandbox.filesystem.allowWrite).toEqual([NET.cacheDir]);
    expect(b.permissions).toEqual(a.permissions);
    expect(b.sandbox.failIfUnavailable).toBe(true);
    expect(on.env.npm_config_store_dir).toBe("/tmp/dispatch-net/r1-1/pnpm-store");
    expect(on.sideEffectGuards).toContain("claude-network-opt-in");
    expect(off.sideEffectGuards).not.toContain("claude-network-opt-in");
    // Everything but --settings is unchanged.
    const i = on.argv.indexOf("--settings");
    expect(on.argv.slice(0, i)).toEqual(off.argv.slice(0, i));
  });

  it("a read-only child (no Bash) gets no network", () => {
    const ro = buildClaudeInvocation(args("claude", true, "read-only"));
    expect(settingsOf(ro.argv).sandbox.network).toBeUndefined();
    expect(ro.env.npm_config_cache).toBeUndefined();
  });

  it("antigravity (read-only) ignores it", () => {
    const inv = buildAgyInvocation({
      ...args("antigravity", true, "read-only"),
      probe: { ...probeResult, binaryPath: "/bin/agy", flags: [] },
    });
    expect(inv.argv.join(" ")).not.toMatch(/network/);
  });
});

describe("network scope decision [SEC-network]", () => {
  it("names the run's agent: handoff agent, general-purpose under a host, else nobody", () => {
    expect(runAgent("builder", false)).toBe("builder");
    expect(runAgent(undefined, true)).toBe(GENERAL_PURPOSE);
    expect(runAgent(undefined, false)).toBeNull();
  });

  it("off never, all always, delegated-agents only agents (narrowed by network_agents)", () => {
    expect(decideNetwork({ scope: "off", agent: "builder" }).enabled).toBe(false);
    expect(decideNetwork({ scope: "all", agent: null }).enabled).toBe(true);
    expect(decideNetwork({ scope: "all", agent: "x", agents: ["y"] }).enabled).toBe(true);
    const by = (agent: string | null, agents?: string[]) =>
      decideNetwork({ scope: "delegated-agents", agent, agents });
    expect(by(null)).toEqual({
      enabled: false,
      scope: "delegated-agents",
      agent: null,
      reason: "not a delegated agent (network: delegated-agents)",
    });
    expect(by("builder").enabled).toBe(true);
    expect(by(GENERAL_PURPOSE).enabled).toBe(true);
    expect(by("builder", ["builder"]).enabled).toBe(true);
    expect(by(GENERAL_PURPOSE, ["builder"])).toMatchObject({
      enabled: false,
      reason: "general-purpose is not in network_agents",
    });
    expect(by("builder", []).enabled).toBe(false);
    expect(describeNetwork(by("builder"))).toBe(
      "on (delegated agent builder (network: delegated-agents))",
    );
  });

  it("caches live in a per-attempt directory outside the worktree", () => {
    expect(cacheDirFor("/t", "r1", 2)).toBe("/t/dispatch-net/r1-2");
    expect(packageCacheEnv({ cacheDir: "/c" })).toEqual({
      npm_config_cache: "/c/npm",
      npm_config_store_dir: "/c/pnpm-store",
    });
  });
});

describe("network config: global-only loosening, repo and flags only lower it [SEC-flags]", () => {
  const G = (g: Partial<GlobalConfigFile> = {}): GlobalConfigFile => ({ version: 1, ...g });
  const merge = (global: GlobalConfigFile, repo?: Overlay, flags?: Overlay) =>
    mergeLayers({
      defaults: defaultSettings(),
      global,
      ...(repo ? { repo } : {}),
      ...(flags ? { flags } : {}),
    });

  it("defaults to off with no agent list; the global file sets the scope and list", () => {
    expect(merge(G()).settings).toMatchObject({ network: "off", network_agents: null });
    const res = merge(G({ network: "delegated-agents", network_agents: ["builder"] }));
    expect(res.settings).toMatchObject({
      network: "delegated-agents",
      network_agents: ["builder"],
    });
    expect(res.provenance.network).toBe("global");
    expect(res.issues).toEqual([]);
  });

  it("a repo or flag cannot turn it on or widen it, but can lower it", () => {
    for (const layer of ["repo", "flag"] as const) {
      for (const [global, wanted] of [
        ["off", "delegated-agents"],
        ["off", "all"],
        ["off", "on"],
        ["delegated-agents", "all"],
      ] as const) {
        const o: Overlay = { network: wanted };
        const res =
          layer === "repo"
            ? merge(G({ network: global }), o)
            : merge(G({ network: global }), undefined, o);
        expect(res.settings.network).toBe(global);
        expect(res.issues).toEqual([expect.objectContaining({ level: "error", key: "network" })]);
      }
      const lowered =
        layer === "repo"
          ? merge(G({ network: "all" }), { network: "delegated-agents" })
          : merge(G({ network: "all" }), undefined, { network: "off" });
      expect(lowered.issues).toEqual([]);
      expect(lowered.settings.network).toBe(layer === "repo" ? "delegated-agents" : "off");
    }
  });

  it("network_agents is global-only; the deprecated `on` means all, with a warning", () => {
    expect(OverlaySchema.safeParse({ network_agents: ["x"] }).success).toBe(false);
    expect(GlobalConfigFileSchema.safeParse({ version: 1, network_agents: ["x"] }).success).toBe(
      true,
    );
    const res = merge(G({ network: "on" }));
    expect(res.settings.network).toBe("all");
    expect(res.issues).toEqual([expect.objectContaining({ level: "warning", key: "network" })]);
  });
});

describe("doctor sandbox.network check", () => {
  let h: DoctorHarness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  it("ok while off; a warning (not a failure) with scope and risk when on", async () => {
    h = doctorHarness();
    let { report } = await h.report();
    expect(lineOf(report, "sandbox.network")).toMatchObject({
      status: "ok",
      message: "off: delegated agents have no shell network",
    });
    h.config("version: 1\nnetwork: delegated-agents\nnetwork_agents: [builder]\n");
    ({ report } = await h.report());
    const line = lineOf(report, "sandbox.network");
    expect(line.status).toBe("warn");
    expect(line.message).toBe(
      "ON (delegated-agents) for worktree runs of these agents: builder: unsupervised agents can then reach the internet, localhost services, local databases and Docker (prompt-injection exfiltration, actions against real services)",
    );
    expect(line.fix).toMatch(/network: off/);
    h.config("version: 1\nnetwork: all\nnetwork_agents: [builder]\n");
    ({ report } = await h.report());
    expect(lineOf(report, "sandbox.network").message).toMatch(
      /^ON \(all\) for every worktree run, including runs started by hand; network_agents is ignored with all:/,
    );
    h.config("version: 1\nnetwork: delegated-agents\n");
    ({ report } = await h.report());
    expect(lineOf(report, "sandbox.network").message).toContain(
      "every delegated agent (custom agents and general-purpose)",
    );
  });
});
