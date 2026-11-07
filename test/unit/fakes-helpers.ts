import { type ChildProcess, spawn } from "node:child_process";
import type { FakeCli, FakesContext } from "../support/index.js";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawns a fake CLI by bare name through the PATH of `ctx.env` (exactly how Dispatch finds it). */
export function startFake(
  ctx: FakesContext,
  cli: FakeCli,
  args: string[],
  opts: {
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
    detached?: boolean;
    keepStdin?: boolean;
  } = {},
): { child: ChildProcess; done: Promise<RunResult> } {
  const child = spawn(cli, args, {
    cwd: opts.cwd,
    env: { ...ctx.env, ...opts.env },
    detached: opts.detached,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (d) => {
    stdout += d;
  });
  child.stderr?.setEncoding("utf8").on("data", (d) => {
    stderr += d;
  });
  child.stdin?.on("error", () => {});
  if (opts.input !== undefined) child.stdin?.end(opts.input);
  else if (!opts.keepStdin) child.stdin?.end();
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

/** Runs a fake CLI to completion. */
export function runFake(
  ctx: FakesContext,
  cli: FakeCli,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return startFake(ctx, cli, args, opts).done;
}

export const jsonLines = (text: string): unknown[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(25);
  }
}
