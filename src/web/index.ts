/**
 * Web access for delegated agents (Claude Code custom agents whose `tools:` list `WebSearch` or
 * `WebFetch`): which adapters can give the child web access, and how the request reaches
 * `Adapter.buildInvocation` without touching the frozen `BuildInvocationArgs`: the runner
 * passes {@link BuildInvocationWithWeb} (a structural superset), adapters read `web`.
 *
 * Verified live (docs/spikes/web-access.md):
 * - codex 0.167: `-c web_search="live"` works with `--ignore-user-config --strict-config` in a
 *   `read-only` sandbox; the model-side `web_search` tool opened a given URL (`open_page`) while a
 *   shell `curl` in the same run still had no network. Accepted modes: disabled, cached, indexed,
 *   live.
 * - claude 2.1.301: a `--safe-mode` child lists and uses `WebSearch` and `WebFetch` when they are
 *   in `--tools` and `--allowedTools`.
 * - antigravity: never (read-only, experimental).
 */
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { BuildInvocationWithMcp } from "../mcp/forward.js";

/**
 * Web access a run needs: `search` (the agent declares `WebSearch` only) or `fetch` (it declares
 * `WebFetch`, which must open arbitrary URLs). Absent: none.
 */
export type WebAccess = "search" | "fetch";

/** Optional extension of the invocation arguments carrying the web access of this run. */
export interface WebForwarding {
  /** Web access to give the child; absent: none (the adapter adds no web flag). */
  web?: WebAccess;
}

/** `BuildInvocationArgs` plus forwarded MCP servers and web access. */
export type BuildInvocationWithWeb = BuildInvocationWithMcp & WebForwarding;

/** Adapters that can give the child web access. */
const WEB_CAPABLE: ReadonlySet<string> = new Set(["codex", "claude"]);

/** Why an adapter cannot give web access (returned-to-host reasons). */
export const WEB_UNSUPPORTED: Readonly<Record<string, string>> = {
  antigravity: "antigravity never gets web access (read-only, experimental)",
};

/** True when `adapterId` can give `web` access (always true for none). */
export function adapterCanBrowse(adapterId: string, web: WebAccess | undefined): boolean {
  return web === undefined || WEB_CAPABLE.has(adapterId);
}

/** Adapter ids that can give web access. */
export function webCapableAdapters(): string[] {
  return [...WEB_CAPABLE];
}

/**
 * Fails closed in an adapter that cannot give web access when a run still asks for it (the
 * router should have filtered it out): the child would silently lack tools the agent needs.
 */
export function refuseWeb(adapterId: string, args: WebForwarding): void {
  if (args.web === undefined) return;
  throw new DispatchError(
    WEB_UNSUPPORTED[adapterId] ?? `${adapterId} cannot be given web access`,
    ExitCode.REJECTED,
    "adapter.web_unsupported",
  );
}

/** The web access of a handoff (`web`, `webFetch`); older handoffs without `webFetch` mean fetch. */
export function webAccessOf(h: { web?: boolean; webFetch?: boolean }): WebAccess | undefined {
  if (h.web !== true) return undefined;
  return h.webFetch === false ? "search" : "fetch";
}

/** `{ web }` for `executeTask`'s options from a handoff (or nothing), ready to spread. */
export function withWeb(h: { web?: boolean; webFetch?: boolean } | null | undefined): {
  web?: WebAccess;
} {
  const web = h ? webAccessOf(h) : undefined;
  return web === undefined ? {} : { web };
}
