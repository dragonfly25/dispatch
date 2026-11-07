/**
 * Run-time side of the isolated browser: a run for an agent that uses the Claude desktop browser
 * tools may only go to an instance that can host the Dispatch-owned Playwright server (codex), and
 * only when the browser is ready and the run gets the sandbox network (dev servers listen on
 * localhost from the agent's shell). Otherwise the task returns to the host with the reason.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterCanBrowser,
  allowedOrigins,
  type BrowserRun,
  type Readiness,
} from "../browser/index.js";
import { launchPorts, readLaunchConfigs } from "../browser/note.js";
import type { Autonomy } from "../core/contracts.js";
import type { RoutingConfig } from "../core/routing.js";
import { restrictToCapable } from "../router/capability.js";
import type { NetworkDecision } from "../sandbox/network.js";

/** What {@link planBrowser} decided. */
export type BrowserPlan =
  | { ok: true; browser: BrowserRun | undefined; routing: RoutingConfig; excluded: string[] }
  | { ok: false; reason: string };

/** Inputs of {@link planBrowser}. */
export interface BrowserPlanInput {
  /** The run is for a browser agent (handoff `browser: true`). */
  wanted: boolean;
  readiness: Readiness;
  network: NetworkDecision;
  autonomy: Autonomy;
  routing: RoutingConfig;
  /** Absolute node that runs the server. */
  nodePath: string;
  /** Repo root, for the dev-server ports of `.claude/launch.json` (the origin allowlist). */
  repoRoot: string;
  /** Reads a file (tests inject one); default: the real filesystem. */
  read?: (path: string) => string | null;
}

/** Restricts routing to browser-capable instances, or hands the task back with the reason. */
export function planBrowser(input: BrowserPlanInput): BrowserPlan {
  if (!input.wanted) {
    return { ok: true, browser: undefined, routing: input.routing, excluded: [] };
  }
  const why = (reason: string): BrowserPlan => ({
    ok: false,
    reason: `the agent uses the Claude desktop browser tools, and ${reason}`,
  });
  if (!input.readiness.ready) return why(input.readiness.reason);
  if (!input.network.enabled) {
    return why(
      `it needs the sandbox network (set network: delegated-agents; ${input.network.reason})`,
    );
  }
  if (input.autonomy === "read-only") return why("read-only runs have no shell for dev servers");
  const r = restrictToCapable(input.routing, adapterCanBrowser);
  if (r.remaining.length === 0) {
    return why("no enabled provider can host the isolated browser (only codex can)");
  }
  const ports = launchPorts(readLaunchConfigs(input.repoRoot, input.read));
  return {
    ok: true,
    browser: {
      nodePath: input.nodePath,
      cliPath: input.readiness.cliPath,
      origins: allowedOrigins(ports),
    },
    routing: r.routing,
    excluded: r.excluded,
  };
}

/** Per-attempt directories of the browser server, inside the attempt dir (never the worktree). */
export function browserDirs(attemptDir: string): { out: string; home: string } {
  return { out: join(attemptDir, "browser"), home: join(attemptDir, "browser-home") };
}

/** Creates {@link browserDirs} (0700): codex needs the server's cwd to exist. */
export async function prepareBrowserDirs(attemptDir: string): Promise<void> {
  const d = browserDirs(attemptDir);
  await mkdir(d.out, { recursive: true, mode: 0o700 });
  await mkdir(d.home, { recursive: true, mode: 0o700 });
}
