import { performance } from "node:perf_hooks";
import type { Clock } from "./contracts.js";

/** Real clock: wall time for timestamps, `performance.now()` for durations and timeouts. */
export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};
