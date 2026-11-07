/** `dispatch profiles`: lists the routing profiles, the active one and where each is defined. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { AppContext } from "../../app/context.js";
import { findRepo, repoPaths } from "../../config/index.js";
import { type CliDeps, printJson, withContext } from "./shared.js";

/** One profile as listed. */
export interface ProfileRow {
  name: string;
  active: boolean;
  source: "default" | "global" | "repo";
  /** The YAML file the profile comes from. */
  file: string;
  description: string | null;
  rules: number;
}

/** Profile rows, sorted by name. Later layers win: trusted repo > global home > built-in assets. */
export function listProfiles(ctx: AppContext): ProfileRow[] {
  const { routing, trusted } = ctx.config;
  const repo = trusted ? findRepo(ctx.cwd) : null;
  const layers: { source: ProfileRow["source"]; dir: string }[] = [
    ...(repo ? [{ source: "repo" as const, dir: repoPaths(repo.worktreeRoot).profiles }] : []),
    { source: "global", dir: join(ctx.dispatchHome, "profiles") },
    { source: "default", dir: join(ctx.assetsDir, "profiles") },
  ];
  return Object.entries(routing.profiles)
    .map(([name, profile]) => {
      const hit = layers.find((l) => existsSync(join(l.dir, `${name}.yaml`)));
      return {
        name,
        active: name === routing.activeProfile,
        source: hit?.source ?? "default",
        file: join(hit?.dir ?? "", `${name}.yaml`),
        description: profile.description ?? null,
        rules: profile.rules.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Registers `profiles`. */
export function registerProfiles(program: Command, deps: CliDeps): void {
  program
    .command("profiles")
    .description("list the routing profiles and mark the active one")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await withContext(deps, (ctx) => {
        const rows = listProfiles(ctx);
        if (opts.json) {
          printJson(deps.io, { active: ctx.config.routing.activeProfile, profiles: rows });
          return;
        }
        const width = Math.max(...rows.map((r) => r.name.length));
        for (const r of rows) {
          deps.io.out(
            `${r.active ? "*" : " "} ${r.name.padEnd(width)}  ${r.source.padEnd(7)}  ${r.rules} rule(s)  ${r.file}\n`,
          );
          if (r.description) deps.io.out(`    ${r.description}\n`);
        }
      });
    });
}
