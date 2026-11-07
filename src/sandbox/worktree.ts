import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rm, rmdir, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { Sandbox, SandboxCreateOptions, SandboxHandle } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
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

function assertSafeRelative(p: string): void {
  const n = normalize(p);
  if (!p || isAbsolute(p) || n === ".." || n.startsWith(`..${sep}`) || n === ".") {
    throw new DispatchError(
      `bootstrap path must be relative and inside the repo: ${p}`,
      undefined,
      "sandbox.bootstrap_path",
    );
  }
}

/** Symlinks ignored, untracked paths from `root` into `wt`; returns those actually linked. */
async function bootstrapLinks(root: string, wt: string, paths: string[]): Promise<string[]> {
  const linked: string[] = [];
  for (const p of paths) {
    assertSafeRelative(p);
    const rel = normalize(p).split(sep).join("/").replace(/\/$/, "");
    const src = join(root, rel);
    const dst = join(wt, rel);
    if (!(await lstat(src).catch(() => null))) continue;
    if (await lstat(dst).catch(() => null)) continue; // exists in the base: tracked content wins
    // Only paths git ignores and does not track may be shared; never expose tracked files.
    const ignored = (await gitRaw(root, ["check-ignore", "-q", "--", rel])).code === 0;
    const tracked = (await gitRaw(root, ["ls-files", "--", rel])).stdout.trim().length > 0;
    if (!ignored || tracked) continue;
    await mkdir(dirname(dst), { recursive: true });
    await symlink(src, dst);
    linked.push(rel);
  }
  return linked;
}

/** Git-worktree implementation of the {@link Sandbox} port. */
export class WorktreeSandbox implements Sandbox {
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
    await mkdir(dirname(path), { recursive: true });
    await withLock(common, () => worktreeAdd(root, path, baseRef));

    const bootstrap = opts.bootstrap ?? { mode: "none", paths: [] };
    let bootstrapped: string[] = [];
    try {
      if (bootstrap.mode === "symlink-readonly") {
        bootstrapped = await bootstrapLinks(root, path, bootstrap.paths);
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
    await worktreeRemove(common, path);
  }

  /**
   * Reaps worktrees under `<dispatchHome>/worktrees` whose run is terminal and whose directory is
   * at least `olderThanMs` old, then prunes dangling worktree records of each affected repo.
   * Worktrees of runs that are still active are never touched. Returns the removed paths.
   */
  async gc(opts: GcOptions): Promise<string[]> {
    const base = join(opts.dispatchHome, "worktrees");
    const removed: string[] = [];
    const repos = new Set<string>();
    for (const hash of await readdir(base).catch(() => [])) {
      const hashDir = join(base, hash);
      for (const runId of await readdir(hashDir).catch(() => [])) {
        const path = join(hashDir, runId);
        const st = await stat(path).catch(() => null);
        if (!st?.isDirectory()) continue;
        if (opts.now - st.mtimeMs < opts.olderThanMs) continue;
        if (!(await opts.isTerminal(runId))) continue;
        const common = linkedCommonDir(path);
        if (common && existsSync(common)) {
          repos.add(common);
          await worktreeRemove(common, path).catch(() => {});
        }
        // Repo gone, record broken or removal refused: still reclaim the directory.
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      }
      await rmdir(hashDir).catch(() => {}); // only succeeds when empty
    }
    for (const common of repos) await worktreePrune(common).catch(() => {});
    return removed;
  }
}
