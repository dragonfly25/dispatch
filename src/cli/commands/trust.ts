/** `dispatch trust`: records the repo's `.dispatch/` policy as trusted (SEC-trust). */
import type { Command } from "commander";
import { trustRepo } from "../../config/index.js";
import { systemClock } from "../../core/clock.js";
import { type CliDeps, printJson, refreshCache } from "./shared.js";

/** Registers `trust`. Prints the repo identity, the policy hash and every file covered. */
export function registerTrust(program: Command, deps: CliDeps): void {
  program
    .command("trust")
    .description("trust the .dispatch/ policy files of this repository (records their hash)")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const { id, entry } = trustRepo({
        cwd: deps.cwd,
        env: deps.env,
        now: (deps.clock ?? systemClock).now(),
      });
      refreshCache(deps);
      const files = Object.entries(entry.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, sha256]) => ({ path, sha256 }));
      if (opts.json) {
        printJson(deps.io, { repoId: id, hash: entry.hash, trustedAt: entry.trusted_at, files });
        return;
      }
      deps.io.out(`Trusted ${id}\nhash ${entry.hash}\n`);
      for (const f of files) deps.io.out(`  ${f.sha256.slice(0, 12)}  ${f.path}\n`);
    });
}
