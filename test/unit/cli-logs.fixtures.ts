import { decide } from "../../src/router/index.js";
import type { SqliteStateStore } from "../../src/state/store.js";
import { makeInput } from "./router/fixtures.js";

/** Records one real decision (made from a fixture input) for `runId`. */
export async function decideForTest(store: SqliteStateStore, runId: string): Promise<void> {
  const input = makeInput();
  await store.recordDecision({
    id: `dec-${runId}`,
    createdAt: input.now,
    runId,
    input,
    decision: decide(input),
  });
}
