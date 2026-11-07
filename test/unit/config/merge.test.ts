import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../../src/config/defaults.js";
import {
  AUTONOMY_ORDER,
  BOOTSTRAP_ORDER,
  mergeLayers,
  NETWORK_ORDER,
  type Settings,
} from "../../../src/config/merge.js";
import type { GlobalConfigFile, Overlay } from "../../../src/config/schema.js";

const G = (g: Partial<GlobalConfigFile> = {}): GlobalConfigFile => ({ version: 1, ...g });

describe("ordinary keys: flags > repo > global > defaults", () => {
  const cases: [string | undefined, string | undefined, string | undefined, string, string][] = [
    [undefined, undefined, undefined, "balance", "default"],
    ["preserve", undefined, undefined, "preserve", "global"],
    ["preserve", "specialize", undefined, "specialize", "repo"],
    ["preserve", "specialize", "off", "off", "flag"],
    [undefined, undefined, "off", "off", "flag"],
    [undefined, "specialize", undefined, "specialize", "repo"],
  ];
  it.each(cases)("global=%s repo=%s flag=%s → %s (%s)", (g, r, f, want, src) => {
    const res = mergeLayers({
      defaults: defaultSettings(),
      global: G({ profile: g }),
      repo: { profile: r },
      flags: { profile: f },
    });
    expect(res.settings.profile).toBe(want);
    expect(res.provenance.profile).toBe(src);
    expect(res.issues).toEqual([]);
  });

  it("merges mappings, timeouts, thresholds and effort_shift", () => {
    const res = mergeLayers({
      defaults: defaultSettings(),
      global: G({
        mappings: { preset: "economy" },
        timeouts: { default_task_ms: 1000 },
        quota: { readers: { codex: { enabled: false } } },
        providers: { codex: { thresholds: { soft: 50, hard: 25 } } },
      }),
      repo: {
        mappings: { direct: [{ from_model: "a", instance: "codex", model: "m", effort: "e" }] },
        thresholds: { codex: { soft: 40, hard: 10 }, ghost: { soft: 1, hard: 0 } },
        providers: { codex: { effort_shift: -1 } },
      },
    });
    const s = res.settings;
    expect(s.mappings.preset).toBe("economy");
    expect(s.mappings.direct).toHaveLength(1);
    expect(s.timeouts.default_task_ms).toBe(1000);
    expect(s.quota).toEqual({ cache_minutes: 5, readers: { codex: { enabled: false } } });
    expect(s.providers.codex?.thresholds).toEqual({ soft: 40, hard: 10 });
    expect(s.providers.codex?.effort_shift).toBe(-1);
    expect(res.issues).toEqual([
      { level: "warning", key: "thresholds.ghost", message: 'unknown instance "ghost"' },
    ]);
  });
});

describe("[SEC-flags] security keys are tighten-only", () => {
  const global = G({
    autonomy: "worktree",
    allowed_providers: ["claude", "codex"],
    concurrency: { per_provider: 2, total: 3 },
    max_depth: 1,
    network: "off",
    worktree: { bootstrap: "none", symlink_paths: ["node_modules"], keep: false },
    providers: {
      codex: { binary: "/opt/codex", env_passthrough: ["A", "B"], concurrency: 2 },
      paid: { adapter: "claude", pool: "api_credit", enabled: false },
    },
  });

  it("accepts tightening from repo and flags", () => {
    const res = mergeLayers({
      defaults: defaultSettings(),
      global,
      repo: {
        autonomy: "read-only",
        allowed_providers: ["codex"],
        concurrency: { per_provider: 1 },
        worktree: { symlink_paths: [] },
        providers: {
          codex: { env_passthrough: ["A"], max_autonomy: "worktree", binary: "/opt/codex" },
        },
      },
      flags: {
        max_depth: 0,
        concurrency: { total: 1 },
        worktree: { bootstrap: "none", keep: false },
        network: "off",
        providers: { claude: { enabled: false, concurrency: 1 } },
      },
    });
    expect(res.issues).toEqual([]);
    const s = res.settings;
    expect(s.autonomy).toBe("read-only");
    expect(s.allowed_providers).toEqual(["codex"]);
    expect(s.concurrency).toEqual({ per_provider: 1, total: 1 });
    expect(s.max_depth).toBe(0);
    expect(s.worktree.symlink_paths).toEqual([]);
    expect(s.providers.codex?.env_passthrough).toEqual(["A"]);
    expect(s.providers.claude).toMatchObject({ enabled: false, concurrency: 1 });
    expect(res.provenance).toMatchObject({ autonomy: "repo", max_depth: "flag", worktree: "flag" });
  });

  it("ignores and reports every loosening attempt", () => {
    const loosen: Overlay = {
      autonomy: "direct",
      allowed_providers: ["claude", "codex", "antigravity"],
      concurrency: { per_provider: 9, total: 9 },
      max_depth: 5,
      network: "on",
      worktree: { bootstrap: "symlink-readonly", symlink_paths: ["node_modules", "/"], keep: true },
      providers: {
        codex: { binary: "/tmp/evil", env_passthrough: ["A", "B", "SECRET"], concurrency: 9 },
        paid: { enabled: true },
        claude: { max_autonomy: "direct" },
        ghost: { enabled: false },
      },
    };
    for (const layer of ["repo", "flags"] as const) {
      const base = mergeLayers({ defaults: defaultSettings(), global });
      const res = mergeLayers({ defaults: defaultSettings(), global, [layer]: loosen });
      expect(res.issues.every((i) => i.level === "error")).toBe(true);
      expect(res.issues.map((i) => i.key).sort()).toEqual(
        [
          "allowed_providers",
          "autonomy",
          "concurrency.per_provider",
          "concurrency.total",
          "max_depth",
          "network",
          "providers.codex.binary",
          "providers.codex.concurrency",
          "providers.codex.env_passthrough",
          "providers.ghost",
          "providers.paid.enabled",
          "worktree.bootstrap",
          "worktree.keep",
          "worktree.symlink_paths",
        ].sort(),
      );
      expect(res.issues[0]?.message).toMatch(layer === "repo" ? /^repo config/ : /^flag/);
      // claude max_autonomy "direct" equals its global value: not a loosening.
      expect(res.settings).toEqual(base.settings);
    }
  });

  it("caps antigravity to read-only and requires the ToS acknowledgement", () => {
    const res = mergeLayers({
      defaults: defaultSettings(),
      global: G({ providers: { antigravity: { enabled: true, max_autonomy: "direct" } } }),
    });
    expect(res.settings.providers.antigravity).toMatchObject({
      enabled: false,
      max_autonomy: "read-only",
    });
    expect(res.issues.map((i) => i.key)).toEqual([
      "providers.antigravity.max_autonomy",
      "providers.antigravity.tos_acknowledged",
    ]);
    const ok = mergeLayers({
      defaults: defaultSettings(),
      global: G({ providers: { antigravity: { enabled: true, tos_acknowledged: true } } }),
    });
    expect(ok.settings.providers.antigravity?.enabled).toBe(true);
    expect(ok.issues).toEqual([]);
  });

  // Property: whatever repo and flags say, every security value is at most as permissive as
  // what the global config (over defaults) yields.
  const autonomy = fc.constantFrom(...AUTONOMY_ORDER);
  const ids = fc.subarray(["claude", "codex", "antigravity", "x"]);
  const vars = fc.subarray(["A", "B", "C"]);
  const pos = fc.integer({ min: 1, max: 6 });
  const providerOverlay = fc.record(
    {
      enabled: fc.boolean(),
      max_autonomy: autonomy,
      concurrency: pos,
      env_passthrough: vars,
      binary: fc.constantFrom("/a", "/b"),
    },
    { requiredKeys: [] },
  );
  const securityLayer = fc.record(
    {
      autonomy,
      allowed_providers: ids,
      concurrency: fc.record({ per_provider: pos, total: pos }, { requiredKeys: [] }),
      max_depth: fc.integer({ min: 0, max: 4 }),
      network: fc.constantFrom(...NETWORK_ORDER),
      worktree: fc.record(
        {
          bootstrap: fc.constantFrom(...BOOTSTRAP_ORDER),
          symlink_paths: fc.subarray(["node_modules", ".venv", "/"]),
          keep: fc.boolean(),
        },
        { requiredKeys: [] },
      ),
      providers: fc.dictionary(fc.constantFrom("claude", "codex", "antigravity"), providerOverlay),
    },
    { requiredKeys: [] },
  );
  const globalLayer = securityLayer.map((s) => {
    const { providers, ...rest } = s;
    return G({ ...rest, providers: providers as GlobalConfigFile["providers"] });
  });

  it("property: no combination of repo/flag values is looser than global", () => {
    fc.assert(
      fc.property(globalLayer, securityLayer, securityLayer, (global, repo, flags) => {
        const base = mergeLayers({ defaults: defaultSettings(), global }).settings;
        const eff = mergeLayers({ defaults: defaultSettings(), global, repo, flags }).settings;
        assertNotLooser(eff, base);
      }),
      { numRuns: 500 },
    );
  });
});

function assertNotLooser(eff: Settings, base: Settings): void {
  const rank = <T>(order: readonly T[], v: T) => order.indexOf(v);
  expect(rank(AUTONOMY_ORDER, eff.autonomy)).toBeLessThanOrEqual(
    rank(AUTONOMY_ORDER, base.autonomy),
  );
  if (base.allowed_providers) {
    expect(eff.allowed_providers?.every((p) => base.allowed_providers?.includes(p))).toBe(true);
  }
  expect(eff.concurrency.per_provider).toBeLessThanOrEqual(base.concurrency.per_provider);
  expect(eff.concurrency.total).toBeLessThanOrEqual(base.concurrency.total);
  expect(eff.max_depth).toBeLessThanOrEqual(base.max_depth);
  expect(rank(NETWORK_ORDER, eff.network)).toBeLessThanOrEqual(rank(NETWORK_ORDER, base.network));
  expect(rank(BOOTSTRAP_ORDER, eff.worktree.bootstrap)).toBeLessThanOrEqual(
    rank(BOOTSTRAP_ORDER, base.worktree.bootstrap),
  );
  expect(eff.worktree.symlink_paths.every((p) => base.worktree.symlink_paths.includes(p))).toBe(
    true,
  );
  if (!base.worktree.keep) expect(eff.worktree.keep).toBe(false);
  expect(Object.keys(eff.providers).sort()).toEqual(Object.keys(base.providers).sort());
  for (const [id, b] of Object.entries(base.providers)) {
    const e = eff.providers[id];
    if (!e) throw new Error(`missing ${id}`);
    if (!b.enabled) expect(e.enabled).toBe(false);
    expect(rank(AUTONOMY_ORDER, e.max_autonomy)).toBeLessThanOrEqual(
      rank(AUTONOMY_ORDER, b.max_autonomy),
    );
    expect(e.concurrency ?? eff.concurrency.per_provider).toBeLessThanOrEqual(
      b.concurrency ?? base.concurrency.per_provider,
    );
    expect(e.env_passthrough.every((v) => b.env_passthrough.includes(v))).toBe(true);
    expect(e.binary).toBe(b.binary);
    expect(e.pool).toBe(b.pool);
    expect(e.config_dir).toBe(b.config_dir);
  }
}
