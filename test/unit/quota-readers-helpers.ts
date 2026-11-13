import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { spawnCommandFor } from "../../src/runner/spawn.js";
import { killTree, spawnDetachedFor } from "../../src/runner/tree.js";
import { writeNodeShim } from "../support/shims.js";

/** Test-only Spawner on child_process (the production one arrives with the supervisor). */
export class NodeSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];

  spawn(req: SpawnRequest): Promise<SpawnResult> {
    this.requests.push(req);
    return new Promise((resolve, reject) => {
      const cmd = spawnCommandFor(req.binary, req.argv);
      const child = spawn(cmd.command, cmd.args, {
        cwd: req.cwd,
        env: { ...req.env },
        detached: spawnDetachedFor(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let timedOut = false;
      // POSIX: SIGKILL to the group; Windows: taskkill /T /F.
      const kill = () => {
        if (child.pid !== undefined) killTree(child.pid, { force: true });
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

/**
 * Writes a stand-in CLI running the node module `source` and returns its path: a `#!/bin/sh`
 * shim on POSIX, an npm-shaped `cli.cmd` (unwrapped by `toSpawnCommand`) on Windows.
 */
export function writeScript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-script-"));
  const file = join(dir, "cli-main.mjs");
  writeFileSync(file, `${source}\n`);
  return writeNodeShim(dir, "cli", file);
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
