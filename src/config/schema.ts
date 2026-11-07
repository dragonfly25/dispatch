/**
 * User-facing YAML file schemas (snake_case). Every field carries `.describe()` so the config
 * reference (WP30) can be generated from these schemas.
 *
 * File schemas declare no defaults: absence matters for layering and provenance. Built-in
 * defaults live in `defaults.ts`; `load.ts` turns the merged result into a `RoutingConfig`.
 */
import { z } from "zod";
import { AutonomySchema, ExitCode, PoolSchema, ReliabilitySchema } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { RuleActionSchema, UnspecifiedModelSchema } from "../core/routing.js";

const Id = z.string().min(1);
const Names = z.array(Id);

/** Current version of every config file kind. */
export const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Rules, mappings, models
// ---------------------------------------------------------------------------

export const RuleMatchFileSchema = z
  .object({
    task_type: Names.optional().describe("Task types, e.g. [test, docs]."),
    paths: Names.optional().describe("Repo-relative globs; any task path matching any glob."),
    tier: Names.optional().describe("Resolved tiers of the task."),
    autonomy: z.array(AutonomySchema).optional().describe("Requested autonomy levels."),
    min_remaining_pct: z
      .record(Id, z.number().min(0).max(100))
      .optional()
      .describe("Minimum remaining quota (0-100) per instance id; unknown usage never matches."),
    reliability: z
      .array(ReliabilitySchema)
      .optional()
      .describe("Accepted reliabilities of the quota data of the instances in the action."),
    prior_outcome: z
      .array(z.enum(["failed", "timeout", "quota_exhausted", "rejected"]))
      .optional()
      .describe("Matches when an earlier task of the session had one of these outcomes."),
  })
  .strict()
  .describe("Conditions; all present fields must hold. Empty matches every task.");

export const RuleFileSchema = z
  .object({
    id: Id.describe("Rule id, shown in the rule chain of `explain`."),
    description: z.string().optional().describe("Free text."),
    match: RuleMatchFileSchema.optional(),
    action: RuleActionSchema.describe(
      "provider{instance} | host | fallback{instances, strategy: ordered|most_remaining} | fanout{instances} | reject{reason}.",
    ),
  })
  .strict();
export type RuleFile = z.infer<typeof RuleFileSchema>;

export const DirectMappingFileSchema = z
  .object({
    from_model: Id.describe("Host model glob, e.g. claude-opus-*."),
    from_effort: Id.optional().describe("Host effort; absent matches any."),
    instance: Id.describe("Target instance id."),
    model: Id.describe("Target model."),
    effort: Id.describe("Target native effort."),
  })
  .strict();

export const PresetFileSchema = z
  .object({
    description: z.string().optional(),
    effort_shift: z.number().int().optional().describe("Effort levels to shift when delegating."),
    tier_by_task_type: z
      .record(Id, Id)
      .optional()
      .describe("Task type → tier override, e.g. { test: fast }."),
  })
  .strict();

export const AdapterModelTableFileSchema = z
  .object({
    tiers: z
      .record(
        Id,
        z
          .object({
            model: Id.describe("Native model name."),
            effort: z.record(Id, Id).describe("Dispatch effort → native effort."),
            relative_cost: z.number().positive().describe("Indicative cost; 1 = cheapest."),
          })
          .strict(),
      )
      .describe("Tier → model."),
    reverse: z
      .array(z.object({ pattern: Id, tier: Id }).strict())
      .describe("Ordered model-glob → tier list used to classify the host's model."),
  })
  .strict();

const ThresholdsFileSchema = z
  .object({
    soft: z.number().min(0).max(100).describe("Below this remaining %, avoid if possible."),
    hard: z.number().min(0).max(100).describe("Below this remaining %, never use."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Keys shared by every layer
// ---------------------------------------------------------------------------

/** Security keys: tighten-only in repo config and flags (plan §2 "Config"). */
const securityKeys = {
  autonomy: AutonomySchema.optional().describe(
    "SECURITY. Autonomy ceiling for delegated tasks (read-only < worktree < direct).",
  ),
  allowed_providers: Names.optional().describe(
    "SECURITY. Instance ids that may be used; absent = every enabled instance.",
  ),
  concurrency: z
    .object({
      per_provider: z.number().int().positive().optional(),
      total: z.number().int().positive().optional(),
    })
    .strict()
    .optional()
    .describe("SECURITY. Max concurrent runs per instance and overall."),
  max_depth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("SECURITY. `run` refuses when DISPATCH_DEPTH >= max_depth (default 1)."),
  network: z.enum(["off", "on"]).optional().describe("SECURITY. Network access for children."),
  worktree: z
    .object({
      bootstrap: z
        .enum(["none", "symlink-readonly"])
        .optional()
        .describe("How dependencies are made available in a worktree."),
      symlink_paths: Names.optional().describe("Paths symlinked read-only by symlink-readonly."),
      keep: z.boolean().optional().describe("Keep worktrees after a run (keep_worktrees)."),
    })
    .strict()
    .optional()
    .describe("SECURITY. Worktree sandbox settings."),
};

/** Ordinary keys: flags > trusted repo > global > defaults. */
const ordinaryKeys = {
  unspecified_model: UnspecifiedModelSchema.optional().describe(
    "Tier used when the host names no model: inherit | classify | <tier> (default balanced).",
  ),
  pins: z
    .array(RuleFileSchema)
    .optional()
    .describe("Rules evaluated before anything else, whatever the profile."),
  mappings: z
    .object({
      preset: Id.optional().describe("Active tier preset (default mirror)."),
      direct: z.array(DirectMappingFileSchema).optional().describe("Explicit model mappings."),
    })
    .strict()
    .optional(),
  profile: Id.optional().describe("Active routing profile (default balance)."),
  shadow_profiles: Names.optional().describe("Profiles evaluated in shadow mode."),
  thresholds: z
    .record(Id, ThresholdsFileSchema)
    .optional()
    .describe("Per-instance quota thresholds overrides."),
  timeouts: z
    .object({ default_task_ms: z.number().int().positive().optional() })
    .strict()
    .optional(),
};

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

export const ProviderFileSchema = z
  .object({
    adapter: Id.optional().describe("Adapter id (claude | codex | antigravity); default: the key."),
    enabled: z.boolean().optional().describe("SECURITY. Whether the instance may be used."),
    plan: Id.optional().describe("Subscription plan, e.g. max, pro, plus."),
    pool: PoolSchema.optional().describe("Billing pool (default subscription)."),
    config_dir: Id.optional().describe("Config dir of this account (e.g. CLAUDE_CONFIG_DIR)."),
    binary: Id.optional().describe("SECURITY. Explicit CLI binary path."),
    max_autonomy: AutonomySchema.optional().describe("SECURITY. Autonomy ceiling of the instance."),
    concurrency: z.number().int().positive().optional().describe("SECURITY. Max concurrent runs."),
    thresholds: ThresholdsFileSchema.optional(),
    effort_shift: z.number().int().optional().describe("Effort shift when delegating here."),
    env_passthrough: Names.optional().describe("SECURITY. Extra env vars passed to the child."),
    tos_acknowledged: z
      .boolean()
      .optional()
      .describe("antigravity only: required to enable it with a consumer login."),
  })
  .strict();
export type ProviderFile = z.infer<typeof ProviderFileSchema>;

export const TrustedRepoSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.record(Id, z.string()).describe("Repo-relative path → sha256 of each trusted file."),
    trusted_at: z.string(),
  })
  .strict();
export type TrustedRepo = z.infer<typeof TrustedRepoSchema>;

export const GlobalConfigFileSchema = z
  .object({
    version: z.literal(CURRENT_VERSION),
    providers: z
      .record(Id, ProviderFileSchema)
      .optional()
      .describe("Provider instances by id, merged over the built-in claude/codex/antigravity."),
    ...securityKeys,
    ...ordinaryKeys,
    quota: z
      .object({
        cache_minutes: z.number().nonnegative().optional(),
        readers: z
          .record(Id, z.object({ enabled: z.boolean() }).strict())
          .optional()
          .describe("Quota readers by instance id."),
      })
      .strict()
      .optional(),
    trusted_repos: z
      .record(Id, TrustedRepoSchema)
      .optional()
      .describe("Written by `dispatch trust`, keyed by realpath of the git common dir."),
  })
  .strict();
export type GlobalConfigFile = z.infer<typeof GlobalConfigFileSchema>;

// ---------------------------------------------------------------------------
// Repo config and flags
// ---------------------------------------------------------------------------

/** What a repo or a flag may say about an existing instance: tighten security, tune routing. */
export const ProviderOverlaySchema = ProviderFileSchema.pick({
  enabled: true,
  binary: true,
  max_autonomy: true,
  concurrency: true,
  env_passthrough: true,
  effort_shift: true,
}).strict();
export type ProviderOverlay = z.infer<typeof ProviderOverlaySchema>;

const overlayShape = {
  providers: z.record(Id, ProviderOverlaySchema).optional(),
  ...securityKeys,
  ...ordinaryKeys,
};

/** The layer shape shared by repo config and CLI flags. */
export const OverlaySchema = z.object(overlayShape).strict();
export type Overlay = z.infer<typeof OverlaySchema>;

export const RepoConfigFileSchema = z
  .object({ version: z.literal(CURRENT_VERSION), ...overlayShape })
  .strict();
export type RepoConfigFile = z.infer<typeof RepoConfigFileSchema>;

/** CLI flags expressed as an overlay (same keys as the repo config, no version). */
export const ConfigFlagsSchema = OverlaySchema;
export type ConfigFlags = Overlay;

// ---------------------------------------------------------------------------
// Profiles and mappings
// ---------------------------------------------------------------------------

export const ProfileFileSchema = z
  .object({
    version: z.literal(CURRENT_VERSION),
    description: z.string().optional(),
    rules: z.array(RuleFileSchema).describe("Evaluated top to bottom; first match wins."),
  })
  .strict()
  .describe("A routing profile; its name is the file name without .yaml.");
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

export const MappingFileSchema = z
  .object({
    version: z.literal(CURRENT_VERSION),
    description: z.string().optional(),
    preset: PresetFileSchema.optional().describe("Tier preset named after the file."),
    models: z
      .record(Id, AdapterModelTableFileSchema)
      .optional()
      .describe("Adapter id → model table; replaces that adapter's table."),
  })
  .strict();
export type MappingFile = z.infer<typeof MappingFileSchema>;

// ---------------------------------------------------------------------------
// Versions and migrations
// ---------------------------------------------------------------------------

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** `MIGRATIONS[n]` upgrades a version-n document to version n+1. Empty while only v1 exists. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

/**
 * Upgrades a parsed YAML document to {@link CURRENT_VERSION}. `null` (empty file) becomes
 * `{version: 1}`. A missing, unknown or newer version is a clear `config.version` error.
 */
export function migrate(
  raw: unknown,
  source: string,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  current = CURRENT_VERSION,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return { version: current };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw versionError(`${source}: expected a YAML mapping at the top level`);
  }
  let doc = raw as Record<string, unknown>;
  const v = doc.version;
  if (v === undefined) throw versionError(`${source}: missing "version:" (current: ${current})`);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw versionError(`${source}: unknown config version ${JSON.stringify(v)}`);
  }
  if (v > current) {
    throw versionError(
      `${source}: version ${v} is newer than this Dispatch supports (${current}); upgrade dispatch`,
    );
  }
  for (let n = v; n < current; n++) {
    const step = migrations[n];
    if (!step) throw versionError(`${source}: no migration from version ${n}`);
    doc = { ...step(doc), version: n + 1 };
  }
  return doc;
}

function versionError(message: string): DispatchError {
  return new DispatchError(message, ExitCode.USAGE, "config.version");
}
