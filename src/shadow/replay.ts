/**
 * Replay (`explain --replay`, AC3): re-runs the pure router on a stored decision input and diffs
 * the result against what was recorded.
 */
import { type Decision, type DecisionInput, ExitCode, type RuleTrace } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { decide, decideForProfiles } from "../router/index.js";
import type { SqliteStateStore } from "../state/store.js";

/** The slice of {@link SqliteStateStore} replay reads from. */
export type ReplayStore = Pick<SqliteStateStore, "listDecisions" | "listShadow">;

const EPOCH = "1970-01-01T00:00:00.000Z";

export interface ReplayOptions {
  /** Substitute routing configuration (a full `RoutingConfig`) for the stored one. */
  withConfig?: Record<string, unknown>;
  /** Replay as this profile (compared to its shadow row) instead of the one that was active. */
  profile?: string;
}

/** One field that differs between the recorded and the replayed decision. */
export interface DecisionDiffEntry {
  /** `action`, `mode`, `reason`, `inputHash`, `targets[i]` or `chain[i]`. */
  field: string;
  recorded: string;
  replayed: string;
}

export interface ReplayResult {
  decisionId: string;
  /** Profile that was replayed (the active one unless `options.profile` named another). */
  profile: string;
  /** True when `withConfig` replaced the stored routing configuration. */
  configSubstituted: boolean;
  /** The input the replay ran on (stored input, with the substituted config if any). */
  input: DecisionInput;
  recorded: Decision;
  replayed: Decision;
  /** `recorded` and `replayed` are identical in every field, including `inputHash`. */
  identical: boolean;
  diff: DecisionDiffEntry[];
}

const target = (t: Decision["targets"][number]): string =>
  `${t.instance}:${t.model}:${t.effort} (${t.tier})`;

const traceText = (t: RuleTrace): string =>
  `[${t.layer}] ${t.ruleId} ${t.matched ? "+" : "-"} ${t.effect}${t.note === undefined ? "" : ` (${t.note})`}`;

/** Field-by-field differences between two decisions; empty when they are identical. */
export function diffDecisions(recorded: Decision, replayed: Decision): DecisionDiffEntry[] {
  const out: DecisionDiffEntry[] = [];
  const cmp = (field: string, a: string, b: string) => {
    if (a !== b) out.push({ field, recorded: a, replayed: b });
  };
  cmp("action", recorded.action, replayed.action);
  cmp("mode", recorded.mode, replayed.mode);
  cmp("reason", recorded.reason, replayed.reason);
  cmp("inputHash", recorded.inputHash, replayed.inputHash);
  const lists: [string, string[], string[]][] = [
    ["targets", recorded.targets.map(target), replayed.targets.map(target)],
    ["chain", recorded.chain.map(traceText), replayed.chain.map(traceText)],
  ];
  for (const [name, a, b] of lists) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      cmp(`${name}[${i}]`, a[i] ?? "(none)", b[i] ?? "(none)");
    }
  }
  return out;
}

const notFound = (what: string) =>
  new DispatchError(`shadow: ${what}`, ExitCode.USAGE, "shadow.not_found");

/**
 * Re-runs the router on the stored input of `decisionId` (optionally with a substituted routing
 * config, or as another profile) and diffs it against the recorded decision.
 *
 * @throws DispatchError `shadow.not_found` when the decision (or the requested profile's shadow
 *   row) does not exist; `router.config_invalid` when the (substituted) config is invalid.
 */
export async function replayDecision(
  store: ReplayStore,
  decisionId: string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const record = (await store.listDecisions(EPOCH)).find((r) => r.id === decisionId);
  if (!record) throw notFound(`no recorded decision "${decisionId}"`);

  const input: DecisionInput = options.withConfig
    ? { ...record.input, routing: options.withConfig }
    : record.input;
  const active = record.input.routing.activeProfile;
  const profile = options.profile ?? (typeof active === "string" ? active : "");

  let recorded = record.decision;
  let replayed: Decision;
  if (options.profile !== undefined && options.profile !== active) {
    const row = store
      .listShadow(EPOCH)
      .find((s) => s.decisionId === decisionId && s.profile === profile);
    if (!row) throw notFound(`decision "${decisionId}" has no shadow row for profile "${profile}"`);
    recorded = row.decision;
    replayed = decideForProfiles(input, [profile])[profile] as Decision;
  } else {
    replayed = decide(input);
  }
  const diff = diffDecisions(recorded, replayed);
  return {
    decisionId,
    profile,
    configSubstituted: options.withConfig !== undefined,
    input,
    recorded,
    replayed,
    identical: diff.length === 0,
    diff,
  };
}
