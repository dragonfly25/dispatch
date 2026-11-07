/**
 * Per-repo install and uninstall (plan §2 "Host integration", spec §10, UC1, UC14, AC2).
 *
 * `install` creates ONLY `.dispatch/` (config, shipped profiles and mappings, a `.gitignore` for
 * `state/`); the repo's own `.gitignore` and every other file stay untouched. What it created is
 * recorded outside the repo, in `~/.dispatch/state/repo-installs.json`, keyed by the repo
 * identity (realpath of the git common dir), so `uninstall` can restore the exact tree.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  assetsDir,
  globalConfigPath,
  MAPPINGS_DIR,
  type PathEnv,
  PROFILES_DIR,
  REPO_DIR,
} from "../config/paths.js";
import { findRepo, type RepoLocation, trustRepo } from "../config/trust.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { renderRepoConfig } from "./config-template.js";
import { readInstalls, removeTrustEntry, writeInstalls } from "./manifest.js";

/** `.dispatch/.gitignore`: keeps runtime state out of git without touching the root .gitignore. */
export const STATE_GITIGNORE = "state/\n";
/** Runtime artifacts directory inside `.dispatch/`; removed wholesale on uninstall. */
export const STATE_DIR = "state";

/** Asks a yes/no question; absent = proceed without asking (`--yes`, `--non-interactive`). */
export type Confirm = (question: string) => Promise<boolean>;

/** Output sink. */
export type Say = (line: string) => void;

/** One file `install` creates. */
export interface PlannedFile {
  /** Path relative to the worktree root, posix style (e.g. ".dispatch/profiles/balance.yaml"). */
  path: string;
  content: Buffer;
}

/** Options of {@link installRepo}. */
export interface InstallOptions {
  cwd: string;
  env: PathEnv;
  now: Date;
  say: Say;
  /** Validated profile name to activate in the config; absent keeps the commented default. */
  profile?: string;
  unspecifiedModel?: string;
  /** Proceed into an existing `.dispatch/`, creating only the files that are missing. */
  force?: boolean;
  /** Record the policy in `trusted_repos` (default true). */
  trust?: boolean;
  /** Trust even when `~/.dispatch/config.yaml` does not exist yet (setup just ran). */
  allowNewGlobalConfig?: boolean;
  confirm?: Confirm;
  /** Test seam: assets directory. */
  assetsDir?: string;
}

/** Outcome of {@link installRepo}. */
export interface InstallResult {
  status: "installed" | "aborted";
  created: string[];
  /** Existing files left alone under `--force`. */
  kept: string[];
  trusted: boolean;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Names (without `.yaml`) of the profiles shipped in `assets/profiles`, sorted. */
export function shippedProfiles(dir: string = assetsDir()): string[] {
  return readdirSync(join(dir, PROFILES_DIR))
    .filter((n) => n.endsWith(".yaml"))
    .map((n) => n.slice(0, -".yaml".length))
    .sort();
}

/** The files `install` writes: config, byte copies of the shipped profiles and mappings, .gitignore. */
export function planFiles(
  choices: { profile?: string; unspecifiedModel?: string },
  dir: string = assetsDir(),
): PlannedFile[] {
  const files: PlannedFile[] = [
    { path: `${REPO_DIR}/.gitignore`, content: Buffer.from(STATE_GITIGNORE) },
    { path: `${REPO_DIR}/config.yaml`, content: Buffer.from(renderRepoConfig(choices)) },
  ];
  for (const sub of [PROFILES_DIR, MAPPINGS_DIR]) {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      if (!name.endsWith(".yaml")) continue;
      files.push({
        path: `${REPO_DIR}/${sub}/${name}`,
        content: readFileSync(join(dir, sub, name)),
      });
    }
  }
  return files;
}

const usage = (message: string, code: string): DispatchError =>
  new DispatchError(message, ExitCode.USAGE, code);

/** The checkout around `cwd`; exit 2 when there is none. */
export function requireRepo(cwd: string): RepoLocation {
  const repo = findRepo(cwd);
  if (!repo) {
    throw usage("not inside a git repository: run this from a repo checkout", "repo.not_a_repo");
  }
  return repo;
}

/** `dispatch install` for the repo around `opts.cwd`. */
export async function installRepo(opts: InstallOptions): Promise<InstallResult> {
  const repo = requireRepo(opts.cwd);
  const root = repo.worktreeRoot;
  const assets = opts.assetsDir ?? assetsDir();
  if (opts.profile !== undefined && !shippedProfiles(assets).includes(opts.profile)) {
    throw usage(
      `unknown profile "${opts.profile}" (shipped: ${shippedProfiles(assets).join(", ")})`,
      "install.bad_profile",
    );
  }
  const dotDir = join(root, REPO_DIR);
  if (lstatOrNull(dotDir) && !opts.force) {
    throw usage(
      `${REPO_DIR}/ already exists; refusing to overwrite it (use --force to add only the missing files, or \`dispatch uninstall\` first)`,
      "install.exists",
    );
  }

  const planned = planFiles(opts, assets);
  const toCreate = planned.filter((f) => !lstatOrNull(join(root, f.path)));
  const kept = planned.filter((f) => lstatOrNull(join(root, f.path))).map((f) => f.path);

  opts.say(`Dispatch will create ${toCreate.length} file(s) in ${root}:\n`);
  for (const f of toCreate) opts.say(`  + ${f.path}\n`);
  for (const k of kept) opts.say(`  = ${k} (exists, left unchanged)\n`);
  opts.say("Nothing else in the repository is touched (not even the root .gitignore).\n");
  if (opts.confirm && !(await opts.confirm("Create these files?"))) {
    opts.say("Aborted; nothing was changed.\n");
    return { status: "aborted", created: [], kept: [], trusted: false };
  }

  const dirs = missingDirs(root, toCreate);
  const written: string[] = [];
  try {
    for (const f of toCreate) {
      const abs = join(root, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content, { flag: "wx" });
      written.push(f.path);
    }
    recordInstall(opts, repo.id, root, toCreate, dirs);
  } catch (err) {
    for (const p of written) rmSync(join(root, p), { force: true });
    removeEmptyDirs(root, dirs);
    throw err;
  }

  let trusted = false;
  if (opts.trust !== false) {
    if (opts.allowNewGlobalConfig || existsSync(globalConfigPath(opts.env))) {
      trustRepo({ cwd: root, env: opts.env, now: opts.now });
      trusted = true;
    } else {
      opts.say(
        "No ~/.dispatch/config.yaml yet: skipping trust (run `dispatch setup`, then `dispatch trust`).\n",
      );
    }
  }
  return { status: "installed", created: toCreate.map((f) => f.path), kept, trusted };
}

/** Directories (relative, shallow to deep) that do not exist yet and will be created by `files`. */
function missingDirs(root: string, files: PlannedFile[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let d = dirname(f.path);
    while (d !== "." && !lstatOrNull(join(root, d))) {
      dirs.add(d);
      d = dirname(d);
    }
  }
  return [...dirs].sort((a, b) => a.length - b.length);
}

/** Adds this install to the manifest (merging with an earlier `--force` install of the same repo). */
function recordInstall(
  opts: InstallOptions,
  id: string,
  root: string,
  files: PlannedFile[],
  dirs: string[],
): void {
  const all = readInstalls(opts.env);
  const prev = all.repos[id];
  const merged = new Map((prev?.files ?? []).map((f) => [f.path, f.sha256]));
  for (const f of files) merged.set(f.path, sha256(f.content));
  all.repos[id] = {
    worktreeRoot: root,
    installedAt: prev?.installedAt ?? opts.now.toISOString(),
    files: [...merged].map(([path, hash]) => ({ path, sha256: hash })),
    dirs: [...new Set([...(prev?.dirs ?? []), ...dirs])],
  };
  writeInstalls(opts.env, all);
}

/** Removes `dirs` (relative) that are empty, deepest first; non-empty ones are left alone. */
function removeEmptyDirs(root: string, dirs: string[]): string[] {
  const left: string[] = [];
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(root, d);
    try {
      if (readdirSync(abs).length === 0) rmdirSync(abs);
      else left.push(d);
    } catch {
      // already gone
    }
  }
  return left;
}

/** Options of {@link uninstallRepo}. */
export interface UninstallOptions {
  cwd: string;
  env: PathEnv;
  say: Say;
  /** Remove files whose content changed since install, without asking. */
  force?: boolean;
  confirm?: Confirm;
}

/** Outcome of {@link uninstallRepo}. */
export interface UninstallResult {
  status: "removed" | "nothing" | "aborted";
  removed: string[];
  /** Edited files left in place. */
  kept: string[];
}

/** `dispatch uninstall` (repo part) for the repo around `opts.cwd`. */
export async function uninstallRepo(opts: UninstallOptions): Promise<UninstallResult> {
  const repo = requireRepo(opts.cwd);
  const entry = readInstalls(opts.env).repos[repo.id];
  if (!entry) {
    opts.say("Dispatch did not install anything in this repository; nothing to remove.\n");
    return { status: "nothing", removed: [], kept: [] };
  }
  const root = repo.worktreeRoot;
  const state = join(root, REPO_DIR, STATE_DIR);

  const present = entry.files.filter((f) => lstatOrNull(join(root, f.path)));
  const edited = present.filter((f) => !isUnchanged(join(root, f.path), f.sha256));
  opts.say(`Dispatch will remove from ${root}:\n`);
  for (const f of present) {
    opts.say(`  - ${f.path}${edited.includes(f) ? " (edited since install)" : ""}\n`);
  }
  if (lstatOrNull(state)) opts.say(`  - ${REPO_DIR}/${STATE_DIR}/ (runtime state)\n`);
  opts.say("and the trust entry of this repository in ~/.dispatch/config.yaml.\n");
  if (opts.confirm && !(await opts.confirm("Remove them?"))) {
    opts.say("Aborted; nothing was changed.\n");
    return { status: "aborted", removed: [], kept: [] };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const f of present) {
    const isEdited = edited.includes(f);
    const ok =
      !isEdited ||
      opts.force === true ||
      (opts.confirm !== undefined &&
        (await opts.confirm(`${f.path} was edited. Remove it anyway?`)));
    if (ok) {
      unlinkSync(join(root, f.path));
      removed.push(f.path);
    } else {
      kept.push(f.path);
      opts.say(`warning: kept ${f.path}: it was edited since install (use --force to remove it)\n`);
    }
  }
  rmSync(state, { recursive: true, force: true });
  const leftDirs = removeEmptyDirs(root, entry.dirs);
  for (const d of leftDirs) {
    if (kept.length === 0)
      opts.say(`warning: kept ${d}/: it contains files Dispatch did not create\n`);
  }

  removeTrustEntry(opts.env, repo.id);
  const all = readInstalls(opts.env);
  delete all.repos[repo.id];
  writeInstalls(opts.env, all);
  opts.say(`Removed ${removed.length} file(s).\n`);
  return { status: "removed", removed, kept };
}

/** True when `path` is a regular file whose content hash is `hash`. */
function isUnchanged(path: string, hash: string): boolean {
  const st = lstatOrNull(path);
  return st?.isFile() === true && sha256(readFileSync(path)) === hash;
}
