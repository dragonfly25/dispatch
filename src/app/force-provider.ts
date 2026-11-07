/**
 * `dispatch run --provider <instance>`: a flag-level routing rule, not a bypass of the router.
 *
 * The flag becomes a pin (`flag:provider`) in front of the other pins, so it wins over profile
 * rules and direct mappings. The router still applies everything it applies to any target: the
 * host itself is excluded (a task pinned to the host's own instance stays on the host), a
 * quota hard limit or an autonomy ceiling filters it out, and the pins that keep paths on the
 * host are still enforced again on the patch. The flag can only select among the instances the
 * configuration enables (tighten-only): it can never switch one on.
 */
import type { EffectiveConfig } from "../config/index.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Id of the pin that `--provider` adds; it shows up in `explain` as `pin flag:provider`. */
export const PROVIDER_FLAG_PIN_ID = "flag:provider";

/**
 * Returns `config` with a pin that delegates every task to `instance`.
 *
 * @throws DispatchError (exit 2) when `instance` is unknown or disabled.
 */
export function forceProvider(config: EffectiveConfig, instance: string): EffectiveConfig {
  const known = config.execution.instances;
  const found = known.find((i) => i.id === instance);
  if (!found) {
    const ids = known.map((i) => i.id).join(", ");
    throw new DispatchError(
      `unknown provider instance "${instance}" for --provider (known: ${ids})`,
      ExitCode.USAGE,
      "cli.usage",
    );
  }
  if (!found.enabled) {
    throw new DispatchError(
      `provider instance "${instance}" is disabled; --provider cannot select it (enable it in the global config)`,
      ExitCode.USAGE,
      "cli.usage",
    );
  }
  return {
    ...config,
    routing: {
      ...config.routing,
      pins: [
        {
          id: PROVIDER_FLAG_PIN_ID,
          description: `--provider ${instance}`,
          match: {},
          action: { type: "provider", instance },
        },
        ...config.routing.pins,
      ],
    },
  };
}
