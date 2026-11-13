/**
 * Capability hint for the router (MCP forwarding): a task that needs MCP servers may only go to
 * an instance whose adapter can host all of them. The routing contract is frozen, so the hint is
 * applied to the effective config before `decide`: incapable instances are disabled, which the
 * decision's filter trace shows as "disabled" and `explain --replay` reproduces from the stored
 * input. Pure.
 */
import type { RoutingConfig } from "../core/routing.js";

/** Result of {@link restrictToCapable}. */
export interface CapabilityRestriction {
  routing: RoutingConfig;
  /** Enabled instances that were disabled because their adapter lacks the capability. */
  excluded: string[];
  /** Enabled instances that remain. */
  remaining: string[];
}

/** Disables every enabled instance whose adapter fails `capable`. */
export function restrictToCapable(
  routing: RoutingConfig,
  capable: (adapterId: string) => boolean,
): CapabilityRestriction {
  const excluded: string[] = [];
  const remaining: string[] = [];
  const instances = routing.instances.map((i) => {
    if (!i.enabled) return i;
    if (capable(i.adapter)) {
      remaining.push(i.id);
      return i;
    }
    excluded.push(i.id);
    return { ...i, enabled: false };
  });
  return { routing: { ...routing, instances }, excluded, remaining };
}

/** An instance taken out of routing, with the reason shown to the user. */
export interface InstanceExclusion {
  id: string;
  reason: string;
}

/** Result of {@link excludeUnavailable}. */
export interface UnavailableRestriction {
  routing: RoutingConfig;
  /** Enabled instances that were disabled, in config order, each with its reason. */
  excluded: InstanceExclusion[];
}

/**
 * Disables every enabled instance for which `reasonOf` returns a reason (e.g. an adapter that
 * cannot run on this OS). Like {@link restrictToCapable}, the routing contract is unchanged: the
 * filter trace shows "disabled", and the caller reports `excluded` with its reasons.
 */
export function excludeUnavailable(
  routing: RoutingConfig,
  reasonOf: (instance: RoutingConfig["instances"][number]) => string | null,
): UnavailableRestriction {
  const excluded: InstanceExclusion[] = [];
  const instances = routing.instances.map((i) => {
    if (!i.enabled) return i;
    const reason = reasonOf(i);
    if (reason === null) return i;
    excluded.push({ id: i.id, reason });
    return { ...i, enabled: false };
  });
  return { routing: excluded.length ? { ...routing, instances } : routing, excluded };
}

/** One-line text of `excluded` for a run or explain reason (empty string when none). */
export function describeExclusions(excluded: readonly InstanceExclusion[]): string {
  return excluded.map((e) => `${e.id}: ${e.reason}`).join("; ");
}
