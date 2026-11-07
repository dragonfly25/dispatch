/**
 * `loadEffectiveConfig`: reads defaults, the global config and the trusted repo policy, merges
 * them with the CLI flags (tighten-only for security keys) and returns the router's
 * `RoutingConfig` plus the non-routing `ExecutionConfig`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import { type Autonomy, ExitCode, type Pool, type ProviderInstance } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  type AdapterModelTable,
  type DirectMapping,
  type Preset,
  type Profile,
  type RoutingConfig,
  RoutingConfigSchema,
  type Rule,
} from "../core/routing.js";
import {
  DEFAULT_EFFORT_NAMES,
  DEFAULT_PRESET,
  DEFAULT_PROFILE,
  DEFAULT_TIER_NAMES,
  DEFAULT_UNSPECIFIED_MODEL,
  defaultSettings,
} from "./defaults.js";
import {
  type Issue,
  mergeLayers,
  minAutonomy,
  type NetworkScope,
  type Provenance,
  type Settings,
  type Source,
} from "./merge.js";
import {
  assetsDir as defaultAssetsDir,
  dispatchHome,
  globalConfigPath,
  MAPPINGS_DIR,
  type PathEnv,
  PROFILES_DIR,
} from "./paths.js";
import {
  type ConfigFlags,
  ConfigFlagsSchema,
  GlobalConfigFileSchema,
  type MappingFile,
  MappingFileSchema,
  migrate,
  type Overlay,
  type ProfileFile,
  ProfileFileSchema,
  RepoConfigFileSchema,
  type RuleFile,
} from "./schema.js";
import { checkTrust, type TrustHooks, type TrustStatus } from "./trust.js";

/** A provider instance as the runner needs it. */
export interface ExecutionInstance extends ProviderInstance {
  enabled: boolean;
  plan?: string;
  maxAutonomy: Autonomy;
  concurrency: number;
  envPassthrough: string[];
}

/** Non-routing settings (runner, sandbox, quota). */
export interface ExecutionConfig {
  autonomy: Autonomy;
  instances: ExecutionInstance[];
  concurrency: { perProvider: number; total: number };
  maxDepth: number;
  /** Sandbox network scope after tighten-only merging (default off). */
  network: NetworkScope;
  /** Global `network_agents`: the agents `delegated-agents` is limited to; absent = every one. */
  networkAgents?: string[];
  worktree: { bootstrap: "none" | "symlink-readonly"; symlinkPaths: string[]; keep: boolean };
  timeouts: { defaultTaskMs: number };
  quota: {
    cacheMinutes: number;
    readers: Record<string, { enabled?: boolean; llm_fallback?: boolean }>;
  };
  /** How long `gc` keeps finished runs and history, in days (the loader always sets it; default 30). */
  retentionDays?: number;
  /** MCP forwarding consent after tighten-only merging (absent: false). */
  forwardMcp?: boolean;
  /** Web forwarding after tighten-only merging (absent: true, the default). */
  forwardWeb?: boolean;
}

export interface LoadOptions {
  cwd: string;
  env: PathEnv;
  /** CLI flags as an overlay (same keys as `.dispatch/config.yaml`); validated here. */
  flags?: unknown;
  /** Override of the built-in assets directory (tests). */
  assetsDir?: string;
  /** Test seam for SEC-trust. */
  hooks?: TrustHooks;
}

export interface EffectiveConfig {
  routing: RoutingConfig;
  execution: ExecutionConfig;
  /** True when a repo policy was found, trusted and applied. */
  trusted: boolean;
  trust: { status: TrustStatus; repoId: string | null; hash: string | null; changed: string[] };
  issues: Issue[];
  /** Layer of each top-level setting. */
  provenance: Provenance;
}

/** Builds the effective configuration. Throws `config.*` errors only for a broken global file. */
export function loadEffectiveConfig(opts: LoadOptions): EffectiveConfig {
  const issues: Issue[] = [];
  const home = dispatchHome(opts.env);
  const globalPath = globalConfigPath(opts.env);
  const global = existsSync(globalPath)
    ? parseYaml(readFileSync(globalPath, "utf8"), globalPath, GlobalConfigFileSchema)
    : undefined;

  let flags: ConfigFlags | undefined;
  if (opts.flags !== undefined) {
    const r = ConfigFlagsSchema.safeParse(opts.flags);
    if (r.success) flags = r.data;
    else issues.push({ level: "error", key: "flags", message: zodMessage("flags", r.error) });
  }

  // Layered profile / mapping files: defaults < global home < trusted repo.
  const profiles: Layered<ProfileFile> = [];
  const mappings: Layered<MappingFile> = [];
  const assets = opts.assetsDir ?? defaultAssetsDir();
  for (const sub of [PROFILES_DIR, MAPPINGS_DIR, "models"]) {
    for (const f of listYaml(join(assets, sub))) {
      const text = readFileSync(f, "utf8");
      if (sub === PROFILES_DIR)
        profiles.push(["default", f, parseYaml(text, f, ProfileFileSchema)]);
      else mappings.push(["default", f, parseYaml(text, f, MappingFileSchema)]);
    }
  }
  const tryParse = <T>(text: string, source: string, schema: z.ZodType<T>): T | undefined => {
    try {
      return parseYaml(text, source, schema);
    } catch (err) {
      issues.push({ level: "error", key: source, message: (err as Error).message });
      return undefined;
    }
  };
  const collect = (src: Source, path: string, text: string, sub: string) => {
    if (sub === PROFILES_DIR) {
      const p = tryParse(text, path, ProfileFileSchema);
      if (p) profiles.push([src, path, p]);
    } else {
      const m = tryParse(text, path, MappingFileSchema);
      if (m) mappings.push([src, path, m]);
    }
  };
  for (const sub of [PROFILES_DIR, MAPPINGS_DIR]) {
    for (const f of listYaml(join(home, sub))) collect("global", f, readFileSync(f, "utf8"), sub);
  }

  const trust = checkTrust(opts.cwd, global?.trusted_repos ?? {}, opts.hooks);
  let repo: Overlay | undefined;
  if (trust.status === "trusted" && trust.policy) {
    // Parse the very buffers that were hashed (no second read: SEC-trust TOCTOU).
    for (const { rel, bytes } of trust.policy.files) {
      const text = bytes.toString("utf8");
      const sub = rel.split("/")[1] ?? "";
      if (sub === PROFILES_DIR || sub === MAPPINGS_DIR) collect("repo", rel, text, sub);
      else {
        const parsed = tryParse(text, rel, RepoConfigFileSchema);
        if (parsed) {
          const { version: _v, ...overlay } = parsed;
          repo = overlay;
        }
      }
    }
  } else if (trust.status !== "none") {
    issues.push({ level: "warning", key: "trust", message: trustMessage(trust) });
  }

  const merged = mergeLayers({ defaults: defaultSettings(), global, repo, flags });
  issues.push(...merged.issues);
  const { settings: s, provenance } = merged;

  // ---- routing ----
  const profileMap: Record<string, Profile> = {};
  let profilesSrc: Source = "default";
  for (const [src, path, p] of profiles) {
    profileMap[stem(path)] = compact({ description: p.description, rules: p.rules.map(toRule) });
    profilesSrc = src;
  }
  const presets: Record<string, Preset> = {};
  const models: Record<string, AdapterModelTable> = {};
  let presetsSrc: Source = "default";
  let modelsSrc: Source = "default";
  for (const [src, path, m] of mappings) {
    if (m.preset) {
      presets[stem(path)] = compact({
        description: m.preset.description ?? m.description,
        effortShift: m.preset.effort_shift ?? 0,
        tierByTaskType: m.preset.tier_by_task_type ?? {},
      });
      presetsSrc = src;
    }
    for (const [adapter, t] of Object.entries(m.models ?? {})) {
      models[adapter] = {
        tiers: Object.fromEntries(
          Object.entries(t.tiers).map(([tier, v]) => [
            tier,
            { model: v.model, effort: v.effort, relativeCost: v.relative_cost },
          ]),
        ),
        reverse: t.reverse,
      };
      modelsSrc = src;
    }
  }

  const pick = (key: keyof Settings, what: string, value: string, known: object, fb: string) => {
    if (value in known) return value;
    issues.push({
      level: "error",
      key: what,
      message: `unknown ${what} "${value}"; using "${fb}"`,
    });
    provenance[key] = "default";
    return fb;
  };
  const activeProfile = pick("profile", "profile", s.profile, profileMap, DEFAULT_PROFILE);
  const activePreset = pick(
    "mappings",
    "mappings.preset",
    s.mappings.preset,
    presets,
    DEFAULT_PRESET,
  );
  const shadowProfiles = s.shadow_profiles.filter((p) => {
    if (p in profileMap) return true;
    issues.push({ level: "error", key: "shadow_profiles", message: `unknown profile "${p}"` });
    return false;
  });
  const tiers = [...DEFAULT_TIER_NAMES];
  let unspecifiedModel = s.unspecified_model;
  if (!["inherit", "classify", ...tiers].includes(unspecifiedModel)) {
    issues.push({
      level: "error",
      key: "unspecified_model",
      message: `unknown tier "${unspecifiedModel}"; using "${DEFAULT_UNSPECIFIED_MODEL}"`,
    });
    unspecifiedModel = DEFAULT_UNSPECIFIED_MODEL;
  }

  const instances: ExecutionInstance[] = Object.entries(s.providers).map(([id, p]) =>
    compact({
      id,
      adapter: p.adapter,
      configDir: p.config_dir,
      pool: p.pool as Pool,
      binary: p.binary,
      plan: p.plan,
      enabled: p.enabled && (s.allowed_providers?.includes(id) ?? true),
      maxAutonomy: minAutonomy(p.max_autonomy, s.autonomy),
      concurrency: Math.min(
        p.concurrency ?? s.concurrency.per_provider,
        s.concurrency.per_provider,
      ),
      envPassthrough: p.env_passthrough,
    }),
  );

  const routing = RoutingConfigSchema.parse({
    version: 1,
    tiers,
    efforts: [...DEFAULT_EFFORT_NAMES],
    instances: instances.map((i) => ({
      id: i.id,
      adapter: i.adapter,
      pool: i.pool,
      enabled: i.enabled,
      maxAutonomy: i.maxAutonomy,
      concurrency: i.concurrency,
      thresholds: s.providers[i.id]?.thresholds,
      effortShift: s.providers[i.id]?.effort_shift,
    })),
    models,
    pins: s.pins.map(toRule),
    directMappings: s.mappings.direct.map(
      (d): DirectMapping =>
        compact({
          fromModel: d.from_model,
          fromEffort: d.from_effort,
          instance: d.instance,
          model: d.model,
          effort: d.effort,
        }),
    ),
    activeProfile,
    profiles: profileMap,
    activePreset,
    presets,
    unspecifiedModel,
    maxAutonomy: s.autonomy,
    shadowProfiles,
    provenance: {
      tiers: "default",
      efforts: "default",
      instances: provenance.providers,
      models: modelsSrc,
      pins: provenance.pins,
      directMappings: provenance.mappings,
      activeProfile: provenance.profile,
      profiles: profilesSrc,
      activePreset: provenance.mappings,
      presets: presetsSrc,
      unspecifiedModel: provenance.unspecified_model,
      maxAutonomy: provenance.autonomy,
      shadowProfiles: provenance.shadow_profiles,
    },
  });

  const execution: ExecutionConfig = {
    autonomy: s.autonomy,
    instances,
    concurrency: { perProvider: s.concurrency.per_provider, total: s.concurrency.total },
    maxDepth: s.max_depth,
    network: s.network,
    ...(s.network_agents === null ? {} : { networkAgents: s.network_agents }),
    worktree: {
      bootstrap: s.worktree.bootstrap,
      symlinkPaths: s.worktree.symlink_paths,
      keep: s.worktree.keep,
    },
    timeouts: { defaultTaskMs: s.timeouts.default_task_ms },
    quota: { cacheMinutes: s.quota.cache_minutes, readers: s.quota.readers },
    retentionDays: s.retention_days,
    forwardMcp: s.forward_mcp,
    forwardWeb: s.forward_web,
  };

  return {
    routing,
    execution,
    trusted: trust.status === "trusted",
    trust: {
      status: trust.status,
      repoId: trust.repo?.id ?? null,
      hash: trust.policy?.hash ?? null,
      changed: trust.changed,
    },
    issues,
    provenance,
  };
}

type Layered<T> = [Source, string, T][];

/** Parses YAML text, migrates it and validates it; throws a `config.invalid` DispatchError. */
export function parseYaml<T>(text: string, source: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new DispatchError(
      `${source}: invalid YAML: ${(err as Error).message}`,
      ExitCode.USAGE,
      "config.invalid",
    );
  }
  const r = schema.safeParse(migrate(raw, source));
  if (!r.success) {
    throw new DispatchError(zodMessage(source, r.error), ExitCode.USAGE, "config.invalid");
  }
  return r.data;
}

function zodMessage(source: string, err: z.ZodError): string {
  return err.issues
    .map((i) => `${source}: ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function trustMessage(t: ReturnType<typeof checkTrust>): string {
  switch (t.status) {
    case "symlink":
      return `repo policy ignored: ${t.policy?.symlink} is a symlink`;
    case "changed":
      return `repo policy ignored: changed since \`dispatch trust\`: ${t.changed.join(", ")}`;
    default:
      return "repo policy ignored: run `dispatch trust` to apply .dispatch/";
  }
}

function listYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".yaml"))
    .sort()
    .map((n) => join(dir, n));
}

const stem = (path: string) => basename(path, ".yaml");

/** File rule (snake_case) → routing rule. */
function toRule(r: RuleFile): Rule {
  const m = r.match ?? {};
  return compact({
    id: r.id,
    description: r.description,
    match: compact({
      taskType: m.task_type,
      paths: m.paths,
      tier: m.tier,
      autonomy: m.autonomy,
      minRemainingPct: m.min_remaining_pct,
      reliability: m.reliability,
      priorOutcome: m.prior_outcome,
    }),
    action: r.action,
  });
}

/** Drops `undefined` properties (keeps snapshots and strict schemas clean). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
