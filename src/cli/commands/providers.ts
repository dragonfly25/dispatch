/** `dispatch providers`: the configured provider instances and what their adapters support. */
import type { Command } from "commander";
import { adapterCapabilities } from "../../app/adapters.js";
import type { AppContext } from "../../app/context.js";
import type { Autonomy, Pool } from "../../core/contracts.js";
import { type CliDeps, printJson, withContext } from "./shared.js";

// TODO(WP19/WP26): `providers --probe` runs adapter.probe through the production spawner
// (src/runner/proc.ts is not on main yet).

/** One provider instance as listed. */
export interface ProviderRow {
  id: string;
  adapter: string;
  enabled: boolean;
  pool: Pool;
  plan: string | null;
  configDir: string | null;
  maxAutonomy: Autonomy;
  /** True for the instance of the calling host (never a delegation target). */
  host: boolean;
  /** Whether Dispatch ships this adapter. */
  known: boolean;
  experimental: boolean | null;
  adapterVersion: string | null;
  cliRange: string | null;
}

/** Provider rows in configuration order. */
export function listProviders(ctx: AppContext): ProviderRow[] {
  return ctx.config.execution.instances.map((i) => {
    const caps = adapterCapabilities(i.adapter);
    return {
      id: i.id,
      adapter: i.adapter,
      enabled: i.enabled,
      pool: i.pool,
      plan: i.plan ?? null,
      configDir: i.configDir ?? null,
      maxAutonomy: i.maxAutonomy,
      host: ctx.host.self === i.id,
      known: caps !== null,
      experimental: caps?.experimental ?? null,
      adapterVersion: caps?.version ?? null,
      cliRange: caps?.cliRange ?? null,
    };
  });
}

/** Registers `providers`. */
export function registerProviders(program: Command, deps: CliDeps): void {
  program
    .command("providers")
    .description("list the configured provider instances")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await withContext(deps, (ctx) => {
        const rows = listProviders(ctx);
        if (opts.json) {
          printJson(deps.io, { host: ctx.host.self, providers: rows });
          return;
        }
        for (const r of rows) {
          const tags = [
            r.enabled ? "enabled" : "disabled",
            r.pool,
            ...(r.experimental ? ["experimental"] : []),
            ...(r.host ? ["host"] : []),
            ...(r.known ? [] : ["unknown adapter"]),
          ];
          deps.io.out(
            `${r.id}  adapter ${r.adapter}${r.adapterVersion ? ` ${r.adapterVersion}` : ""}${
              r.cliRange ? ` (cli ${r.cliRange})` : ""
            }  ${tags.join(", ")}${r.configDir ? `  config_dir ${r.configDir}` : ""}\n`,
          );
        }
      });
    });
}
