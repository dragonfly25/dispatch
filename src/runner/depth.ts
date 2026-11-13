import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { envGet } from "../platform/os.js";

/** Name of the environment variable that carries the nesting depth. */
export const DEPTH_ENV = "DISPATCH_DEPTH";

/** Thrown when a nested call would exceed `max_depth`; the run is recorded as `rejected`. */
export class RecursionRejectedError extends DispatchError {
  readonly outcome = "rejected" as const;
  readonly reason = "recursion" as const;

  constructor(
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(
      `recursion refused: DISPATCH_DEPTH=${depth} is not below max_depth=${maxDepth}`,
      ExitCode.REJECTED,
      "run.depth_exceeded",
    );
  }
}

/**
 * Nesting depth from `DISPATCH_DEPTH`: 0 when unset or empty. A malformed value is treated as
 * infinitely deep, so a corrupted variable refuses instead of silently allowing recursion.
 */
export function currentDepth(env: Readonly<Record<string, string | undefined>>): number {
  const raw = envGet(env, DEPTH_ENV)?.trim();
  if (raw === undefined || raw === "") return 0;
  return /^\d+$/.test(raw) ? Number(raw) : Number.POSITIVE_INFINITY;
}

/**
 * Refuses to run when this process is already nested `maxDepth` levels deep (default max_depth
 * is 1: a top-level call has depth 0, its child 1 and may not dispatch again).
 * @returns the current depth when allowed.
 * @throws RecursionRejectedError (exit code REJECTED, outcome `rejected`, reason `recursion`).
 */
export function assertDepthAllowed(
  env: Readonly<Record<string, string | undefined>>,
  maxDepth: number,
): number {
  const depth = currentDepth(env);
  if (depth >= maxDepth) throw new RecursionRejectedError(depth, maxDepth);
  return depth;
}
