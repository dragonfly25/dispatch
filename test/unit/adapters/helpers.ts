/** Shared helpers for adapter tests: a real (test-only) Spawner and fixture replay. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Adapter,
  AdapterOutcome,
  AdapterRunContext,
  NormalizedEvent,
  Spawner,
  SpawnRequest,
  SpawnResult,
} from "../../../src/core/contracts.js";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Minimal process-group spawner for tests (WP13 owns the production one): line-splits output,
 * kills the group with SIGKILL on timeout and reports `timedOut`.
 */
export class TestSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];

  spawn(req: SpawnRequest): Promise<SpawnResult> {
    this.requests.push(req);
    return new Promise((resolve, reject) => {
      const child = spawn(req.binary, [...req.argv], {
        cwd: req.cwd,
        env: { ...req.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let timedOut = false;
      const timer =
        req.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
              } catch {
                // already gone
              }
            }, req.timeoutMs);
      for (const name of ["stdout", "stderr"] as const) {
        let buf = "";
        child[name].setEncoding("utf8").on("data", (d: string) => {
          buf += d;
          let i = buf.indexOf("\n");
          while (i >= 0) {
            req.onLine?.(name, buf.slice(0, i));
            buf = buf.slice(i + 1);
            i = buf.indexOf("\n");
          }
        });
        child[name].on("end", () => {
          if (buf) req.onLine?.(name, buf);
        });
      }
      child.stdin.on("error", () => {});
      child.stdin.end(req.stdin ?? "");
      child.on("error", reject);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut });
      });
    });
  }
}

/** A fresh run context. */
export function runCtx(worktree: string, scratch: Record<string, unknown> = {}): AdapterRunContext {
  return { runId: "run-1", worktree, scratch };
}

/** Lines of a recorded fixture with `<TMP>`/`<WT>` replaced. */
export function fixtureLines(spec: string, subs: Record<string, string> = {}): string[] {
  let text = readFileSync(join(FIXTURES, `${spec}.stdout.jsonl`), "utf8");
  for (const [k, v] of Object.entries(subs)) text = text.replaceAll(k, v);
  return text.split("\n").filter((l) => l.length > 0);
}

/** Exit code recorded in a fixture's meta.json. */
export function fixtureExit(spec: string): number {
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${spec}.meta.json`), "utf8")) as {
    exitCode: number;
  };
  return meta.exitCode;
}

/** Feeds `lines` through parseLine and finalize. */
export function replay(
  adapter: Adapter,
  lines: string[],
  ctx: AdapterRunContext,
  result: Partial<SpawnResult> & { durationMs?: number } = {},
  stderr: string[] = [],
): { events: NormalizedEvent[]; outcome: AdapterOutcome } {
  const events = [
    ...lines.flatMap((l) => adapter.parseLine("stdout", l, ctx)),
    ...stderr.flatMap((l) => adapter.parseLine("stderr", l, ctx)),
  ];
  const outcome = adapter.finalize(
    { exitCode: 0, signal: null, timedOut: false, durationMs: 10, ...result },
    ctx,
  );
  return { events, outcome };
}
