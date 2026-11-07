/**
 * Shadow mode, recording side (UC8, plan §2 "Determinism and shadow mode").
 *
 * For every real routing decision, the decision each OTHER profile would have taken on the same
 * input snapshot is computed with the pure router and stored beside it. Nothing is executed:
 * only `decide`-family calls and store writes happen here.
 */
import { systemClock } from "../core/clock.js";
import { type Clock, type Decision, type DecisionInput, ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { newRunId } from "../core/ids.js";
import { decideForProfiles, inputHash, parseRoutingConfig } from "../router/index.js";
import type { SqliteStateStore } from "../state/store.js";

/** The slice of {@link SqliteStateStore} this module writes to. */
export type ShadowStore = Pick<SqliteStateStore, "recordDecision" | "recordShadow">;

export interface RecordShadowOptions {
  /**
   * Profiles to evaluate in shadow. Empty/absent: `routing.shadowProfiles` when non-empty, else
   * every profile except the active one. The active profile is always dropped (it is the real one).
   */
  profiles?: readonly string[];
  /** Decision id. Defaults to a fresh ULID-style id from `clock`. */
  id?: string;
  /** Decision timestamp. Defaults to `input.now`, the instant the router saw. */
  createdAt?: string;
  /** Run this decision belongs to, when it is already known. */
  runId?: string | null;
  /** Time source for the default id. */
  clock?: Clock;
}

export interface RecordedDecision {
  /** Id under which the real decision (and every shadow row) was stored. */
  id: string;
  /** Shadow decisions by profile name, in the order they were stored. */
  shadow: Record<string, Decision>;
}

/**
 * Resolves which profiles to evaluate in shadow for `input` (see {@link RecordShadowOptions.profiles}).
 * De-duplicated, in configuration order, never containing the active profile.
 */
export function shadowProfileNames(
  input: DecisionInput,
  explicit?: readonly string[],
): readonly string[] {
  const cfg = parseRoutingConfig(input.routing);
  const wanted =
    explicit && explicit.length > 0
      ? explicit
      : cfg.shadowProfiles.length > 0
        ? cfg.shadowProfiles
        : Object.keys(cfg.profiles);
  return [...new Set(wanted)].filter((name) => name !== cfg.activeProfile);
}

/**
 * Stores the real `decision` (with its canonical `input`; the store redacts it) and, for each
 * shadow profile, the decision `decideForProfiles` takes on the same input snapshot.
 *
 * All shadow decisions are computed before anything is written, so an unknown profile name or an
 * invalid routing config throws without leaving a half-recorded decision behind.
 *
 * @throws DispatchError `shadow.hash_mismatch` when `decision` was not made from `input`;
 *   `router.config_invalid` for an invalid routing config or unknown shadow profile.
 */
export async function recordDecisionWithShadow(
  store: ShadowStore,
  input: DecisionInput,
  decision: Decision,
  options: RecordShadowOptions = {},
): Promise<RecordedDecision> {
  if (decision.inputHash !== inputHash(input)) {
    throw new DispatchError(
      "shadow: the decision was not produced from this input (input hash mismatch)",
      ExitCode.FAILED,
      "shadow.hash_mismatch",
    );
  }
  const shadow = decideForProfiles(input, shadowProfileNames(input, options.profiles));
  const id = options.id ?? newRunId(options.clock ?? systemClock);
  await store.recordDecision({
    id,
    createdAt: options.createdAt ?? input.now,
    runId: options.runId ?? null,
    input,
    decision,
  });
  for (const [profile, d] of Object.entries(shadow)) store.recordShadow(id, profile, d);
  return { id, shadow };
}
