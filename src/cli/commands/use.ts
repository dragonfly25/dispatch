/** `dispatch use <profile>`: switches the active routing profile (UC5, spec §7). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parseDocument } from "yaml";
import type { AppContext } from "../../app/context.js";
import { findRepo, globalConfigPath, repoPaths, trustRepo } from "../../config/index.js";
import { writeAtomic } from "../../config/trust.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { type CliDeps, printJson, withContext } from "./shared.js";

/** What `use` did. */
export interface UseResult {
  profile: string;
  previous: string;
  scope: "repo" | "global";
  file: string;
  /** True when the repo policy was re-trusted after editing it. */
  retrusted: boolean;
}

/** Sets `profile:` in a YAML config file, keeping every comment. Missing file = `version: 1`. */
function setProfileKey(file: string, name: string): string {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "version: 1\n");
  if (doc.errors.length > 0) {
    throw new DispatchError(`${file}: ${doc.errors[0]?.message}`, ExitCode.USAGE, "config.invalid");
  }
  doc.set("profile", name);
  return doc.toString();
}

/**
 * Makes `name` the active profile. When the trusted repo policy sets `profile`, that file is
 * edited (it would override the global one) and the repo is re-trusted, since the user is the
 * actor. Otherwise the global config's `profile` is written.
 */
export function useProfile(ctx: AppContext, name: string): UseResult {
  const { routing, provenance, trusted } = ctx.config;
  if (!(name in routing.profiles)) {
    throw new DispatchError(
      `unknown profile "${name}" (known: ${Object.keys(routing.profiles).sort().join(", ")})`,
      ExitCode.USAGE,
      "cli.usage",
    );
  }
  const repo = trusted && provenance.profile === "repo" ? findRepo(ctx.cwd) : null;
  const previous = routing.activeProfile;
  if (repo) {
    const file = repoPaths(repo.worktreeRoot).config;
    writeFileSync(file, setProfileKey(file, name));
    trustRepo({ cwd: ctx.cwd, env: ctx.env, now: ctx.clock.now() });
    return { profile: name, previous, scope: "repo", file, retrusted: true };
  }
  const file = globalConfigPath(ctx.env);
  writeAtomic(file, setProfileKey(file, name));
  return { profile: name, previous, scope: "global", file, retrusted: false };
}

/** Registers `use`. */
export function registerUse(program: Command, deps: CliDeps): void {
  program
    .command("use")
    .description("switch the active routing profile")
    .argument("<profile>", "profile name (see `dispatch profiles`)")
    .option("--json", "machine-readable output")
    .action(async (name: string, opts: { json?: boolean }) => {
      await withContext(deps, (ctx) => {
        const r = useProfile(ctx, name);
        if (opts.json) printJson(deps.io, r);
        else {
          deps.io.out(
            `Active profile: ${r.previous} -> ${r.profile} (${r.scope} config ${r.file})\n${
              r.retrusted ? "Repo policy re-trusted.\n" : ""
            }`,
          );
        }
      });
    });
}
