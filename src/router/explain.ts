/**
 * Human-readable rendering of a decision (spec §6 req. 3, §7 "explain"). Deterministic: the text
 * depends only on its arguments, so it is snapshot-tested.
 */
import type { Decision, DecisionInput, RuleTrace } from "../core/contracts.js";
import type { InstanceExclusion } from "./capability.js";
import { parseRoutingConfig } from "./decide.js";
import { quotaView } from "./filters.js";

function traceLine(t: RuleTrace): string {
  const mark = t.matched ? "+" : "-";
  return `  ${mark} [${t.layer}] ${t.ruleId}: ${t.effect}${t.note === undefined ? "" : ` (${t.note})`}`;
}

const isResolution = (t: RuleTrace) =>
  t.ruleId.startsWith("tier:") || t.ruleId.startsWith("effort:");

/**
 * Renders `decision` for `input`: requested model → tier (with the rule), rule chain, candidates
 * and filters, chosen targets with model/effort and their source, quota used (value, reliability,
 * source), the reason, and one line per alternative profile when `alternatives` is given.
 * `unavailable` lists instances taken out of routing before the decision (shown as "disabled" in
 * the candidates), with the reason (e.g. the adapter does not run on this OS).
 */
export function renderExplain(
  input: DecisionInput,
  decision: Decision,
  alternatives?: Record<string, Decision>,
  unavailable: readonly InstanceExclusion[] = [],
): string {
  const cfg = parseRoutingConfig(input.routing);
  const { task, host } = input;
  const lines: string[] = [];
  lines.push(
    `Dispatch explain (router ${input.routerVersion}, profile ${cfg.activeProfile}, preset ${cfg.activePreset})`,
    `Input: sha256 ${decision.inputHash.slice(0, 16)}`,
    `Task: ${task.id} | type ${task.taskType ?? "-"} | autonomy ${task.autonomy} | paths ${task.paths.length}`,
    `Host: self ${host.self ?? "none"} | session model ${host.sessionModel ? `${host.sessionModel.value}${host.sessionModel.observed ? "" : " (not observed)"}` : "-"}`,
    `Requested model: ${task.requestedModel ?? `(unspecified: ${cfg.unspecifiedModel})`}`,
    "Tier and effort:",
    ...decision.chain.filter(isResolution).map(traceLine),
  );

  const rules = decision.chain.filter((t) => !isResolution(t) && t.layer !== "filter");
  lines.push("Rules:", ...rules.map(traceLine));

  const filters = decision.chain.filter((t) => t.layer === "filter");
  lines.push("Candidates:", ...(filters.length ? filters.map(traceLine) : ["  (none)"]));
  if (unavailable.length) {
    lines.push("Unavailable (disabled for this decision):");
    for (const u of unavailable) lines.push(`  ${u.id}: ${u.reason}`);
  }

  lines.push(`Decision: ${decision.action} (${decision.mode})`);
  const winner = [...rules].reverse().find((t) => t.matched);
  const adapterOf = (id: string) => cfg.instances.find((i) => i.id === id)?.adapter ?? "?";
  decision.targets.forEach((t, i) => {
    const source =
      winner?.layer === "mapping"
        ? `direct mapping ${winner.ruleId}`
        : `models.${adapterOf(t.instance)}.tiers.${t.tier}`;
    lines.push(
      `  ${i + 1}. ${t.instance}: model ${t.model}, effort ${t.effort}, tier ${t.tier} [${source}]`,
    );
  });

  const known = new Set(cfg.instances.map((i) => i.id));
  const ids = [...new Set(filters.map((f) => f.ruleId))].filter((id) => known.has(id));
  if (ids.length) {
    lines.push(`Quota used (snapshot ${input.quota.takenAt}):`);
    for (const id of ids) {
      const q = quotaView(input.quota, id);
      const w = q.window;
      lines.push(
        w
          ? `  ${id}: ${w.usedPct}% used [${w.kind}] (${w.reliability}, source ${w.source}, read ${w.readAt})`
          : `  ${id}: unknown`,
      );
    }
  }
  lines.push(`Reason: ${decision.reason}`);

  if (alternatives && Object.keys(alternatives).length) {
    lines.push("Other profiles:");
    for (const [name, alt] of Object.entries(alternatives)) {
      const targets = alt.targets.map((t) => `${t.instance}:${t.model}:${t.effort}`).join(", ");
      lines.push(
        `  ${name}: ${alt.action} (${alt.mode})${targets ? ` -> ${targets}` : ""} | ${alt.reason}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
