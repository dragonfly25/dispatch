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
