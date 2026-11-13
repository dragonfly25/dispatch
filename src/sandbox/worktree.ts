import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { Sandbox, SandboxCreateOptions, SandboxHandle } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { isWindows, type OsPlatform } from "../platform/os.js";
import {
  commonDir,
  gitRaw,
  hasSubmodules,
  repoRoot,
  usesLfs,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "./git.js";
import { snapshotBase } from "./snapshot.js";

/** Why a sandbox may only be used read-only (no patch can be produced from it). */
export type ReadOnlyReason = "submodules" | "lfs" | "not-git";

/** How dependency directories are made visible inside the worktree. */
export interface BootstrapConfig {
  mode: "none" | "symlink-readonly";
  /** Repo-root-relative paths (e.g. `node_modules`) to expose when mode is `symlink-readonly`. */
  paths: string[];
}

/** Options for {@link WorktreeSandbox.create}; a superset of the port's options. */
export interface WorktreeCreateOptions extends SandboxCreateOptions {
  /** Root of Dispatch state (normally `~/.dispatch`); worktrees go under `<dispatchHome>/worktrees`. */
  dispatchHome: string;
  bootstrap?: BootstrapConfig;
}

/** A created worktree sandbox. */
export interface WorktreeHandle extends SandboxHandle {
  /** Set when the sandbox must only be used read-only. */
  readOnlyReason?: ReadOnlyReason;
  /**
   * Repo-relative paths symlinked in from the original checkout. They are not part of the base;
   * the patch step must exclude them (a `node_modules/` ignore rule does not match a symlink).
   */
  bootstrapped: string[];
}

/** Options for {@link WorktreeSandbox.gc}. */
export interface GcOptions {
  dispatchHome: string;
  /** Whether the run behind a worktree has finished (unknown runs should report true). */
  isTerminal(runId: string): boolean | Promise<boolean>;
  /** Minimum age (by mtime) before a terminal run's worktree is reaped. */
  olderThanMs: number;
  now: number;
  /** Only report what would be removed; touch nothing. */
  dryRun?: boolean;
}

/** Stable 12-hex id for a repository, derived from its common git dir. */
export function repoHash(common: string): string {
  return createHash("sha256").update(common).digest("hex").slice(0, 12);
}

/** Serialises `git worktree add` per repository: concurrent adds contend on git's own locks. */
const addLocks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (addLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  addLocks.set(key, tail);
  void tail.then(() => addLocks.get(key) === tail && addLocks.delete(key));
  return run;
}

/** Reads the common git dir a linked worktree points at, or null if `path` is not one. */
function linkedCommonDir(path: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"));
    // <common>/worktrees/<name>
    return m?.[1] ? dirname(dirname(m[1].trim())) : null;
  } catch {
    return null;
  }
}

/**
 * The `node:fs/promises` calls the sandbox makes on worktree contents (a test seam). On Windows
 * `lstat` reports junctions as symbolic links (libuv maps mount-point reparse points to S_IFLNK).
 */
export interface SandboxFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  stat(path: string): Promise<{ isDirectory(): boolean; mtimeMs: number }>;
  symlink(target: string, path: string, type?: "dir" | "file" | "junction"): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>;
}

const nodeSandboxFs: SandboxFs = {
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  symlink: (t, p, type) => fsp.symlink(t, p, type),
  mkdir: (p, o) => fsp.mkdir(p, o),
  readdir: (p) => fsp.readdir(p),
  unlink: (p) => fsp.unlink(p),
  rmdir: (p) => fsp.rmdir(p),
  rm: (p, o) => fsp.rm(p, o),
};

/** Options of {@link WorktreeSandbox}'s constructor (test seams). */
export interface WorktreeSandboxOptions {
  /** Platform whose link rules apply (default `process.platform`). */
  platform?: OsPlatform;
  fs?: SandboxFs;
}

/**
 * The link type for a bootstrap entry. POSIX: a plain symlink. Windows: a directory becomes a
 * junction (no administrator right or Developer Mode needed). A file cannot be linked on Windows
 * without the symlink privilege, and a hard link or copy would not be a read-only view of the
 * original (a hard link writes through, a copy can be large or hold secrets), so it is refused.
 */
export function bootstrapLinkType(
  rel: string,
  isDir: boolean,
  platform: OsPlatform = process.platform,
): "junction" | undefined {
  if (!isWindows(platform)) return undefined;
  if (isDir) return "junction";
  throw new DispatchError(
    `bootstrap path ${rel} is a file: on Windows only directories can be linked (as junctions); ` +
      "remove it from worktree.symlink_paths",
    undefined,
    "sandbox.bootstrap_file",
  );
}

/**
 * Removes every symbolic link and junction below `dir` (the link only, never its target) without
 * descending into one. Run on Windows before `git worktree remove` or `rm -r`: Git for Windows
 * treats a junction as a directory and would delete the content it points at (for bootstrapped
 * `node_modules`, the user's own checkout; for a junction the agent made, anything). Throws when a
 * link cannot be removed, so the caller does not go on to a recursive delete.
 */
export async function unlinkLinksBelow(dir: string, fs: SandboxFs = nodeSandboxFs): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const p = join(dir, name);
    const st = await fs.lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      // A directory junction or symlink: unlink removes the reparse point itself; rmdir is the
      // fallback for a directory symlink where unlink is refused.
      await fs.unlink(p).catch(() => fs.rmdir(p));
    } else if (st.isDirectory()) {
      await unlinkLinksBelow(p, fs);
    }
  }
}

/** Repo-relative, `/`-separated form of a bootstrap path; throws when it leaves the repo. */
export function safeBootstrapRel(p: string, platform: OsPlatform = process.platform): string {
  const api = isWindows(platform) ? path.win32 : path.posix;
  const n = api.normalize(p);
  if (
    !p ||
    api.isAbsolute(p) ||
    (isWindows(platform) && /^[A-Za-z]:/.test(p)) ||
    n === ".." ||
    n.startsWith(`..${api.sep}`) ||
    n === "."
  ) {
    throw new DispatchError(
      `bootstrap path must be relative and inside the repo: ${p}`,
      undefined,
      "sandbox.bootstrap_path",
    );
  }
  return n.split(api.sep).join("/").replace(/\/$/, "");
}

/** Symlinks ignored, untracked paths from `root` into `wt`; returns those actually linked. */
async function bootstrapLinks(
  root: string,
  wt: string,
  paths: string[],
  platform: OsPlatform,
  fs: SandboxFs,
): Promise<string[]> {
  const linked: string[] = [];
  for (const p of paths) {
    const rel = safeBootstrapRel(p, platform);
    const src = join(root, rel);
    const dst = join(wt, rel);
    if (!(await fs.lstat(src).catch(() => null))) continue;
    if (await fs.lstat(dst).catch(() => null)) continue; // exists in the base: tracked content wins
    // Only paths git ignores and does not track may be shared; never expose tracked files.
    const ignored = (await gitRaw(root, ["check-ignore", "-q", "--", rel])).code === 0;
    const tracked = (await gitRaw(root, ["ls-files", "--", rel])).stdout.trim().length > 0;
    if (!ignored || tracked) continue;
    const isDir = (await fs.stat(src).catch(() => null))?.isDirectory() === true;
    const type = bootstrapLinkType(rel, isDir, platform);
    await fs.mkdir(dirname(dst), { recursive: true });
    await (type === undefined ? fs.symlink(src, dst) : fs.symlink(src, dst, type));
    linked.push(rel);
  }
  return linked;
}

/** Git-worktree implementation of the {@link Sandbox} port. */
export class WorktreeSandbox implements Sandbox {
  readonly #platform: OsPlatform;
  readonly #fs: SandboxFs;

  constructor(opts: WorktreeSandboxOptions = {}) {
    this.#platform = opts.platform ?? process.platform;
    this.#fs = opts.fs ?? nodeSandboxFs;
  }

  /**
   * Creates a detached worktree at HEAD (or a snapshot of uncommitted changes) under
   * `<dispatchHome>/worktrees/<repo-hash>/<runId>`. Non-git directories are not copied: the
   * original directory is returned with `readOnlyReason: "not-git"`.
   */
  async create(opts: WorktreeCreateOptions): Promise<WorktreeHandle> {
    const root = await repoRoot(opts.repoPath);
    if (!root) {
      return {
        path: opts.repoPath,
        baseRef: "",
        dirtySnapshot: false,
        readOnlyReason: "not-git",
        bootstrapped: [],
      };
    }
    const common = await commonDir(root);
    const path = join(opts.dispatchHome, "worktrees", repoHash(common), opts.runId);
    if (existsSync(path)) {
      throw new DispatchError(`worktree already exists: ${path}`, undefined, "sandbox.exists");
    }

    const { baseRef, dirtySnapshot } = await snapshotBase(root);
    await this.#fs.mkdir(dirname(path), { recursive: true });
    await withLock(common, () => worktreeAdd(root, path, baseRef));

    const bootstrap = opts.bootstrap ?? { mode: "none", paths: [] };
    let bootstrapped: string[] = [];
    try {
      if (bootstrap.mode === "symlink-readonly") {
        bootstrapped = await bootstrapLinks(root, path, bootstrap.paths, this.#platform, this.#fs);
      }
    } catch (err) {
      await this.dispose(path, false).catch(() => {});
      throw err;
    }

    const handle: WorktreeHandle = { path, baseRef, dirtySnapshot, bootstrapped };
    if (await hasSubmodules(root)) handle.readOnlyReason = "submodules";
    else if (await usesLfs(root)) handle.readOnlyReason = "lfs";
    return handle;
  }

  /**
   * Removes the worktree at `path` unless `keep`. Anything that is not a Dispatch-created linked
   * worktree (for example the original directory of a non-git sandbox) is left alone.
   */
  async dispose(path: string, keep: boolean): Promise<void> {
    if (keep) return;
    const common = linkedCommonDir(path);
    if (!common) return;
    if (isWindows(this.#platform)) await unlinkLinksBelow(path, this.#fs);
    await worktreeRemove(common, path);
  }

  /**
   * Reaps worktrees under `<dispatchHome>/worktrees` whose run is terminal and whose directory is
   * at least `olderThanMs` old, then prunes dangling worktree records of each affected repo.
   * Worktrees of runs that are still active are never touched. Returns the removed paths (the
   * ones that would be removed with `dryRun`, which changes nothing).
   */
  async gc(opts: GcOptions): Promise<string[]> {
    const base = join(opts.dispatchHome, "worktrees");
    const removed: string[] = [];
    const repos = new Set<string>();
    const fs = this.#fs;
    for (const hash of await fs.readdir(base).catch(() => [])) {
      const hashDir = join(base, hash);
      for (const runId of await fs.readdir(hashDir).catch(() => [])) {
        const path = join(hashDir, runId);
        const st = await fs.stat(path).catch(() => null);
        if (!st?.isDirectory()) continue;
        if (opts.now - st.mtimeMs < opts.olderThanMs) continue;
        if (!(await opts.isTerminal(runId))) continue;
        if (opts.dryRun) {
          removed.push(path);
          continue;
        }
        if (isWindows(this.#platform)) {
          // A link that cannot be removed must not be followed by the deletes below.
          if (
            !(await unlinkLinksBelow(path, fs).then(
              () => true,
              () => false,
            ))
          )
            continue;
        }
        const common = linkedCommonDir(path);
        if (common && existsSync(common)) {
          repos.add(common);
          await worktreeRemove(common, path).catch(() => {});
        }
        // Repo gone, record broken or removal refused: still reclaim the directory.
        await fs.rm(path, { recursive: true, force: true });
        removed.push(path);
      }
      if (!opts.dryRun) await fs.rmdir(hashDir).catch(() => {}); // only succeeds when empty
    }
    for (const common of repos) await worktreePrune(common).catch(() => {});
    return removed;
  }
}
