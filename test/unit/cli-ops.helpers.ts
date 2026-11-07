/** Harness for `status`, `logs` and `gc`: a CLI over a temp HOME with a seedable state store. */
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type {
  NormalizedEvent,
  QuotaWindow,
  RunRecord,
  RunResult,
} from "../../src/core/contracts.js";
import { type QuotaReader, QuotaReaderRegistry } from "../../src/quota/reader.js";
import { SqliteStateStore } from "../../src/state/store.js";
import { runResult } from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";
import { sandbox } from "./config/helpers.js";

export const NOW = "2026-11-07T10:00:00.000Z";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** ISO time `ms` from the fake clock's start. */
export const iso = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

/** A global config that enables the (experimental) antigravity instance and declares plans. */
export const THREE_PROVIDERS = `version: 1
providers:
  claude: { plan: max5x }
  codex: { plan: plus }
  antigravity: { enabled: true, tos_acknowledged: true }
`;

export interface Run {
  code: number;
  out: string;
  err: string;
}

export interface OpsOptions {
  readers?: QuotaReader[];
  /** Registers each reader for this adapter. */
  readerAdapter?: string;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
}

const stores: SqliteStateStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** A sandbox, a fake clock and a runner for `dispatch <args>`; `store` writes the same database. */
export function opsHarness(opts: OpsOptions = {}) {
  const sb = sandbox();
  const clock = new FakeClock(NOW);
  const registry = new QuotaReaderRegistry();
  for (const r of opts.readers ?? []) registry.register(opts.readerAdapter ?? "codex", r);
  let seedStore: SqliteStateStore | undefined;
  return {
    sb,
    clock,
    /** The state store behind the CLI (same file), for seeding and assertions. */
    get store(): SqliteStateStore {
      if (!seedStore) {
        seedStore = SqliteStateStore.open(join(sb.dispatchHome, "state", "dispatch.db"), { clock });
        stores.push(seedStore);
      }
      return seedStore;
    },
    async run(
      args: string[],
      runOpts: { cwd?: string; env?: Record<string, string>; decorate?: boolean } = {},
    ) {
      const env = { ...sb.env, ...runOpts.env };
      let out = "";
      let err = "";
      const io = {
        out: (t: string) => {
          out += t;
        },
        err: (t: string) => {
          err += t;
        },
        ...(runOpts.decorate ? { decorate: { out: true, err: true } } : {}),
      };
      const program = buildProgram(
        io,
        {},
        {},
        {
          cwd: runOpts.cwd ?? sb.root,
          env,
          clock,
          newId: () => "task-1",
          quotaReaders: registry,
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
          ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
        },
      );
      const code = await runCli(args, io, program, { platform: process.platform, env });
      return { code, out, err } satisfies Run;
    },
  };
}

export type Ops = ReturnType<typeof opsHarness>;

/** A real quota reading of `kind`. */
export function reading(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    kind: "5h",
    usedPct: 40,
    resetAt: iso(2 * HOUR),
    source: "fake-reader",
    readAt: NOW,
    reliability: "real",
    ...over,
  };
}

/** A reader that always fails with `message`. */
export function failingReader(id: string, message: string): QuotaReader {
  return {
    id,
    version: "1.0",
    channel: "app-server",
    async read() {
      throw new Error(message);
    },
  };
}

/** A run record; `result` is derived from the fixture unless given. */
export function runRecord(
  runId: string,
  over: Partial<Omit<RunRecord, "result">> & { result?: Partial<RunResult> | null } = {},
): RunRecord {
  const { result, ...rest } = over;
  const status = rest.status ?? "completed";
  return {
    runId,
    status,
    createdAt: NOW,
    updatedAt: NOW,
    instance: "codex",
    pid: null,
    ...rest,
    result:
      result === null || (result === undefined && status === "running")
        ? null
        : { ...runResult, runId, status, ...result },
  };
}

export const event = (kind: NormalizedEvent["kind"], ms: number, rest = {}): NormalizedEvent => ({
  kind,
  ts: iso(ms),
  ...rest,
});
