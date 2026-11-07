/**
 * Install manifest and trust-entry removal. The manifest lives outside the repo, in
 * `~/.dispatch/state/repo-installs.json`, so the repo stays clean (AC2).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";
import { dispatchHome, globalConfigPath, type PathEnv } from "../config/paths.js";
import { writeAtomic } from "../config/trust.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

const RepoInstallSchema = z
  .object({
    worktreeRoot: z.string(),
    installedAt: z.string(),
    /** Files Dispatch created, with the hash they had when written. */
    files: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
    /** Directories Dispatch created (relative), so uninstall removes only those. */
    dirs: z.array(z.string()),
  })
  .strict();

const InstallsSchema = z
  .object({ version: z.literal(1), repos: z.record(z.string(), RepoInstallSchema) })
  .strict();

/** What Dispatch created in one repo. */
export type RepoInstall = z.infer<typeof RepoInstallSchema>;
/** Contents of `repo-installs.json`, keyed by realpath of the git common dir. */
export type Installs = z.infer<typeof InstallsSchema>;

/** Path of the manifest. */
export function installsPath(env: PathEnv): string {
  return join(dispatchHome(env), "state", "repo-installs.json");
}

/** Reads the manifest; a missing file is empty, a corrupt one is an error (never guessed at). */
export function readInstalls(env: PathEnv): Installs {
  const path = installsPath(env);
  if (!existsSync(path)) return { version: 1, repos: {} };
  try {
    return InstallsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new DispatchError(
      `${path} is unreadable (${err instanceof Error ? err.message : String(err)}); fix or delete it`,
      ExitCode.USAGE,
      "install.manifest",
      { cause: err },
    );
  }
}

/** Writes the manifest atomically; an empty one deletes the file. */
export function writeInstalls(env: PathEnv, installs: Installs): void {
  const path = installsPath(env);
  if (Object.keys(installs.repos).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeAtomic(path, `${JSON.stringify(installs, null, 2)}\n`);
}

/** Removes `trusted_repos[repoId]` from the global config, keeping its comments. */
export function removeTrustEntry(env: PathEnv, repoId: string): boolean {
  const path = globalConfigPath(env);
  if (!existsSync(path)) return false;
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0 || !doc.hasIn(["trusted_repos", repoId])) return false;
  doc.deleteIn(["trusted_repos", repoId]);
  const trusted = doc.get("trusted_repos");
  if (isMap(trusted) && trusted.items.length === 0) doc.delete("trusted_repos");
  writeAtomic(path, doc.toString());
  return true;
}
