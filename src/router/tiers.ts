/**
 * Tier and effort resolution (spec §6): requested model → tier, preset overrides and effort shifts,
 * and finally tier × effort → concrete model + native effort for one instance.
 */
import picomatch from "picomatch";
import type { DecisionTarget, HostContext, RuleTrace, Task, Tier } from "../core/contracts.js";
import type { DirectMapping, Preset, RoutingConfig, RoutingInstance } from "../core/routing.js";

/** Tier and effort of a task before any instance-specific adjustment. */
export interface TierResolution {
  tier: Tier;
  /** Index of the task's Dispatch effort in `config.efforts`, after the preset shift (clamped). */
  effortIndex: number;
  /** Resolution steps, prefixed `tier:` or `effort:` in `ruleId`. */
  trace: RuleTrace[];
}

/** Matches `model` against an ordered glob table; returns the first hit. */
function firstGlob<T extends { pattern: string }>(
  table: readonly T[],
  model: string,
): { entry: T; index: number } | null {
  for (const [index, entry] of table.entries()) {
    if (picomatch.isMatch(model, entry.pattern)) return { entry, index };
  }
  return null;
}

/** Adapters to search, the host's own adapter first, then the others in alphabetical order. */
function adapterOrder(cfg: RoutingConfig, host: HostContext): string[] {
  const hostAdapter = cfg.instances.find((i) => i.id === host.self)?.adapter;
  const rest = Object.keys(cfg.models)
    .filter((a) => a !== hostAdapter)
    .sort();
  return hostAdapter && cfg.models[hostAdapter] ? [hostAdapter, ...rest] : rest;
}

/**
 * Classifies a model name into a tier through the reverse tables (first matching glob, host
 * adapter first). Pass `onlyAdapter` to search a single adapter's table.
 */
export function classifyModel(
  cfg: RoutingConfig,
  host: HostContext,
  model: string,
  onlyAdapter?: string,
): { tier: Tier; ruleId: string; pattern: string } | null {
  const adapters = onlyAdapter === undefined ? adapterOrder(cfg, host) : [onlyAdapter];
  for (const adapter of adapters) {
    const hit = firstGlob(cfg.models[adapter]?.reverse ?? [], model);
    if (hit) {
      return {
        tier: hit.entry.tier,
        ruleId: `tier:reverse:${adapter}[${hit.index}]`,
        pattern: hit.entry.pattern,
      };
    }
  }
  return null;
}

/** Tier used when nothing else decides: "balanced" if defined, else the middle tier. */
export function defaultTier(cfg: RoutingConfig): Tier {
  return cfg.tiers.includes("balanced")
    ? "balanced"
    : (cfg.tiers[Math.floor((cfg.tiers.length - 1) / 2)] as Tier);
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function step(
  ruleId: string,
  effect: string,
  note?: string,
  layer: RuleTrace["layer"] = "mapping",
) {
  const t: RuleTrace = { layer, ruleId, matched: true, effect };
  if (note !== undefined) t.note = note;
  return t;
}

/** Resolves the task's base tier (steps b–d of the brief: reverse table, task.tier, unspecified). */
function baseTier(task: Task, host: HostContext, cfg: RoutingConfig, trace: RuleTrace[]): Tier {
  if (task.requestedModel !== undefined) {
    const hit = classifyModel(cfg, host, task.requestedModel);
    if (hit) {
      trace.push(step(hit.ruleId, `tier ${hit.tier}`, `${task.requestedModel} ~ ${hit.pattern}`));
      return hit.tier;
    }
    trace.push({
      layer: "mapping",
      ruleId: "tier:reverse",
      matched: false,
      effect: "no reverse match",
      note: `requested model ${task.requestedModel} is not classified by any adapter`,
    });
  }
  if (task.tier !== undefined) {
    trace.push(step("tier:task", `tier ${task.tier}`, "tier declared by the task"));
    return task.tier;
  }
  const mode = cfg.unspecifiedModel;
  if (mode === "inherit") {
    const session = host.sessionModel;
    const hit = session?.observed ? classifyModel(cfg, host, session.value) : null;
    if (session?.observed && hit) {
      trace.push(
        step(
          "tier:unspecified:inherit",
          `tier ${hit.tier}`,
          `session model ${session.value} ~ ${hit.pattern} via ${hit.ruleId}`,
        ),
      );
      return hit.tier;
    }
    const tier = defaultTier(cfg);
    const why = !session
      ? "session model absent"
      : !session.observed
        ? `session model ${session.value} not observed`
        : `session model ${session.value} not classified`;
    trace.push(
      step("tier:unspecified:inherit", `tier ${tier}`, `decided_without: session_model (${why})`),
    );
    return tier;
  }
  if (mode === "classify") {
    const tier = defaultTier(cfg);
    trace.push(
      step("tier:unspecified:classify", `tier ${tier}`, "classify is not implemented in v0.1"),
    );
    return tier;
  }
  trace.push(
    step(`tier:unspecified:${mode}`, `tier ${mode}`, "unspecified model uses the configured tier"),
  );
  return mode;
}

/**
 * Resolves tier and Dispatch effort for a task: base tier, then the active preset's
 * `tierByTaskType` override and `effortShift` (clamped to `config.efforts`).
 */
export function resolveTier(
  task: Task,
  host: HostContext,
  cfg: RoutingConfig,
  presetName: string,
  preset: Preset,
): TierResolution {
  const trace: RuleTrace[] = [];
  let tier = baseTier(task, host, cfg, trace);
  const override = task.taskType === undefined ? undefined : preset.tierByTaskType[task.taskType];
  if (override !== undefined && task.taskType !== undefined) {
    trace.push(
      step(
        `tier:preset:${presetName}`,
        `tier ${override}`,
        `tierByTaskType.${task.taskType} (was ${tier})`,
        "preset",
      ),
    );
    tier = override;
  }

  const max = cfg.efforts.length - 1;
  const fallbackEffort = cfg.efforts.includes("medium")
    ? "medium"
    : (cfg.efforts[Math.floor(max / 2)] as string);
  let base = task.effort ?? fallbackEffort;
  if (!cfg.efforts.includes(base)) {
    trace.push(step("effort:task", `effort ${fallbackEffort}`, `unknown effort ${base}`));
    base = fallbackEffort;
  } else {
    trace.push(
      step(
        "effort:task",
        `effort ${base}`,
        task.effort === undefined ? "default effort" : "effort declared by the task",
      ),
    );
  }
  const baseIndex = cfg.efforts.indexOf(base);
  const effortIndex = clamp(baseIndex + preset.effortShift, max);
  if (preset.effortShift !== 0) {
    trace.push(
      step(
        `effort:preset:${presetName}`,
        `effort ${cfg.efforts[effortIndex]}`,
        `effortShift ${preset.effortShift}, clamped`,
        "preset",
      ),
    );
  }
  return { tier, effortIndex, trace };
}

/** Rule id of a direct mapping in the trace: `map:<fromModel>[:<fromEffort>]`. */
export function mappingRuleId(mapping: DirectMapping): string {
  return `map:${mapping.fromModel}${mapping.fromEffort === undefined ? "" : `:${mapping.fromEffort}`}`;
}

/**
 * Walks the direct mappings in order against `task.requestedModel` (glob) and `task.effort`
 * (exact, only when the mapping sets `fromEffort`). Returns the first hit and the ids tried before it.
 * A task without a requested model never matches.
 */
export function findDirectMapping(
  task: Task,
  cfg: RoutingConfig,
): { hit: DirectMapping | null; missed: DirectMapping[] } {
  const missed: DirectMapping[] = [];
  if (task.requestedModel === undefined) return { hit: null, missed };
  for (const mapping of cfg.directMappings) {
    const modelOk = picomatch.isMatch(task.requestedModel, mapping.fromModel);
    const effortOk = mapping.fromEffort === undefined || mapping.fromEffort === task.effort;
    if (modelOk && effortOk) return { hit: mapping, missed };
    missed.push(mapping);
  }
  return { hit: null, missed };
}

/** Result of resolving a target for one instance. */
export type TargetResult = { ok: true; target: DecisionTarget } | { ok: false; reason: string };

/**
 * Concrete target for `instance` at `tier`, applying the instance's own effort shift on top of
 * `effortIndex` and mapping the Dispatch effort to the adapter's native value.
 */
export function resolveTarget(
  cfg: RoutingConfig,
  instance: RoutingInstance,
  tier: Tier,
  effortIndex: number,
): TargetResult {
  const row = cfg.models[instance.adapter]?.tiers[tier];
  if (!row) return { ok: false, reason: `no model for tier ${tier} in models.${instance.adapter}` };
  const effort = cfg.efforts[
    clamp(effortIndex + instance.effortShift, cfg.efforts.length - 1)
  ] as string;
  const native = row.effort[effort];
  if (native === undefined) {
    return {
      ok: false,
      reason: `no native effort for ${effort} in models.${instance.adapter}.tiers.${tier}`,
    };
  }
  return { ok: true, target: { instance: instance.id, tier, model: row.model, effort: native } };
}
