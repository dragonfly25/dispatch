import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/store.js";
import * as fx from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";
import { CANARY_ENV_VALUE, CANARY_MARKER, SECRET_SAMPLES } from "../support/secrets.js";

let dir: string;
let dbPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-canary-"));
  dbPath = join(dir, "state", "dispatch.db");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every byte Dispatch left in the state directory (db, -wal, -shm, anything else). */
async function rawStateBytes(): Promise<string> {
  const stateDir = join(dir, "state");
  const parts: string[] = [];
  for (const name of await readdir(stateDir)) {
    parts.push((await readFile(join(stateDir, name))).toString("latin1"));
  }
  return parts.join("\n");
}

/** All canary strings: the marker, each sample's value part, the env value. */
const NEEDLES = [
  CANARY_MARKER,
  CANARY_ENV_VALUE,
  ...Object.values(SECRET_SAMPLES).map((s) => s.slice(-14)),
  "Q0FOQVJZOnBhc3N3b3Jk",
];

/** One string carrying every secret pattern plus the env canary. */
const KITCHEN_SINK = `${Object.values(SECRET_SAMPLES).join("\n")}\nenv=${CANARY_ENV_VALUE}`;

describe("[SEC-redact][AC7] redaction canaries in the state database", () => {
  it("leaves zero canary bytes in the db, WAL and SHM after writing through every path", async () => {
    const clock = new FakeClock(fx.T0);
    const store = SqliteStateStore.open(dbPath, { clock, secrets: [CANARY_ENV_VALUE] });

    const input = {
      ...fx.decisionInput,
      task: { ...fx.task, prompt: KITCHEN_SINK, paths: [SECRET_SAMPLES["github-token"]] },
      routing: { note: KITCHEN_SINK, [SECRET_SAMPLES["anthropic-key"]]: ["nested", KITCHEN_SINK] },
    };
    const decision = { ...fx.decision, reason: KITCHEN_SINK };

    await store.recordRun({ ...fx.runRecord, instance: KITCHEN_SINK });
    await store.recordDecision({ ...fx.decisionRecord, input, decision });
    await store.updateRun(fx.runRecord.runId, {
      status: "completed",
      result: {
        ...fx.runResult,
        summary: KITCHEN_SINK,
        usage: { raw: { stderr: KITCHEN_SINK } },
        log: { path: `/tmp/${SECRET_SAMPLES["slack-token"]}/log` },
      },
    });
    await store.appendEvent(fx.runRecord.runId, { kind: "error", ts: fx.T0, detail: KITCHEN_SINK });
    store.recordShadow("d-1", KITCHEN_SINK, decision);
    store.recordQuotaReading(KITCHEN_SINK, {
      kind: KITCHEN_SINK,
      usedPct: 1,
      resetAt: null,
      source: KITCHEN_SINK,
      readAt: fx.T0,
      reliability: "real",
    });
    store.recordQuotaSignal(KITCHEN_SINK, "2026-01-02T00:00:00.000Z", KITCHEN_SINK);
    store.setOverride({
      instanceId: KITCHEN_SINK,
      window: KITCHEN_SINK,
      usedPct: 1,
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    store.getOrCreateIdempotent(KITCHEN_SINK, () => `run-with-${CANARY_ENV_VALUE}`);
    store.acquireLease(KITCHEN_SINK, KITCHEN_SINK, {
      pid: 1,
      pidStart: KITCHEN_SINK,
      limit: 1,
      now: fx.T0,
      isAlive: () => true,
    });

    // 1. While open (data may still be only in the WAL).
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    let raw = await rawStateBytes();
    for (const needle of NEEDLES) expect(raw, `needle ${needle}`).not.toContain(needle);
    expect(raw).toContain("[REDACTED:"); // sanity: the data really is in the file

    // 2. What reads back is redacted too.
    const back = JSON.stringify([
      await store.getRun(fx.runRecord.runId),
      await store.listDecisions(fx.T0),
      store.listEvents(fx.runRecord.runId),
      store.listShadow(fx.T0),
      store.latestQuotaReadings(),
      store.activeQuotaSignals(fx.T0),
      store.listOverrides(fx.T0),
      store.listLeases(),
    ]);
    for (const needle of NEEDLES) expect(back).not.toContain(needle);

    // 3. After close the WAL is checkpointed into the main file.
    store.close();
    raw = await rawStateBytes();
    for (const needle of NEEDLES) expect(raw, `needle ${needle}`).not.toContain(needle);
  });

  it("without explicit secrets only the env canary may survive (patterns still hold)", async () => {
    const store = SqliteStateStore.open(dbPath, { clock: new FakeClock(fx.T0) });
    await store.recordRun({ ...fx.runRecord, instance: KITCHEN_SINK });
    store.close();
    const raw = await rawStateBytes();
    for (const sample of Object.values(SECRET_SAMPLES))
      expect(raw).not.toContain(sample.slice(-14));
    // A value matching no pattern is only caught when the caller passes it as a secret.
    expect(raw).toContain(CANARY_ENV_VALUE);
  });

  it("accepts secrets lazily so env changes after open are covered", async () => {
    let secrets: string[] = [];
    const store = SqliteStateStore.open(dbPath, {
      clock: new FakeClock(fx.T0),
      secrets: () => secrets,
    });
    secrets = [CANARY_ENV_VALUE];
    await store.recordRun({ ...fx.runRecord, instance: CANARY_ENV_VALUE });
    store.close();
    expect(await rawStateBytes()).not.toContain(CANARY_ENV_VALUE);
  });
});
