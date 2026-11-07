/**
 * Run-time side of web access: a run that needs web access (a handoff of an agent that declares
 * `WebSearch` / `WebFetch`) may only go to an instance whose adapter can give it. Pure.
 */
import type { RoutingConfig } from "../core/routing.js";
import { restrictToCapable } from "../router/capability.js";
import { adapterCanBrowse, type WebAccess, webCapableAdapters } from "../web/index.js";

/** What {@link planWeb} decided. */
export type WebPlan =
  | { ok: true; web: WebAccess | undefined; routing: RoutingConfig; excluded: string[] }
  | { ok: false; reason: string };

/** Inputs of {@link planWeb}. */
export interface WebPlanInput {
  /** Requested web access; absent means none (the plan is a no-op). */
  wanted: WebAccess | undefined;
  /** `hosts.claude-code.forward_web` after tighten-only merging. */
  forwardWeb: boolean;
  routing: RoutingConfig;
}

/**
 * Restricts routing to instances that can give the requested web access. Fails (task back to the
 * host) when web forwarding is off or no enabled instance can give it.
 */
export function planWeb(input: WebPlanInput): WebPlan {
  if (input.wanted === undefined) {
    return { ok: true, web: undefined, routing: input.routing, excluded: [] };
  }
  if (!input.forwardWeb) {
    return {
      ok: false,
      reason:
        "the agent needs web access (WebSearch/WebFetch), and web forwarding is off (hosts.claude-code.forward_web)",
    };
  }
  const wanted = input.wanted;
  const r = restrictToCapable(input.routing, (a) => adapterCanBrowse(a, wanted));
  if (r.remaining.length === 0) {
    return {
      ok: false,
      reason: `no enabled provider can give the agent web access (only ${webCapableAdapters().join(" and ")} can)`,
    };
  }
  return { ok: true, web: wanted, routing: r.routing, excluded: r.excluded };
}
