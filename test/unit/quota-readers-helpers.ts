import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderInstance,
  QuotaWindow,
  Spawner,
  SpawnRequest,
  SpawnResult,
} from "../../src/core/contracts.js";

/** Test-only Spawner on child_process (the production one arrives with the supervisor). */
export class NodeSpawner implements Spawner {
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
      const kill = () => {
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {
          // already gone
        }
      };
      const timer =
        req.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill();
            }, req.timeoutMs);
      req.signal?.addEventListener("abort", kill, { once: true });
      for (const stream of ["stdout", "stderr"] as const) {
        createInterface({ input: child[stream] }).on("line", (l) => req.onLine?.(stream, l));
      }
      child.stdin.on("error", () => {});
      child.stdin.end(req.stdin);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut });
      });
    });
  }
}

/** Writes an executable node script (a stand-in CLI) and returns its path. */
export function writeScript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-script-"));
  const file = join(dir, "cli.mjs");
  writeFileSync(file, `#!${process.execPath}\n${source}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A scripted `codex app-server` that answers `account/rateLimits/read` with `result` (or `body`). */
export function scriptedAppServer(
  opts: { result?: unknown; body?: string; exitAfterInit?: boolean } = {},
): string {
  return writeScript(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: 99, method: "server/ask", params: {} });
    send({ method: "note", params: {} });
    send([1, 2]);
    send({ id: 12345, result: {} });
    send({ id: m.id, result: {} });
    ${opts.exitAfterInit ? "process.exit(3);" : ""}
  } else if (m.method === "account/rateLimits/read") {
    ${opts.body ?? `send({ id: m.id, result: ${JSON.stringify(opts.result ?? {})} });`}
  }
});
`);
}

export const instance = (over: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "codex",
  adapter: "codex",
  pool: "subscription",
  ...over,
});

export const byKind = (windows: QuotaWindow[]): Record<string, QuotaWindow> =>
  Object.fromEntries(windows.map((w) => [w.kind, w]));
