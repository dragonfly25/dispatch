/**
 * Routing contract: the *effective* routing configuration handed to the pure router.
 *
 * `src/config` (WP4) builds a `RoutingConfig` from global + trusted repo YAML (after applying
 * tighten-only security rules); `src/router` (WP5) consumes it. Neither side reads YAML shapes
 * of the other: this file is the only shared vocabulary. Frozen like `contracts.ts` (ADR 0001).
 *
 * Precedence inside the router is fixed (spec §7): pins → direct mappings → active profile rules
 * → tier preset → default. Quota thresholds are filters applied to every candidate list.
 */
import { z } from "zod";
import { AutonomySchema, PoolSchema, ReliabilitySchema } from "./contracts.js";

const NonEmpty = z.string().min(1);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Conditions of a rule. Every present field must hold (logical AND); an empty `match` always
 * matches. List-valued fields match when the task value is one of the listed values.
 */
export const RuleMatchSchema = z
  .object({
    /** Task types, e.g. ["test", "docs"]. Matches only when the task declares a type. */
    taskType: z.array(NonEmpty).optional(),
    /** Repo-relative globs (picomatch). Matches when ANY task path matches ANY glob. */
    paths: z.array(NonEmpty).optional(),
    /** Resolved tiers of the task. */
    tier: z.array(NonEmpty).optional(),
    /** Requested autonomy levels. */
    autonomy: z.array(AutonomySchema).optional(),
    /**
     * Minimum remaining quota (0–100) per instance id, using the tightest window. An instance
     * whose usage is unknown never satisfies the condition.
     */
    minRemainingPct: z.record(NonEmpty, z.number().min(0).max(100)).optional(),
    /** Accepted reliabilities of the quota data for every instance named in the action. */
    reliability: z.array(ReliabilitySchema).optional(),
    /** Matches when an earlier task in the same session had one of these outcomes. */
    priorOutcome: z.array(z.enum(["failed", "timeout", "quota_exhausted", "rejected"])).optional(),
  })
  .strict();
export type RuleMatch = z.infer<typeof RuleMatchSchema>;

/** What a matching rule does. */
export const RuleActionSchema = z.discriminatedUnion("type", [
  /** Delegate to one instance. */
  z.object({ type: z.literal("provider"), instance: NonEmpty }).strict(),
  /** Keep the task on the host (the native sub-agent proceeds as if Dispatch did not exist). */
  z.object({ type: z.literal("host") }).strict(),
  /** Try instances in order (or by most remaining quota); the host is always the implicit last step. */
  z
    .object({
      type: z.literal("fallback"),
      instances: z.array(NonEmpty).min(1),
      strategy: z.enum(["ordered", "most_remaining"]).default("ordered"),
    })
    .strict(),
  /** Second opinion: run on every listed instance (2+), return all results, never merge. */
  z.object({ type: z.literal("fanout"), instances: z.array(NonEmpty).min(2) }).strict(),
  /** Refuse the task with a reason. */
  z.object({ type: z.literal("reject"), reason: NonEmpty }).strict(),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

/** A named rule. `id` appears in the rule chain shown by `explain`. */
export const RuleSchema = z
  .object({
    id: NonEmpty,
    description: z.string().optional(),
    match: RuleMatchSchema.default({}),
    action: RuleActionSchema,
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

/** A routing strategy (balance, preserve, specialize, off, or user-defined). */
export const ProfileSchema = z
  .object({
    description: z.string().optional(),
    /** Evaluated top to bottom; first match wins. */
    rules: z.array(RuleSchema),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

// ---------------------------------------------------------------------------
// Tiers, models, mappings
// ---------------------------------------------------------------------------

/** One adapter's model for a tier, with the native value of each Dispatch effort level. */
export const TierModelSchema = z
  .object({
    model: NonEmpty,
    /** Dispatch effort → native effort parameter, e.g. { low: "low", high: "xhigh" }. */
    effort: z.record(NonEmpty, NonEmpty),
    /** Indicative relative cost (1 = cheapest); used by the estimator and `status --compare`. */
    relativeCost: z.number().positive(),
  })
  .strict();
export type TierModel = z.infer<typeof TierModelSchema>;

/** Per-adapter model table (spec §6): tier → model, and model → tier for classification. */
export const AdapterModelTableSchema = z
  .object({
    tiers: z.record(NonEmpty, TierModelSchema),
    /** Ordered; first glob matching the model name wins. Used to classify the host's model. */
    reverse: z.array(z.object({ pattern: NonEmpty, tier: NonEmpty }).strict()),
  })
  .strict();
export type AdapterModelTable = z.infer<typeof AdapterModelTableSchema>;

/** An explicit `model[:effort]` → `instance:model:effort` mapping; bypasses tiers. */
export const DirectMappingSchema = z
  .object({
    /** Host model glob, e.g. "claude-opus-*". */
    fromModel: NonEmpty,
    /** Optional host effort; absent = any. */
    fromEffort: NonEmpty.optional(),
    instance: NonEmpty,
    model: NonEmpty,
    effort: NonEmpty,
  })
  .strict();
export type DirectMapping = z.infer<typeof DirectMappingSchema>;

/** Tier preset (mirror, economy, ...). Everything a preset does is visible here. */
export const PresetSchema = z
  .object({
    description: z.string().optional(),
    /** Effort levels to shift on delegated tasks (e.g. -1 for economy). Clamped to the scale. */
    effortShift: z.number().int().default(0),
    /** Optional task type → tier override (e.g. { test: "fast" }). */
    tierByTaskType: z.record(NonEmpty, NonEmpty).default({}),
  })
  .strict();
export type Preset = z.infer<typeof PresetSchema>;

// ---------------------------------------------------------------------------
// Instances and thresholds
// ---------------------------------------------------------------------------

/** Routing view of a provider instance (an adapter + account). */
export const RoutingInstanceSchema = z
  .object({
    id: NonEmpty,
    adapter: NonEmpty,
    pool: PoolSchema,
    /** Disabled instances are never chosen (agy is disabled by default). */
    enabled: z.boolean(),
    /** Highest autonomy this instance may receive (agy: "read-only"). */
    maxAutonomy: AutonomySchema,
    /** Max concurrent runs; enforced by the runner, recorded here for explain. */
    concurrency: z.number().int().positive(),
    /** Quota protection, as remaining %: below soft avoid if alternatives exist, below hard never. */
    thresholds: z
      .object({ soft: z.number().min(0).max(100), hard: z.number().min(0).max(100) })
      .strict(),
    /** Per-instance effort shift applied on top of the preset. */
    effortShift: z.number().int().default(0),
  })
  .strict();
export type RoutingInstance = z.infer<typeof RoutingInstanceSchema>;

/** How to pick a tier when the host did not name a model (spec §6). */
export const UnspecifiedModelSchema = z.union([
  z.literal("inherit"),
  z.literal("classify"),
  /** Any tier name, e.g. "balanced" (default) or "fast". */
  NonEmpty,
]);

// ---------------------------------------------------------------------------
// Effective routing configuration
// ---------------------------------------------------------------------------

export const RoutingConfigSchema = z
  .object({
    version: z.literal(1),
    /** Ordered tier names, lowest first (default: fast, balanced, max). */
    tiers: z.array(NonEmpty).min(1),
    /** Ordered effort names, lowest first (default: low, medium, high). */
    efforts: z.array(NonEmpty).min(1),
    instances: z.array(RoutingInstanceSchema),
    /** Adapter id → model table. */
    models: z.record(NonEmpty, AdapterModelTableSchema),
    /** Layer 1: evaluated before anything else, whatever the profile. */
    pins: z.array(RuleSchema),
    /** Layer 2. */
    directMappings: z.array(DirectMappingSchema),
    /** Layer 3: name of the active profile, which must exist in `profiles`. */
    activeProfile: NonEmpty,
    profiles: z.record(NonEmpty, ProfileSchema),
    /** Layer 4: name of the active tier preset, which must exist in `presets`. */
    activePreset: NonEmpty,
    presets: z.record(NonEmpty, PresetSchema),
    unspecifiedModel: UnspecifiedModelSchema,
    /** Effective autonomy ceiling after tighten-only merging of global, repo and flags. */
    maxAutonomy: AutonomySchema,
    /** Profiles also evaluated in shadow mode on every decision (UC8). */
    shadowProfiles: z.array(NonEmpty),
    /** Provenance of each top-level key ("global" | "repo" | "flag" | "default"), for explain. */
    provenance: z.record(NonEmpty, z.enum(["global", "repo", "flag", "default"])).default({}),
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
