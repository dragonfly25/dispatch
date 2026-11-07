/**
 * Process lifecycle helpers of the orchestrator: termination-signal handling and the per-process
 * probe cache.
 */
import type { Adapter, AdapterDeps, ProbeResult, ProviderInstance } from "../core/contracts.js";

/** The slice of `process` used for signal handling (injectable for tests). */
export interface SignalTarget {
  readonly pid: number;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  kill(pid: number, signal: string): unknown;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Calls `onSignal` on SIGINT/SIGTERM while installed. The returned function uninstalls the
 * handlers and, when a signal arrived, re-raises it so the process still dies from it (after the
 * caller's cleanup: the child group is killed by the spawner via the abort, the lease released and
 * the worktree disposed in the attempt's `finally`).
 */
export function trapTermination(
  target: SignalTarget,
  onSignal: (signal: string) => void,
): () => void {
  let received: string | null = null;
  const listeners = SIGNALS.map((sig) => {
    const fn = () => {
      received ??= sig;
      onSignal(sig);
    };
    target.on(sig, fn);
    return [sig, fn] as const;
  });
  return () => {
    for (const [sig, fn] of listeners) target.off(sig, fn);
    if (received) target.kill(target.pid, received);
  };
}

/**
 * Probe results per adapter and instance, cached for the life of the process. A failed probe is
 * not cached. `set` seeds a result (tests, or a composition root that probed already).
 */
export class ProbeCache {
  readonly #cache = new Map<string, Promise<ProbeResult>>();

  #key(adapterId: string, instanceId: string): string {
    return `${adapterId}\u0000${instanceId}`;
  }

  get(adapter: Adapter, instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult> {
    const key = this.#key(adapter.caps.id, instance.id);
    let hit = this.#cache.get(key);
    if (!hit) {
      hit = adapter.probe(instance, deps);
      this.#cache.set(key, hit);
      hit.catch(() => this.#cache.delete(key));
    }
    return hit;
  }

  set(adapterId: string, instanceId: string, result: ProbeResult): void {
    this.#cache.set(this.#key(adapterId, instanceId), Promise.resolve(result));
  }
}

/** The process-wide cache used when the deps do not bring their own. */
export const processProbeCache = new ProbeCache();
