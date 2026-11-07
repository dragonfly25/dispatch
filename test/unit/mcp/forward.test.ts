/** MCP forwarding in the adapters (golden argv), the router capability hint and the run plan. */
import { describe, expect, it } from "vitest";
import { buildAgyInvocation } from "../../../src/adapters/agy/invocation.js";
import { buildClaudeInvocation } from "../../../src/adapters/claude/invocation.js";
import { buildCodexInvocation, mcpOverrides } from "../../../src/adapters/codex/index.js";
import { forwardableMcpFor, type HookCache } from "../../../src/hook/cache.js";
import {
  adapterCanHost,
  type BuildInvocationWithMcp,
  describeServer,
  type McpServer,
  mcpCapableAdapters,
  REASONS,
} from "../../../src/mcp/index.js";
import { restrictToCapable } from "../../../src/router/capability.js";
import { mcpVariables, planMcp } from "../../../src/runner/mcp.js";
import { probeResult, task } from "../../fixtures/contracts.js";
import { makeConfig } from "../router/fixtures.js";

const ref = (name: string) => `\${${name}}`;
const SECRET = "ghp_CANARYmcp0123456789abcdefghijkl";

const gh = describeServer("gh", "user", {
  command: "/usr/local/bin/gh-mcp",
  args: ["--stdio", 'quote"d'],
  env: { GH_TOKEN: ref("GH_TOKEN") },
});
const api = describeServer("api", "project", {
  type: "http",
  url: "https://mcp.example.test/mcp",
  headers: { Authorization: ref("API_AUTH") },
});
const plain = describeServer("echo", "local", { command: "node", args: ["/srv/echo.mjs"] });

function args(
  adapter: "codex" | "claude" | "antigravity",
  servers?: McpServer[],
): BuildInvocationWithMcp {
  return {
    task,
    target: { instance: adapter, tier: "fast", model: "m1", effort: "low" },
    autonomy: adapter === "antigravity" ? "read-only" : "worktree",
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
    baseEnv: { PATH: "/bin", HOME: "/home/u", GH_TOKEN: SECRET, API_AUTH: SECRET },
    ...(servers ? { mcpServers: servers } : {}),
  };
}

describe("codex forwards only the needed servers, by variable name [SEC-mcp] [SEC-env]", () => {
  it("golden -c overrides for stdio and http servers", () => {
    expect(mcpOverrides([gh, api, plain])).toEqual([
      "-c",
      'mcp_servers.gh.command="/usr/local/bin/gh-mcp"',
      "-c",
      'mcp_servers.gh.args=["--stdio","quote\\"d"]',
      "-c",
      'mcp_servers.gh.env_vars=["GH_TOKEN"]',
      "-c",
      'mcp_servers.gh.default_tools_approval_mode="approve"',
      "-c",
      'mcp_servers.api.url="https://mcp.example.test/mcp"',
      "-c",
      'mcp_servers.api.env_http_headers={"Authorization"="API_AUTH"}',
      "-c",
      'mcp_servers.api.default_tools_approval_mode="approve"',
      "-c",
      'mcp_servers.echo.command="node"',
      "-c",
      'mcp_servers.echo.args=["/srv/echo.mjs"]',
      "-c",
      'mcp_servers.echo.default_tools_approval_mode="approve"',
      "-c",
      'shell_environment_policy.exclude=["GH_TOKEN","API_AUTH"]',
    ]);
    expect(mcpOverrides([])).toEqual([]);
  });

  it("keeps every isolation flag, adds the servers after the trust override, never a value", () => {
    const without = buildCodexInvocation(args("codex"));
    const withMcp = buildCodexInvocation(args("codex", [gh, api]));
    expect(without.argv.join(" ")).not.toContain("mcp_servers");
    expect(without.sideEffectGuards).not.toContain("codex-mcp-forwarded-only");
    expect(withMcp.sideEffectGuards).toContain("codex-mcp-forwarded-only");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config", "plugins"]) {
      expect(withMcp.argv).toContain(flag);
    }
    const at = withMcp.argv.indexOf("-C");
    expect(withMcp.argv.slice(at - 16, at)).toEqual(mcpOverrides([gh, api]));
    // The secret reaches the codex process env (as Dispatch's runner passed it), never argv/stdin.
    expect(withMcp.argv.join(" ")).not.toContain(SECRET);
    expect(withMcp.stdin).not.toContain(SECRET);
  });

  it("refuses an invalid server name or an sse server (fail closed)", () => {
    const bad = { ...plain, name: "a.b" };
    expect(() => mcpOverrides([bad])).toThrow(/invalid MCP server name/);
    const sse = { ...plain, transport: "sse" as const };
    expect(() => mcpOverrides([sse])).toThrow(/cannot be forwarded/);
  });
});

describe("claude and antigravity cannot receive MCP servers", () => {
  it("claude refuses forwarded servers (--safe-mode drops --mcp-config) but builds without", () => {
    expect(() => buildClaudeInvocation(args("claude", [plain]))).toThrow(/safe-mode/);
    const inv = buildClaudeInvocation(args("claude", []));
    expect(inv.argv).toContain("--safe-mode");
    expect(inv.argv.join(" ")).not.toContain("mcp");
  });

  it("antigravity refuses forwarded servers", () => {
    expect(() => buildAgyInvocation(args("antigravity", [plain]))).toThrow(/never receives MCP/);
    expect(
      buildAgyInvocation({
        ...args("antigravity"),
        probe: { ...probeResult, binaryPath: "/bin/agy", flags: [] },
      }).argv,
    ).toContain("--sandbox");
  });

  it("only codex hosts MCP, and only stdio/http", () => {
    expect(mcpCapableAdapters()).toEqual(["codex"]);
    expect(adapterCanHost("claude", [])).toBe(true);
    expect(adapterCanHost("claude", [plain])).toBe(false);
    expect(adapterCanHost("codex", [plain, api])).toBe(true);
    expect(adapterCanHost("codex", [{ ...plain, transport: "sse" }])).toBe(false);
  });
});

describe("router capability filter", () => {
  it("disables enabled instances whose adapter cannot host the servers", () => {
    const cfg = makeConfig();
    const r = restrictToCapable(cfg, (a) => a === "codex");
    expect(r.remaining).toEqual(
      cfg.instances.filter((i) => i.enabled && i.adapter === "codex").map((i) => i.id),
    );
    expect(r.excluded.length).toBeGreaterThan(0);
    for (const i of r.routing.instances) {
      if (i.adapter !== "codex") expect(i.enabled).toBe(false);
    }
    // The input is not mutated.
    expect(cfg.instances.some((i) => i.adapter !== "codex" && i.enabled)).toBe(true);
  });
});

describe("planMcp (run-time re-resolution)", () => {
  const routing = makeConfig();
  const env = { HOME: "/h", GH_TOKEN: SECRET };
  const resolver =
    (servers: McpServer[], dropped: { name: string; reason: string }[] = []) =>
    () => ({ servers, dropped });

  it("is a no-op without requested servers", () => {
    expect(planMcp({ wanted: [], forwardMcp: false, repoRoot: "/r", env, routing })).toEqual({
      ok: true,
      servers: [],
      routing,
      excluded: [],
    });
  });

  it("returns to host without consent, without forwardable servers, or without a capable host", () => {
    const base = { repoRoot: "/r", env, routing, wanted: ["gh"] };
    expect(planMcp({ ...base, forwardMcp: false })).toEqual({
      ok: false,
      reason: expect.stringContaining("MCP forwarding is off"),
    });
    const dropped = planMcp({
      ...base,
      forwardMcp: true,
      resolve: resolver([], [{ name: "gh", reason: REASONS.literal }]),
    });
    expect(dropped).toEqual({
      ok: false,
      reason: "MCP server(s) cannot be forwarded (gh: literal secret in env/headers)",
    });
    const noCodex = makeConfig({
      instances: routing.instances.filter((i) => i.adapter !== "codex"),
    });
    expect(
      planMcp({ ...base, routing: noCodex, forwardMcp: true, resolve: resolver([gh]) }),
    ).toEqual({ ok: false, reason: expect.stringContaining("no enabled provider can host") });
  });

  it("keeps only capable instances and exposes the variables to forward", () => {
    const p = planMcp({
      ...{ repoRoot: "/r", env, routing },
      wanted: ["gh"],
      forwardMcp: true,
      resolve: resolver([gh]),
    });
    if (!p.ok) throw new Error(p.reason);
    expect(p.servers).toEqual([gh]);
    expect(p.routing.instances.filter((i) => i.enabled).every((i) => i.adapter === "codex")).toBe(
      true,
    );
    expect(mcpVariables(p.servers, env)).toEqual({ names: ["GH_TOKEN"], values: [SECRET] });
    expect(mcpVariables([api], env)).toEqual({ names: ["API_AUTH"], values: [] });
  });
});

describe("hook cache: forwardableMcpFor", () => {
  const cache = (policy: Partial<HookCache["policy"]>): HookCache => ({
    version: 1,
    writtenAt: "2026-11-07T00:00:00.000Z",
    trustedRepos: [
      { root: "/r", policyHash: null, forwardableMcp: ["gh", "proj"] },
      { root: "/other", policyHash: null },
    ],
    policy: { profile: "balance", hardMode: true, summary: "s", ...policy },
  });

  it("prefers the repo list, falls back to the user scope, and is empty without consent", () => {
    const on = cache({ forwardMcp: true, forwardableMcp: ["gh"] });
    expect(forwardableMcpFor(on, "/r/src")).toEqual(["gh", "proj"]);
    expect(forwardableMcpFor(on, "/other")).toEqual(["gh"]);
    expect(forwardableMcpFor(cache({ forwardMcp: true }), "/elsewhere")).toEqual([]);
    expect(forwardableMcpFor(cache({ forwardableMcp: ["gh"] }), "/r")).toEqual([]);
  });
});
