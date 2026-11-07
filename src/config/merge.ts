/**
 * Layering (plan §2 "Config"): defaults → global → trusted repo → flags.
 *
 * Ordinary keys: the later layer wins. SECURITY keys (autonomy, allowed_providers, concurrency,
 * max_depth, network, worktree.*, and per-instance enabled / binary / max_autonomy /
 * concurrency / env_passthrough) take the most restrictive value of global, repo and flags.
 * A repo or flag value that would loosen is ignored and reported as an error issue
 * (`run` maps those to exit 2). The global file is the user's own and may set anything,
 * except the hard caps applied last (antigravity is always read-only).
 */

import type { z } from "zod";
import type { Autonomy, Pool } from "../core/contracts.js";
import type { DirectMappingFileSchema, GlobalConfigFile, Overlay, RuleFile } from "./schema.js";

/** A problem found while loading config. Errors make `run` exit 2. */
export interface Issue {
  level: "error" | "warning";
  /** Dotted config key, e.g. "autonomy" or "providers.codex.enabled". */
  key: string;
  message: string;
}

/** Which layer a top-level value came from. */
export type Source = "default" | "global" | "repo" | "flag";

/** A provider instance after merging. */
export interface MergedProvider {
  adapter: string;
  enabled: boolean;
  plan?: string;
  pool: Pool;
  config_dir?: string;
  binary?: string;
  max_autonomy: Autonomy;
  concurrency?: number;
  thresholds: { soft: number; hard: number };
  effort_shift: number;
  env_passthrough: string[];
  tos_acknowledged: boolean;
}

/** The fully merged settings (file vocabulary, every key resolved). */
export interface Settings {
  providers: Record<string, MergedProvider>;
  autonomy: Autonomy;
  /** `null` = every instance. */
  allowed_providers: string[] | null;
  concurrency: { per_provider: number; total: number };
  max_depth: number;
  network: "off" | "on";
  worktree: { bootstrap: "none" | "symlink-readonly"; symlink_paths: string[]; keep: boolean };
  unspecified_model: string;
  pins: RuleFile[];
  mappings: { preset: string; direct: z.infer<typeof DirectMappingFileSchema>[] };
  profile: string;
  shadow_profiles: string[];
  timeouts: { default_task_ms: number };
  quota: { cache_minutes: number; readers: Record<string, { enabled: boolean }> };
}

export type Provenance = Record<keyof Settings, Source>;

/** Autonomy levels, least permissive first. */
export const AUTONOMY_ORDER: readonly Autonomy[] = ["read-only", "worktree", "direct"];
export const NETWORK_ORDER = ["off", "on"] as const;
export const BOOTSTRAP_ORDER = ["none", "symlink-readonly"] as const;

/** The more restrictive of two autonomy levels. */
export function minAutonomy(a: Autonomy, b: Autonomy): Autonomy {
  return AUTONOMY_ORDER.indexOf(a) <= AUTONOMY_ORDER.indexOf(b) ? a : b;
}

export interface MergeInput {
  defaults: Settings;
  global?: GlobalConfigFile;
  repo?: Overlay;
  flags?: Overlay;
}

export interface MergeResult {
  settings: Settings;
  provenance: Provenance;
  issues: Issue[];
}

/** Merges the layers; never throws. */
export function mergeLayers(input: MergeInput): MergeResult {
  const settings = structuredClone(input.defaults);
  const provenance = Object.fromEntries(
    Object.keys(settings).map((k) => [k, "default"]),
  ) as Provenance;
  const issues: Issue[] = [];
  if (input.global) applyGlobal(settings, input.global, provenance, issues);
  if (input.repo) applyOverlay(settings, input.repo, "repo", provenance, issues);
  if (input.flags) applyOverlay(settings, input.flags, "flag", provenance, issues);
  applyHardCaps(settings, issues);
  return { settings, provenance, issues };
}

/** A new instance with the defaults' generic values. */
export function newProvider(adapter: string): MergedProvider {
  return {
    adapter,
    enabled: true,
    pool: "subscription",
    max_autonomy: "direct",
    thresholds: { soft: 20, hard: 5 },
    effort_shift: 0,
    env_passthrough: [],
    tos_acknowledged: false,
  };
}

function applyGlobal(s: Settings, g: GlobalConfigFile, prov: Provenance, issues: Issue[]): void {
  for (const [id, p] of Object.entries(g.providers ?? {})) {
    const cur = s.providers[id] ?? newProvider(p.adapter ?? id);
    const defined = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    s.providers[id] = { ...cur, ...defined };
    prov.providers = "global";
  }
  const set = <K extends keyof Settings>(key: K, value: Settings[K] | undefined) => {
    if (value === undefined) return;
    s[key] = value;
    prov[key] = "global";
  };
  set("autonomy", g.autonomy);
  if (g.allowed_providers) set("allowed_providers", g.allowed_providers);
  if (g.concurrency) set("concurrency", { ...s.concurrency, ...defined(g.concurrency) });
  set("max_depth", g.max_depth);
  set("network", g.network);
  if (g.worktree) set("worktree", { ...s.worktree, ...defined(g.worktree) });
  if (g.quota) {
    set("quota", {
      cache_minutes: g.quota.cache_minutes ?? s.quota.cache_minutes,
      readers: { ...s.quota.readers, ...g.quota.readers },
    });
  }
  applyOrdinary(s, g, "global", prov, issues);
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Keys every layer may override freely. */
function applyOrdinary(
  s: Settings,
  o: Overlay | GlobalConfigFile,
  src: Source,
  prov: Provenance,
  issues: Issue[],
): void {
  const set = <K extends keyof Settings>(key: K, value: Settings[K] | undefined) => {
    if (value === undefined) return;
    s[key] = value;
    prov[key] = src;
  };
  set("unspecified_model", o.unspecified_model);
  set("pins", o.pins);
  set("profile", o.profile);
  set("shadow_profiles", o.shadow_profiles);
  if (o.mappings) set("mappings", { ...s.mappings, ...defined(o.mappings) });
  const ms = o.timeouts?.default_task_ms;
  if (ms !== undefined) set("timeouts", { default_task_ms: ms });
  for (const [id, t] of Object.entries(o.thresholds ?? {})) {
    const p = s.providers[id];
    if (!p) {
      issues.push({
        level: "warning",
        key: `thresholds.${id}`,
        message: `unknown instance "${id}"`,
      });
      continue;
    }
    p.thresholds = t;
    prov.providers = src;
  }
}

function applyOverlay(
  s: Settings,
  o: Overlay,
  src: "repo" | "flag",
  prov: Provenance,
  issues: Issue[],
): void {
  const who = src === "repo" ? "repo config" : "flag";
  const loosen = (key: string, detail: string) =>
    issues.push({
      level: "error",
      key,
      message: `${who} tries to loosen security key ${key} (${detail}); ignored`,
    });
  const accept = (key: keyof Settings) => {
    prov[key] = src;
  };

  if (o.autonomy !== undefined) {
    const r = tightenRank(AUTONOMY_ORDER, s.autonomy, o.autonomy);
    if (r === null) loosen("autonomy", `${o.autonomy} > ${s.autonomy}`);
    else {
      s.autonomy = r;
      accept("autonomy");
    }
  }
  if (o.allowed_providers !== undefined) {
    const { value, extra } = tightenList(s.allowed_providers, o.allowed_providers);
    if (extra.length) loosen("allowed_providers", `adds ${extra.join(", ")}`);
    s.allowed_providers = value;
    accept("allowed_providers");
  }
  for (const k of ["per_provider", "total"] as const) {
    const v = o.concurrency?.[k];
    if (v === undefined) continue;
    if (v > s.concurrency[k]) loosen(`concurrency.${k}`, `${v} > ${s.concurrency[k]}`);
    else {
      s.concurrency[k] = v;
      accept("concurrency");
    }
  }
  if (o.max_depth !== undefined) {
    if (o.max_depth > s.max_depth) loosen("max_depth", `${o.max_depth} > ${s.max_depth}`);
    else {
      s.max_depth = o.max_depth;
      accept("max_depth");
    }
  }
  if (o.network !== undefined) {
    const r = tightenRank(NETWORK_ORDER, s.network, o.network);
    if (r === null) loosen("network", `${o.network} > ${s.network}`);
    else {
      s.network = r;
      accept("network");
    }
  }
  const wt = o.worktree;
  if (wt?.bootstrap !== undefined) {
    const r = tightenRank(BOOTSTRAP_ORDER, s.worktree.bootstrap, wt.bootstrap);
    if (r === null) loosen("worktree.bootstrap", `${wt.bootstrap} > ${s.worktree.bootstrap}`);
    else {
      s.worktree.bootstrap = r;
      accept("worktree");
    }
  }
  if (wt?.symlink_paths !== undefined) {
    const { value, extra } = tightenList(s.worktree.symlink_paths, wt.symlink_paths);
    if (extra.length) loosen("worktree.symlink_paths", `adds ${extra.join(", ")}`);
    s.worktree.symlink_paths = value ?? [];
    accept("worktree");
  }
  if (wt?.keep !== undefined) {
    if (wt.keep && !s.worktree.keep) loosen("worktree.keep", "enables keep");
    else {
      s.worktree.keep = wt.keep;
      accept("worktree");
    }
  }

  for (const [id, p] of Object.entries(o.providers ?? {})) {
    const cur = s.providers[id];
    const key = `providers.${id}`;
    if (!cur) {
      issues.push({
        level: "error",
        key,
        message: `${who} cannot add instance "${id}"; instances come from the global config`,
      });
      continue;
    }
    accept("providers");
    if (p.enabled !== undefined) {
      if (p.enabled && !cur.enabled) loosen(`${key}.enabled`, "enables a disabled instance");
      else cur.enabled = p.enabled;
    }
    if (p.max_autonomy !== undefined) {
      const r = tightenRank(AUTONOMY_ORDER, cur.max_autonomy, p.max_autonomy);
      if (r === null) loosen(`${key}.max_autonomy`, `${p.max_autonomy} > ${cur.max_autonomy}`);
      else cur.max_autonomy = r;
    }
    if (p.concurrency !== undefined) {
      const limit = cur.concurrency ?? s.concurrency.per_provider;
      if (p.concurrency > limit) loosen(`${key}.concurrency`, `${p.concurrency} > ${limit}`);
      else cur.concurrency = p.concurrency;
    }
    if (p.env_passthrough !== undefined) {
      const { value, extra } = tightenList(cur.env_passthrough, p.env_passthrough);
      if (extra.length) loosen(`${key}.env_passthrough`, `adds ${extra.join(", ")}`);
      cur.env_passthrough = value ?? [];
    }
    if (p.binary !== undefined && p.binary !== cur.binary) {
      loosen(`${key}.binary`, "a binary path can only be set in the global config");
    }
    if (p.effort_shift !== undefined) cur.effort_shift = p.effort_shift;
  }

  applyOrdinary(s, o, src, prov, issues);
}

/** `cand` if it is not looser than `cur` in `order`, else `null`. */
function tightenRank<T extends string>(order: readonly T[], cur: T, cand: T): T | null {
  return order.indexOf(cand) <= order.indexOf(cur) ? cand : null;
}

/** Intersection of `cur` (null = everything) and `cand`; `extra` lists what `cand` adds. */
function tightenList(cur: string[] | null, cand: string[]): { value: string[]; extra: string[] } {
  if (cur === null) return { value: [...cand], extra: [] };
  return {
    value: cand.filter((x) => cur.includes(x)),
    extra: cand.filter((x) => !cur.includes(x)),
  };
}

/** Caps nobody can lift: antigravity runs read-only and needs a ToS acknowledgement. */
function applyHardCaps(s: Settings, issues: Issue[]): void {
  for (const [id, p] of Object.entries(s.providers)) {
    if (p.adapter !== "antigravity") continue;
    if (p.max_autonomy !== "read-only") {
      issues.push({
        level: "warning",
        key: `providers.${id}.max_autonomy`,
        message: "antigravity is read-only in v0.1; capped to read-only",
      });
      p.max_autonomy = "read-only";
    }
    if (p.enabled && p.pool === "subscription" && !p.tos_acknowledged) {
      issues.push({
        level: "warning",
        key: `providers.${id}.tos_acknowledged`,
        message: "antigravity with a consumer login needs tos_acknowledged: true; kept disabled",
      });
      p.enabled = false;
    }
  }
}
