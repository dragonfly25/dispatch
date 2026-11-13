/**
 * Quota-free detection of the provider CLIs for the setup wizard. It reuses the adapters' own
 * probes (`--version`, `--help`, `codex login status`), which spend no quota; claude has no
 * quota-free login check, so its login stays unknown. Antigravity is only ever probed when the
 * caller asks for it by id, i.e. after the user opted in.
 */
import { createAdapter } from "../app/adapters.js";
import { systemClock } from "../core/clock.js";
import type { Spawner } from "../core/contracts.js";
import { resolveBinary } from "../platform/resolve.js";
import { ProcessSpawner } from "../runner/proc.js";

/** What the wizard learns about one CLI. */
export interface DetectedCli {
  /** Provider instance id (claude | codex | antigravity). */
  id: string;
  installed: boolean;
  version: string | null;
  /** null = cannot tell without spending quota. */
  loggedIn: boolean | null;
}

/** Probes the CLIs of `ids`, in order. Never throws. */
export type Detector = (ids: readonly string[]) => Promise<DetectedCli[]>;

/** The production detector over `env` (PATH and friends) and a spawner (a real one by default). */
export function createDetector(
  env: Readonly<Record<string, string | undefined>>,
  spawner: Spawner = new ProcessSpawner(),
  /** Test seam: where a binary lives; default PATH and the well-known directories. */
  find: (name: string) => string | null = (name) =>
    resolveBinary(name, { env, platform: process.platform })?.path ?? null,
): Detector {
  return async (ids) => {
    const out: DetectedCli[] = [];
    for (const id of ids) {
      const missing: DetectedCli = { id, installed: false, version: null, loggedIn: null };
      const adapter = createAdapter(id);
      if (!adapter) {
        out.push(missing);
        continue;
      }
      try {
        const probe = await adapter.probe(
          { id, adapter: id, pool: "subscription" },
          {
            spawner,
            clock: systemClock,
            resolveBinary: async (name) => find(name),
          },
        );
        out.push({
          id,
          installed: probe.binaryPath !== null,
          version: probe.version,
          loggedIn: probe.loggedIn,
        });
      } catch {
        out.push(missing);
      }
    }
    return out;
  };
}
