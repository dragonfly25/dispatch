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

/** The `version:` key every config, profile and mapping file starts with. */
const VersionField = z
  .literal(CURRENT_VERSION)
  .describe("Format version of the file; 1 is the only version.");

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
    description: z.string().optional().describe("Free text."),
    effort_shift: z
      .number()
      .int()
      .optional()
      .describe(
        "Effort levels to shift when delegating (negative = cheaper); clamped to the scale.",
      ),
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
      .array(
        z
          .object({
            pattern: Id.describe("Glob matched against the model name."),
            tier: Id.describe("Tier given to a model that matches."),
          })
          .strict(),
      )
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
      per_provider: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max concurrent runs on one instance (default 2)."),
      total: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max concurrent runs across all instances (default 4)."),
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
  network: z
    .enum(["off", "delegated-agents", "all", "on"])
    .optional()
    .describe(
      "SECURITY. Shell sandbox network for delegated agents (listen on localhost, Docker socket, internet): `off` (default), `delegated-agents` (runs a host session delegates: intercepted custom agents and general-purpose), `all` (also runs started by hand). Worktree runs only. Only the global file can turn it on; a repo or flag can only lower it. `on` is a deprecated alias of `all`.",
    ),
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
      direct: z
        .array(DirectMappingFileSchema)
        .optional()
        .describe("Explicit model mappings; the first match wins and bypasses tiers."),
    })
    .strict()
    .optional()
    .describe("Tier preset selection and explicit model mappings."),
  profile: Id.optional().describe("Active routing profile (default balance)."),
  shadow_profiles: Names.optional().describe("Profiles evaluated in shadow mode."),
  thresholds: z
    .record(Id, ThresholdsFileSchema)
    .optional()
    .describe("Per-instance quota thresholds overrides."),
  timeouts: z
    .object({
      default_task_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout of a delegated task in milliseconds (default 600000)."),
    })
    .strict()
    .optional()
    .describe("Run timeouts."),
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
    thresholds: ThresholdsFileSchema.optional().describe(
      "Quota thresholds of this instance (default soft 20, hard 5).",
    ),
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
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("sha256 over the relative path and bytes of every policy file."),
    files: z.record(Id, z.string()).describe("Repo-relative path → sha256 of each trusted file."),
    trusted_at: z.string().describe("ISO-8601 time `dispatch trust` recorded the entry."),
  })
  .strict();
export type TrustedRepo = z.infer<typeof TrustedRepoSchema>;

export const GlobalConfigFileSchema = z
  .object({
    version: VersionField,
    providers: z
      .record(Id, ProviderFileSchema)
      .optional()
      .describe("Provider instances by id, merged over the built-in claude/codex/antigravity."),
    main_host: Id.optional().describe(
      "Informational: the client you mainly use as host (claude-code | codex), recorded by `dispatch setup`; host-independent commands may use it as a default.",
    ),
    ...securityKeys,
    ...ordinaryKeys,
    network_agents: z
      .array(z.string().min(1).max(100))
      .max(100)
      .optional()
      .describe(
        "SECURITY. With `network: delegated-agents`: only these agents get the sandbox network (custom agent names; `general-purpose` for runs a host session starts without a handoff). Absent: every delegated agent. Global only.",
      ),
    retention_days: z
      .number()
      .positive()
      .optional()
      .describe("How long `dispatch gc` keeps finished runs and their history (default 30)."),
    quota: z
      .object({
        cache_minutes: z
          .number()
          .nonnegative()
          .optional()
          .describe("Minutes a real quota reading stays fresh (default 5)."),
        readers: z
          .record(
            Id,
            z
              .object({
                enabled: z
                  .boolean()
                  .optional()
                  .describe("`false` turns this reader (or every reader of this instance) off."),
                llm_fallback: z
                  .boolean()
                  .optional()
                  .describe(
                    "`claude-usage` only: when `/usage` output cannot be parsed, let Haiku extract the quota lines (only the quota header is sent; only in `status`/`doctor`; default true).",
                  ),
              })
              .strict(),
          )
          .optional()
          .describe(
            "Quota readers by reader id (`claude-usage`, `claude-passive`, `codex-app-server`, `agy-usage`) or instance id; `enabled: false` turns a reader off.",
          ),
      })
      .strict()
      .optional()
      .describe("Quota reading settings (global file only)."),
    hosts: z
      .object({
        codex: z
          .object({
            hard: z
              .boolean()
              .optional()
              .describe(
                "Redirect Codex native sub-agent spawns to Dispatch in trusted repos whose policy delegates (default true); false keeps only the SessionStart context.",
              ),
          })
          .strict()
          .optional()
          .describe("Codex host integration."),
        "claude-code": z
          .object({
            hard: z
              .boolean()
              .optional()
              .describe(
                "Rewrite intercepted Claude Code sub-agent calls (Agent tool) to the `dispatch:dispatch` sub-agent in trusted repos whose policy delegates (default true); false keeps only the SessionStart context.",
              ),
            intercept: z
              .union([z.enum(["auto", "*"]), z.array(z.string().min(1).max(100)).max(50)])
              .optional()
              .describe(
                'Sub-agent types the hard mode redirects. `"auto"` (default): `general-purpose` (a call without a type counts as general-purpose) and every eligible custom agent of `.claude/agents/`. A list is an allow-list of types, still subject to eligibility; `"*"` means every eligible type. Built-in types without an agent file, plugin agents and `dispatch:dispatch` are never redirected.',
              ),
            exclude: z
              .array(z.string().min(1).max(100))
              .max(100)
              .optional()
              .describe("Sub-agent types the hard mode never redirects (default none)."),
            auto_apply: z
              .boolean()
              .optional()
              .describe(
                "SECURITY. Apply the clean patch of a successful run started for an intercepted custom agent, so the caller receives modified files as with a native sub-agent (default true; false keeps review-and-apply-yourself). Global only.",
              ),
            forward_mcp: z
              .boolean()
              .optional()
              .describe(
                "SECURITY. Trust grant: forward the MCP servers an intercepted agent needs to the external agent that runs it (only servers whose env and header values are pure `$" +
                  "{VAR}` references; codex targets only). Asked by `dispatch setup`; default false. A repo or flag can only turn it off (`forward_mcp: false`).",
              ),
            forward_web: z
              .boolean()
              .optional()
              .describe(
                "SECURITY. Give web access (codex web search, claude WebSearch/WebFetch) to the external agent that runs an intercepted agent whose `tools:` list WebSearch or WebFetch (default true; false keeps those agents on Claude). Never widens the shell sandbox network. A repo or flag can only turn it off (`forward_web: false`).",
              ),
            browser: z
              .boolean()
              .optional()
              .describe(
                "SECURITY. Trust grant: the isolated browser for intercepted agents that use the Claude desktop browser tools (`mcp__Claude_Browser__*`). `dispatch setup` installs the pinned `@playwright/mcp` into ~/.dispatch/tools/playwright-mcp; codex runs it with the installed Google Chrome, a temporary empty profile and only localhost origins. Such agents also need the sandbox network (`network`). Asked by `dispatch setup`; default false. A repo or flag can only turn it off (`browser: false`).",
              ),
          })
          .strict()
          .optional()
          .describe("Claude Code host integration."),
      })
      .strict()
      .optional()
      .describe("Host integration settings (global file only)."),
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
  forward_mcp: z
    .boolean()
    .optional()
    .describe(
      "SECURITY. `false` turns MCP forwarding off here (global `hosts.claude-code.forward_mcp` turns it on; `true` cannot loosen it).",
    ),
  forward_web: z
    .boolean()
    .optional()
    .describe(
      "SECURITY. `false` turns web forwarding off here: agents that use WebSearch/WebFetch stay on Claude (global `hosts.claude-code.forward_web`, default true; `true` cannot loosen it).",
    ),
  browser: z
    .boolean()
    .optional()
    .describe(
      "SECURITY. `false` turns the isolated browser off here: agents that use the Claude desktop browser tools stay on Claude (global `hosts.claude-code.browser`; `true` cannot loosen it).",
    ),
  ...securityKeys,
  ...ordinaryKeys,
};

/** The layer shape shared by repo config and CLI flags. */
export const OverlaySchema = z.object(overlayShape).strict();
export type Overlay = z.infer<typeof OverlaySchema>;

export const RepoConfigFileSchema = z.object({ version: VersionField, ...overlayShape }).strict();
export type RepoConfigFile = z.infer<typeof RepoConfigFileSchema>;

/** CLI flags expressed as an overlay (same keys as the repo config, no version). */
export const ConfigFlagsSchema = OverlaySchema;
export type ConfigFlags = Overlay;

// ---------------------------------------------------------------------------
// Profiles and mappings
// ---------------------------------------------------------------------------

export const ProfileFileSchema = z
  .object({
    version: VersionField,
    description: z.string().optional().describe("Free text."),
    rules: z.array(RuleFileSchema).describe("Evaluated top to bottom; first match wins."),
  })
  .strict()
  .describe("A routing profile; its name is the file name without .yaml.");
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

export const MappingFileSchema = z
  .object({
    version: VersionField,
    description: z.string().optional().describe("Free text."),
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
