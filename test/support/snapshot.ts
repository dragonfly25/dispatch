import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** One path of a snapshot. Symlinks record their target (never followed); files their sha256. */
export interface SnapshotEntry {
  type: "file" | "dir" | "symlink";
  /** Permission bits (`mode & 0o7777`); omitted for symlinks, whose mode differs per platform. */
  mode?: number;
  sha256?: string;
  target?: string;
}

/** Posix-style relative path -> entry, in sorted key order. */
export type TreeSnapshot = Record<string, SnapshotEntry>;

/** A string excludes that path and everything below it; a RegExp is tested on the relative path. */
export type SnapshotExclude = string | RegExp;

/** Excluded by default: git's object database changes with every commit and says nothing about the tree. */
export const DEFAULT_SNAPSHOT_EXCLUDE: SnapshotExclude[] = [".git/objects"];
/** Git files that churn on read-only commands (`git status` refreshes the index). `treeHash` skips them. */
export const VOLATILE_GIT_EXCLUDE: SnapshotExclude[] = [
  ".git/index",
  ".git/logs",
  ".git/FETCH_HEAD",
  ".git/ORIG_HEAD",
];

function isExcluded(rel: string, exclude: SnapshotExclude[]): boolean {
  return exclude.some((e) =>
    typeof e === "string" ? rel === e || rel.startsWith(`${e}/`) : e.test(rel),
  );
}

/**
 * Records every file, directory and symlink under `dir` (sha256 + mode + symlink target), so a
 * test can prove an operation left a tree untouched (AC2). `.git/objects` is excluded unless
 * `opts.exclude` replaces the list. Empty directories count: a leftover `.dispatch/` shows up.
 */
export function snapshotTree(
  dir: string,
  opts: { exclude?: SnapshotExclude[] } = {},
): TreeSnapshot {
  const exclude = opts.exclude ?? DEFAULT_SNAPSHOT_EXCLUDE;
  const out: TreeSnapshot = {};
  const walk = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (isExcluded(childRel, exclude)) continue;
      const childAbs = join(abs, name);
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        out[childRel] = { type: "symlink", target: readlinkSync(childAbs) };
      } else if (st.isDirectory()) {
        out[childRel] = { type: "dir", mode: st.mode & 0o7777 };
        walk(childRel);
      } else {
        const sha256 = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
        out[childRel] = { type: "file", mode: st.mode & 0o7777, sha256 };
      }
    }
  };
  walk("");
  return out;
}

/**
 * Single sha256 over `snapshotTree(dir)`; equal hashes mean identical trees. By default it also
 * skips the volatile git files (index, logs, FETCH_HEAD, ORIG_HEAD) so read-only git commands
 * between two hashes do not change the result; hooks, config and info/exclude still count.
 */
export function treeHash(dir: string, opts: { exclude?: SnapshotExclude[] } = {}): string {
  const exclude = opts.exclude ?? [...DEFAULT_SNAPSHOT_EXCLUDE, ...VOLATILE_GIT_EXCLUDE];
  return createHash("sha256")
    .update(JSON.stringify(snapshotTree(dir, { exclude })))
    .digest("hex");
}
