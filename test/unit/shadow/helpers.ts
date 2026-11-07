import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, DecisionInput, RunRecord } from "../../../src/core/contracts.js";
import { decide } from "../../../src/router/index.js";
import { recordDecisionWithShadow } from "../../../src/shadow/index.js";
import { SqliteStateStore } from "../../../src/state/store.js";
import { runResult } from "../../fixtures/contracts.js";
import { FakeClock } from "../../stubs/index.js";
import { type InputOverrides, makeInput } from "../router/fixtures.js";

export const BASE = Date.parse("2026-11-07T10:00:00.000Z");
export const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

export interface TempStore {
  store: SqliteStateStore;
  clock: FakeClock;
  close(): Promise<void>;
}

/** A SQLite store in a temp dir, with a fake clock. */
export async function tempStore(): Promise<TempStore> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-shadow-"));
  const clock = new FakeClock(at(0));
  const store = SqliteStateStore.open(join(dir, "state", "dispatch.db"), { clock });
  return {
    store,
    clock,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const TYPES = ["test", "docs", "review", "refactor"] as const;

/** Overrides for the i-th seeded task: varied type, paths and autonomy; decision time `at(i)`. */
export function seedOverrides(i: number): InputOverrides {
  const paths =
    i % 7 === 0 ? ["db/migrations/001.sql"] : i % 11 === 0 ? ["secrets/key.txt"] : ["src/a.ts"];
  return {
    task: {
      id: `t${i}`,
      taskType: TYPES[i % TYPES.length] as string,
      paths,
      autonomy: i % 5 === 0 ? "worktree" : "read-only",
    },
    used: { codex: 20 + (i % 3) * 20, "claude-alt": 60, agy: 70 },
    config: {
      pins: [
        { id: "migrations", match: { paths: ["db/migrations/**"] }, action: { type: "host" } },
        {
          id: "secrets",
          match: { paths: ["secrets/**"] },
          action: { type: "reject", reason: "secrets never leave the host" },
        },
      ],
    },
  };
}

export function seedInput(i: number, extra: InputOverrides = {}): DecisionInput {
  const input = makeInput({ ...seedOverrides(i), ...extra });
  return { ...input, now: at(i) };
}

/** Records decision `d{i}` (real under the input's active profile) plus its shadow rows. */
export async function seedDecision(
  store: SqliteStateStore,
  i: number,
  extra: InputOverrides = {},
  profiles: string[] = ["preserve"],
  runId: string | null = null,
): Promise<{ id: string; input: DecisionInput; decision: Decision }> {
  const input = seedInput(i, extra);
  const decision = decide(input);
  const id = `d${i}`;
  await recordDecisionWithShadow(store, input, decision, { id, profiles, runId });
  return { id, input, decision };
}

/** A terminal run record for a decision. `instance: null` means it returned to the host. */
export function runFor(
  runId: string,
  instance: string | null,
  status: RunRecord["status"] = instance ? "completed" : "returned_to_host",
): RunRecord {
  return {
    runId,
    status,
    createdAt: at(0),
    updatedAt: at(1),
    instance,
    pid: null,
    result: {
      ...runResult,
      runId,
      status,
      externalAgent: instance
        ? { provider: instance, instance, model: "m", marker: "EXTERNAL_AGENT_OUTPUT" }
        : null,
    },
  };
}
