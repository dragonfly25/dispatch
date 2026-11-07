/**
 * Core of `dispatch hook <host> <event>`: parse stdin, route to the host's handler, return what to
 * print. Never throws and never fails the host: every problem becomes a silent exit 0.
 *
 * Imports node built-ins and types only (bundled into the ≤ 80 ms hook entry).
 */
import type { HookInput, HookResponse } from "../core/contracts.js";

/** Largest stdin accepted (1 MiB); bigger input is ignored. */
export const MAX_HOOK_STDIN = 1024 * 1024;

/** A host's hook handlers, keyed by hook event name ("SessionStart", "PreToolUse", ...). */
export type HookHandlers = Record<string, (input: HookInput) => Promise<HookResponse>>;

/** Lazily loaded handler modules per host id, so the entry loads only the host it serves. */
export type HookHostTable = Readonly<Record<string, () => Promise<HookHandlers>>>;

const SILENT: HookResponse = { exitCode: 0 };

/**
 * Reads `stream` up to `limit` bytes. Resolves null when the input is larger than `limit` or the
 * stream errors.
 */
export function readLimited(stream: NodeJS.ReadableStream, limit = MAX_HOOK_STDIN) {
  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        resolve(null);
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(null));
  });
}

/**
 * Runs one hook. `args` are `[host, event]`; `stdin` is the raw input (null when it was too big).
 * Unknown host or event, malformed JSON, a handler error or an invalid response: silent exit 0.
 */
export async function runHook(
  args: readonly string[],
  stdin: string | null,
  table: HookHostTable,
): Promise<HookResponse> {
  try {
    const [host, event] = args;
    if (host === undefined || event === undefined || stdin === null) return SILENT;
    if (!Object.hasOwn(table, host)) return SILENT;
    const load = table[host];
    if (load === undefined) return SILENT;
    const handlers = await load();
    if (!Object.hasOwn(handlers, event)) return SILENT;
    const handler = handlers[event];
    const input: unknown = JSON.parse(stdin);
    if (
      handler === undefined ||
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return SILENT;
    }
    const res = await handler(input as HookInput);
    const code =
      Number.isInteger(res.exitCode) && res.exitCode >= 0 && res.exitCode < 256 ? res.exitCode : 0;
    return typeof res.stdout === "string"
      ? { stdout: res.stdout, exitCode: code }
      : { exitCode: code };
  } catch {
    return SILENT;
  }
}
