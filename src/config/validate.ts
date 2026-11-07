/**
 * `validate`: static checks of an effective configuration, run before use instead of failing at
 * routing time (spec §6 requirement 2, §7 requirement 2). It never throws and never touches the
 * disk; it only reads the `RoutingConfig` that `loadEffectiveConfig` produced.
 *
 * Errors make the configuration unusable or self-contradictory; warnings are legal but almost
 * certainly not what the user meant (a rule that can never fire, a model the table does not know).
 */
import type { Autonomy } from "../core/contracts.js";
import type {
  AdapterModelTable,
  RoutingConfig,
  RoutingInstance,
  Rule,
  RuleAction,
  RuleMatch,
} from "../core/routing.js";
import type { EffectiveConfig } from "./load.js";
import { AUTONOMY_ORDER } from "./merge.js";

/** One finding of {@link validate}. `path` is a dotted/indexed config path, e.g. `pins[0].action`. */
export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

/** What `validate` accepts: the loader's result, or a bare `RoutingConfig`. */
export type ValidateInput = EffectiveConfig | RoutingConfig;

/**
 * Checks a loaded configuration and returns every finding (empty = clean). Given an
 * `EffectiveConfig`, the issues the loader already collected are included (`key` becomes `path`).
 *
 * Detects: unknown instances; undefined tier/effort names; models unknown to their adapter
 * table; contradictory or duplicate mappings; rules that can never fire (after a catch-all or
 * shadowed by an earlier rule or pin); missing active profile/preset; fanouts with fewer than two
 * enabled instances; rules that can hand a task to an instance whose autonomy ceiling is lower;
 * and quota thresholds with soft < hard.
 */
export function validate(loaded: ValidateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = "routing" in loaded ? loaded.routing : loaded;
  if ("routing" in loaded) {
    for (const i of loaded.issues) issues.push({ level: i.level, path: i.key, message: i.message });
  }
  const v = new Validator(cfg, issues);
  v.activeNames();
  v.instances();
  v.modelTables();
  v.presets();
  v.directMappings();
  v.ruleList("pins", cfg.pins, "pin");
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    v.ruleList(`profiles.${name}.rules`, profile.rules, "rule");
  }
  return issues;
}

const rank = (a: Autonomy) => AUTONOMY_ORDER.indexOf(a);

/** Instance ids named by an action (empty for host and reject). */
function actionInstances(action: RuleAction): string[] {
  if (action.type === "provider") return [action.instance];
  if (action.type === "fallback" || action.type === "fanout") return action.instances;
  return [];
}

/** True when `a` holds for every task that `b` holds for (conservative: false when unsure). */
function subsumes(a: RuleMatch, b: RuleMatch): boolean {
  // `reliability` is judged on the instances of each rule's own action: not comparable.
  if (a.reliability !== undefined) return false;
  const covers = (x?: readonly string[], y?: readonly string[]) => {
    if (x === undefined) return true; // `a` leaves the field open
    return y?.every((e) => x.includes(e)) === true;
  };
  if (
    !covers(a.taskType, b.taskType) ||
    !covers(a.paths, b.paths) ||
    !covers(a.tier, b.tier) ||
    !covers(a.autonomy, b.autonomy) ||
    !covers(a.priorOutcome, b.priorOutcome)
  ) {
    return false;
  }
  for (const [id, min] of Object.entries(a.minRemainingPct ?? {})) {
    const other = b.minRemainingPct?.[id];
    if (other === undefined || other < min) return false;
  }
  return true;
}

const isCatchAll = (m: RuleMatch) => Object.values(m).every((x) => x === undefined);

class Validator {
  private readonly byId: Map<string, RoutingInstance>;

  constructor(
    private readonly cfg: RoutingConfig,
    private readonly out: ValidationIssue[],
  ) {
    this.byId = new Map(cfg.instances.map((i) => [i.id, i]));
  }

  private error(path: string, message: string) {
    this.out.push({ level: "error", path, message });
  }

  private warn(path: string, message: string) {
    this.out.push({ level: "warning", path, message });
  }

  /** activeProfile / activePreset / shadowProfiles / unspecifiedModel must name something real. */
  activeNames() {
    const { cfg } = this;
    if (!(cfg.activeProfile in cfg.profiles)) {
      this.error("activeProfile", `active profile "${cfg.activeProfile}" is not defined`);
    }
    if (!(cfg.activePreset in cfg.presets)) {
      this.error("activePreset", `active preset "${cfg.activePreset}" is not defined`);
    }
    cfg.shadowProfiles.forEach((p, i) => {
      if (!(p in cfg.profiles)) this.error(`shadowProfiles[${i}]`, `unknown profile "${p}"`);
    });
    const u = cfg.unspecifiedModel;
    if (u !== "inherit" && u !== "classify" && !cfg.tiers.includes(u)) {
      this.error(
        "unspecifiedModel",
        `"${u}" is neither inherit, classify nor a tier (${cfg.tiers.join(", ")})`,
      );
    }
  }

  /** Quota thresholds and one model table per enabled adapter. */
  instances() {
    for (const i of this.cfg.instances) {
      if (i.thresholds.soft < i.thresholds.hard) {
        this.error(
          `instances.${i.id}.thresholds`,
          `soft (${i.thresholds.soft}) must not be below hard (${i.thresholds.hard}): both are remaining quota %`,
        );
      }
      if (!i.enabled) continue;
      const table = this.cfg.models[i.adapter];
      if (!table) {
        this.error(`instances.${i.id}`, `adapter "${i.adapter}" has no model table in models`);
        continue;
      }
      for (const tier of this.cfg.tiers) {
        if (!(tier in table.tiers)) {
          this.warn(`models.${i.adapter}.tiers`, `no model for tier "${tier}" (used by ${i.id})`);
        }
      }
    }
  }

  /** Tier and effort names inside every adapter table; ambiguous reverse patterns. */
  modelTables() {
    const { tiers, efforts } = this.cfg;
    for (const [adapter, table] of Object.entries(this.cfg.models)) {
      for (const [tier, row] of Object.entries(table.tiers)) {
        const at = `models.${adapter}.tiers.${tier}`;
        if (!tiers.includes(tier)) this.error(at, `undefined tier "${tier}"`);
        for (const e of Object.keys(row.effort)) {
          if (!efforts.includes(e)) this.error(`${at}.effort.${e}`, `undefined effort "${e}"`);
        }
        for (const e of efforts) {
          if (!(e in row.effort)) this.warn(`${at}.effort`, `no native value for effort "${e}"`);
        }
      }
      const seen = new Map<string, string>();
      table.reverse.forEach((r, i) => {
        const at = `models.${adapter}.reverse[${i}]`;
        if (!tiers.includes(r.tier)) this.error(at, `undefined tier "${r.tier}"`);
        const earlier = seen.get(r.pattern);
        if (earlier !== undefined && earlier !== r.tier) {
          this.error(at, `contradiction: "${r.pattern}" already maps to tier "${earlier}"`);
        } else if (earlier !== undefined) {
          this.warn(at, `duplicate pattern "${r.pattern}"`);
        } else seen.set(r.pattern, r.tier);
      });
    }
  }

  presets() {
    for (const [name, p] of Object.entries(this.cfg.presets)) {
      for (const [type, tier] of Object.entries(p.tierByTaskType)) {
        if (!this.cfg.tiers.includes(tier)) {
          this.error(`presets.${name}.tierByTaskType.${type}`, `undefined tier "${tier}"`);
        }
      }
    }
  }

  /** Direct mappings: instance, effort and model names; contradictions; shadowing. */
  directMappings() {
    const { directMappings: maps, efforts } = this.cfg;
    maps.forEach((m, i) => {
      const at = `directMappings[${i}]`;
      const inst = this.byId.get(m.instance);
      if (!inst) this.error(`${at}.instance`, `unknown instance "${m.instance}"`);
      if (m.fromEffort !== undefined && !efforts.includes(m.fromEffort)) {
        this.error(`${at}.fromEffort`, `undefined effort "${m.fromEffort}"`);
      }
      const table = inst && this.cfg.models[inst.adapter];
      if (table && !modelsOf(table).has(m.model)) {
        this.warn(
          `${at}.model`,
          `model "${m.model}" is not in the ${inst.adapter} table (known: ${[...modelsOf(table)].join(", ")})`,
        );
      }
      for (let j = 0; j < i; j++) {
        const prev = maps[j];
        if (!prev || prev.fromModel !== m.fromModel) continue;
        if (prev.fromEffort === m.fromEffort) {
          const same =
            prev.instance === m.instance && prev.model === m.model && prev.effort === m.effort;
          if (same) this.warn(at, `duplicate of directMappings[${j}]`);
          else
            this.error(
              at,
              `contradicts directMappings[${j}]: same ${keyOf(m)} maps to two targets`,
            );
          break;
        }
        if (prev.fromEffort === undefined) {
          this.warn(
            at,
            `shadowed by directMappings[${j}], which matches ${m.fromModel} at any effort`,
          );
          break;
        }
      }
    });
  }

  /** Rules of one list (`pins` or one profile): per-rule checks, then reachability. */
  ruleList(path: string, rules: readonly Rule[], noun: "pin" | "rule") {
    rules.forEach((rule, i) => {
      this.rule(`${path}[${i}]`, rule);
      for (let j = 0; j < i; j++) {
        const prev = rules[j] as Rule;
        if (prev.id === rule.id) {
          this.warn(`${path}[${i}].id`, `duplicate ${noun} id "${rule.id}" (also at [${j}])`);
        }
      }
      const shadow = rules.slice(0, i).find((prev) => subsumes(prev.match, rule.match));
      if (shadow) {
        const why = isCatchAll(shadow.match)
          ? `${noun} "${shadow.id}" before it matches every task`
          : `earlier ${noun} "${shadow.id}" already matches everything it matches`;
        this.warn(`${path}[${i}]`, `${noun} "${rule.id}" is unreachable: ${why}`);
      }
    });
  }

  private rule(at: string, rule: Rule) {
    const { match, action } = rule;
    match.tier?.forEach((t, i) => {
      if (!this.cfg.tiers.includes(t))
        this.error(`${at}.match.tier[${i}]`, `undefined tier "${t}"`);
    });
    for (const id of Object.keys(match.minRemainingPct ?? {})) {
      if (!this.byId.has(id)) {
        this.error(`${at}.match.minRemainingPct.${id}`, `unknown instance "${id}"`);
      }
    }
    const ids = actionInstances(action);
    const known: RoutingInstance[] = [];
    ids.forEach((id, i) => {
      const inst = this.byId.get(id);
      const where =
        action.type === "provider" ? `${at}.action.instance` : `${at}.action.instances[${i}]`;
      if (inst) known.push(inst);
      else this.error(where, `unknown instance "${id}"`);
    });
    const enabled = new Set(known.filter((i) => i.enabled).map((i) => i.id));
    if (action.type === "fanout" && enabled.size < 2) {
      this.warn(
        `${at}.action`,
        `fanout needs 2 enabled instances but ${enabled.size} of [${ids.join(", ")}] ${enabled.size === 1 ? "is" : "are"} enabled`,
      );
    } else if (
      (action.type === "provider" || action.type === "fallback") &&
      known.length > 0 &&
      enabled.size === 0
    ) {
      this.warn(
        `${at}.action`,
        `no instance in [${ids.join(", ")}] is enabled: the task always stays on the host`,
      );
    }
    this.autonomy(at, match, known);
  }

  /** A rule must not be able to hand a task to an instance whose ceiling is lower (e.g. agy). */
  private autonomy(at: string, match: RuleMatch, targets: readonly RoutingInstance[]) {
    const ceiling = rank(this.cfg.maxAutonomy);
    const levels = (match.autonomy ?? AUTONOMY_ORDER).filter((l) => rank(l) <= ceiling);
    for (const inst of targets) {
      const bad = levels.filter((l) => rank(l) > rank(inst.maxAutonomy));
      if (bad.length > 0) {
        this.warn(
          `${at}.action`,
          `${inst.id} accepts at most "${inst.maxAutonomy}" but this rule can match ${bad.join("/")} tasks; add match.autonomy: [${inst.maxAutonomy}]`,
        );
      }
    }
  }
}

const modelsOf = (t: AdapterModelTable) => new Set(Object.values(t.tiers).map((r) => r.model));
const keyOf = (m: { fromModel: string; fromEffort?: string | undefined }) =>
  m.fromEffort === undefined ? `"${m.fromModel}"` : `"${m.fromModel}" at effort ${m.fromEffort}`;
