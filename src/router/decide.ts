/**
 * The pure router (spec §7): `DecisionInput` → `Decision`. No clock, randomness, env or I/O;
 * everything it reads is in the input, so a stored input replays to the same decision.
 *
 * Layers, in fixed order (first match in a layer wins and ends routing):
 *   pins → direct mappings → active profile rules → preset (tier/effort only) → default (host).
 * Tier and effort are resolved first (see tiers.ts) because rules can match on the tier.
 */
import { z } from "zod";
import { type Decision, type DecisionInput, ExitCode, type RuleTrace } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  type RoutingConfig,
  RoutingConfigSchema,
  type Rule,
  type RuleAction,
} from "../core/routing.js";
import { inputHash } from "./canonical.js";
import { type Candidate, type FilterContext, filterCandidates } from "./filters.js";
import { firstFailedCondition, type MatchFacts } from "./match.js";
import {
  classifyModel,
  findDirectMapping,
  mappingRuleId,
  resolveTarget,
  resolveTier,
  type TargetResult,
  type TierResolution,
} from "./tiers.js";

/** Version of the routing algorithm; callers store it in `DecisionInput.routerVersion`. */
export const ROUTER_VERSION = "0.1.0";

/**
 * Parses `DecisionInput.routing` into a `RoutingConfig` and checks that the active profile and
 * preset exist. Throws a `DispatchError` (code `router.config_invalid`, exit 2) otherwise.
 */
export function parseRoutingConfig(routing: Record<string, unknown>): RoutingConfig {
  const parsed = RoutingConfigSchema.safeParse(routing);
  if (!parsed.success) {
    throw new DispatchError(
      `router: invalid routing config:\n${z.prettifyError(parsed.error)}`,
      ExitCode.USAGE,
      "router.config_invalid",
    );
  }
  const cfg = parsed.data;
  if (!cfg.profiles[cfg.activeProfile]) {
    throw new DispatchError(
      `router: active profile "${cfg.activeProfile}" is not defined in profiles`,
      ExitCode.USAGE,
      "router.config_invalid",
    );
  }
  if (!cfg.presets[cfg.activePreset]) {
    throw new DispatchError(
      `router: active preset "${cfg.activePreset}" is not defined in presets`,
      ExitCode.USAGE,
      "router.config_invalid",
    );
  }
  return cfg;
}

/** Decision without its hash. */
type Outcome = Omit<Decision, "inputHash" | "chain">;

interface Ctx {
  cfg: RoutingConfig;
  res: TierResolution;
  filter: FilterContext;
  chain: RuleTrace[];
}

/** Short text of an action, used as the trace effect of a matching rule. */
function describeAction(action: RuleAction): string {
  switch (action.type) {
    case "provider":
      return `provider ${action.instance}`;
    case "host":
      return "host";
    case "fallback":
      return `fallback ${action.instances.join(" → ")} (${action.strategy})`;
    case "fanout":
      return `fanout ${action.instances.join(" + ")}`;
    case "reject":
      return `reject: ${action.reason}`;
  }
}

const host = (reason: string): Outcome => ({ action: "host", mode: "single", targets: [], reason });

const tierResolver =
  (ctx: Ctx) =>
  (inst: Parameters<typeof resolveTarget>[1]): TargetResult =>
    resolveTarget(ctx.cfg, inst, ctx.res.tier, ctx.res.effortIndex);

function filtered(ctx: Ctx, ids: readonly string[], resolve = tierResolver(ctx)): Candidate[] {
  const { kept, trace } = filterCandidates(ctx.filter, ids, resolve);
  ctx.chain.push(...trace);
  return kept;
}

function names(cands: readonly Candidate[]): string {
  return cands.map((c) => c.instance.id).join(", ");
}

/** Applies a matched rule's action to the candidate set. `source` names the rule for `reason`. */
function applyAction(ctx: Ctx, action: RuleAction, source: string): Outcome {
  switch (action.type) {
    case "host":
      return host(`host: ${source}`);
    case "reject":
      return {
        action: "reject",
        mode: "single",
        targets: [],
        reason: `reject: ${action.reason} (${source})`,
      };
    case "provider": {
      const [c] = filtered(ctx, [action.instance]);
      return c
        ? {
            action: "delegate",
            mode: "single",
            targets: [c.target],
            reason: `delegate to ${c.instance.id} (${source})`,
          }
        : host(`host: ${action.instance} was filtered out (${source})`);
    }
    case "fallback": {
      let cands = filtered(ctx, action.instances);
      if (cands.length === 0)
        return host(`host: every fallback candidate was filtered out (${source})`);
      if (action.strategy === "most_remaining") {
        cands = cands
          .map((c, i) => ({ c, i, r: c.quota.remainingPct ?? -1 }))
          .sort((a, b) => b.r - a.r || a.i - b.i)
          .map((x) => x.c);
        ctx.chain.push({
          layer: "filter",
          ruleId: "most_remaining",
          matched: true,
          effect: `order: ${names(cands)}`,
        });
      }
      return {
        action: "delegate",
        mode: "fallback",
        targets: cands.map((c) => c.target),
        reason: `delegate to ${names(cands)} in order, then host (${source})`,
      };
    }
    case "fanout": {
      const cands = filtered(ctx, action.instances);
      if (cands.length >= 2) {
        return {
          action: "delegate",
          mode: "fanout",
          targets: cands.map((c) => c.target),
          reason: `fan out to ${names(cands)} (${source})`,
        };
      }
      const [c] = cands;
      ctx.chain.push({
        layer: "filter",
        ruleId: "fanout",
        matched: false,
        effect: c ? "degraded to single" : "degraded to host",
        note: `${cands.length} of ${action.instances.length} fanout candidates survived filtering`,
      });
      return c
        ? {
            action: "delegate",
            mode: "single",
            targets: [c.target],
            reason: `delegate to ${c.instance.id}: fanout degraded to one candidate (${source})`,
          }
        : host(`host: every fanout candidate was filtered out (${source})`);
    }
  }
}

/** Walks `rules` (first match wins); returns the outcome of the matching rule, or null. */
function walkRules(
  ctx: Ctx,
  facts: MatchFacts,
  rules: readonly Rule[],
  layer: "pin" | "profile",
  label: (id: string) => string,
): Outcome | null {
  for (const rule of rules) {
    const failed = firstFailedCondition(rule, facts);
    if (failed !== null) {
      ctx.chain.push({
        layer,
        ruleId: rule.id,
        matched: false,
        effect: "no match",
        note: `${failed} did not match`,
      });
      continue;
    }
    ctx.chain.push({ layer, ruleId: rule.id, matched: true, effect: describeAction(rule.action) });
    return applyAction(ctx, rule.action, label(rule.id));
  }
  return null;
}

/** Layer 2: the first direct mapping on the requested model delegates to a fixed target. */
function walkMappings(ctx: Ctx, input: DecisionInput): Outcome | null {
  const { hit, missed } = findDirectMapping(input.task, ctx.cfg);
  for (const m of missed) {
    ctx.chain.push({
      layer: "mapping",
      ruleId: mappingRuleId(m),
      matched: false,
      effect: "no match",
    });
  }
  if (!hit) return null;
  const ruleId = mappingRuleId(hit);
  ctx.chain.push({
    layer: "mapping",
    ruleId,
    matched: true,
    effect: `provider ${hit.instance} model ${hit.model} effort ${hit.effort}`,
  });
  const [c] = filtered(ctx, [hit.instance], (inst) => ({
    ok: true,
    target: {
      instance: inst.id,
      tier: classifyModel(ctx.cfg, input.host, hit.model, inst.adapter)?.tier ?? ctx.res.tier,
      model: hit.model,
      effort: hit.effort,
    },
  }));
  return c
    ? {
        action: "delegate",
        mode: "single",
        targets: [c.target],
        reason: `delegate to ${c.instance.id} (direct mapping ${ruleId})`,
      }
    : host(`host: ${hit.instance} was filtered out (direct mapping ${ruleId})`);
}

/**
 * Routes one task. Deterministic: equal inputs (up to key order) give deep-equal decisions.
 * `decision.inputHash` is `inputHash(input)` of the input exactly as passed.
 *
 * @throws DispatchError `router.config_invalid` when `input.routing` is not a valid RoutingConfig.
 */
export function decide(input: DecisionInput): Decision {
  const cfg = parseRoutingConfig(input.routing);
  const profile = cfg.profiles[cfg.activeProfile] as NonNullable<RoutingConfig["profiles"][string]>;
  const preset = cfg.presets[cfg.activePreset] as NonNullable<RoutingConfig["presets"][string]>;
  const res = resolveTier(input.task, input.host, cfg, cfg.activePreset, preset);
  const ctx: Ctx = {
    cfg,
    res,
    chain: [...res.trace],
    filter: { cfg, task: input.task, host: input.host, quota: input.quota, now: input.now },
  };
  const facts: MatchFacts = {
    task: input.task,
    tier: res.tier,
    quota: input.quota,
    sessionHistory: input.sessionHistory,
  };

  const outcome =
    walkRules(ctx, facts, cfg.pins, "pin", (id) => `pin ${id}`) ??
    walkMappings(ctx, input) ??
    walkRules(
      ctx,
      facts,
      profile.rules,
      "profile",
      (id) => `profile ${cfg.activeProfile} rule ${id}`,
    ) ??
    (() => {
      ctx.chain.push({ layer: "default", ruleId: "default", matched: true, effect: "host" });
      return host("host: no rule matched (default)");
    })();

  return { ...outcome, chain: ctx.chain, inputHash: inputHash(input) };
}

/**
 * Shadow mode (UC8): the decision each named profile would take on the same snapshot. Each entry
 * is `decide()` on a copy of `input` whose `routing.activeProfile` is that profile, so each
 * decision's `inputHash` is the hash of that copy. Throws like {@link decide} for unknown profiles.
 */
export function decideForProfiles(
  input: DecisionInput,
  profileNames: readonly string[],
): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const name of profileNames) {
    out[name] = decide({ ...input, routing: { ...input.routing, activeProfile: name } });
  }
  return out;
}
