import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DispatchError } from "../core/errors.js";
import { type ExecToolResult, execTool } from "../runner/exec.js";

/** Environment that keeps read-only git commands from taking locks or prompting. */
const QUIET_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** Runs git and returns the raw result; callers decide what a non-zero exit means. */
export function gitRaw(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<ExecToolResult> {
  return execTool("git", args, { cwd, env: { ...QUIET_ENV, ...env } });
}

/** Runs git and returns stdout without the trailing newline; throws DispatchError on failure. */
export async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  const r = await gitRaw(cwd, args, env);
  if (r.code !== 0) {
    throw new DispatchError(
      `git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`,
      undefined,
      "git.failed",
    );
  }
  return r.stdout.replace(/\n$/, "");
}

/** Top-level directory of the work tree containing `dir`, or null when `dir` is not in one. */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await gitRaw(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  return realpath(r.stdout.trim());
}

/** Absolute, symlink-resolved common git directory (shared by all worktrees of a repo). */
export async function commonDir(dir: string): Promise<string> {
  return realpath(await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

/** Full sha of HEAD. Throws when the repository has no commits. */
export async function headSha(dir: string): Promise<string> {
  const r = await gitRaw(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (r.code !== 0) {
    throw new DispatchError("repository has no commits yet", undefined, "git.no_head");
  }
  return r.stdout.trim();
}

/** Raw `git status --porcelain=v2 -z` output (NUL-separated records), untracked files included. */
export function status(dir: string): Promise<string> {
  return git(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
}

/** True when the work tree has staged, unstaged or untracked (non-ignored) changes. */
export async function isDirty(dir: string): Promise<boolean> {
  return (await status(dir)).length > 0;
}

/** True when the repo declares submodules (`.gitmodules` or `git submodule status` output). */
export async function hasSubmodules(root: string): Promise<boolean> {
  if (existsSync(join(root, ".gitmodules"))) return true;
  const r = await gitRaw(root, ["submodule", "status"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** True when `.gitattributes` or `info/attributes` routes files through the LFS filter. */
export async function usesLfs(root: string): Promise<boolean> {
  const files = [join(root, ".gitattributes")];
  const info = await gitRaw(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/attributes",
  ]);
  if (info.code === 0) files.push(info.stdout.trim());
  return files.some((f) => {
    try {
      return /filter\s*=\s*lfs\b/.test(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Adds a detached worktree at `path` checked out at `ref`. */
export async function worktreeAdd(repo: string, path: string, ref: string): Promise<void> {
  await git(repo, ["worktree", "add", "--detach", "--quiet", path, ref]);
}

/** Force-removes the worktree at `path`. `repo` may be any worktree or the common git dir. */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/** Paths of all worktrees registered for the repository (the main one first). */
export async function worktreeList(repo: string): Promise<string[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  return out
    .split("\0")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Drops administrative records of worktrees whose directory is gone. */
export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}
