/**
 * Rule condition matching (semantics documented on `RuleMatchSchema` in src/core/routing.ts).
 */
import picomatch from "picomatch";
import type { QuotaSnapshot, SessionHistoryEntry, Task, Tier } from "../core/contracts.js";
import type { Rule, RuleAction } from "../core/routing.js";
import { quotaView } from "./filters.js";

/** Facts a rule is matched against. */
export interface MatchFacts {
  task: Task;
  /** Resolved tier (after the preset's `tierByTaskType`). */
  tier: Tier;
  quota: QuotaSnapshot;
  sessionHistory: readonly SessionHistoryEntry[];
}

/** Instance ids named by an action (empty for host and reject). */
export function actionInstances(action: RuleAction): string[] {
  switch (action.type) {
    case "provider":
      return [action.instance];
    case "fallback":
    case "fanout":
      return action.instances;
    default:
      return [];
  }
}

/**
 * Evaluates every condition of `rule.match` in a fixed order and returns the name of the first
 * one that fails, or null when the rule matches.
 */
export function firstFailedCondition(rule: Rule, facts: MatchFacts): string | null {
  const m = rule.match;
  const { task } = facts;
  if (m.taskType && (task.taskType === undefined || !m.taskType.includes(task.taskType))) {
    return "taskType";
  }
  if (m.paths) {
    const isMatch = picomatch(m.paths, { dot: true });
    if (!task.paths.some((p) => isMatch(p))) return "paths";
  }
  if (m.tier && !m.tier.includes(facts.tier)) return "tier";
  if (m.autonomy && !m.autonomy.includes(task.autonomy)) return "autonomy";
  if (m.minRemainingPct) {
    for (const [id, min] of Object.entries(m.minRemainingPct).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const remaining = quotaView(facts.quota, id).remainingPct;
      if (remaining === null || remaining < min) return `minRemainingPct.${id}`;
    }
  }
  if (m.reliability) {
    for (const id of actionInstances(rule.action)) {
      if (!m.reliability.includes(quotaView(facts.quota, id).reliability))
        return `reliability.${id}`;
    }
  }
  if (m.priorOutcome) {
    const accepted: readonly string[] = m.priorOutcome;
    if (!facts.sessionHistory.some((h) => accepted.includes(h.outcome))) return "priorOutcome";
  }
  return null;
}
