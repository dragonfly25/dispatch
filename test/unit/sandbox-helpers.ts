import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execTool } from "../../src/runner/exec.js";

/** Runs git in `cwd` and returns stdout; throws on a non-zero exit. */
export async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await execTool("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Creates a temp dir (realpath-resolved) and registers it for cleanup. */
export async function tmp(bucket: string[], prefix = "wp7-"): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  bucket.push(d);
  return d;
}

export async function cleanup(bucket: string[]): Promise<void> {
  await Promise.all(bucket.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Writes files (relative path -> content), creating directories. */
export async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}

/** A repo with one commit, a local identity, and `.gitignore` ignoring `node_modules/` and `*.log`. */
export async function makeRepo(
  bucket: string[],
  extra: Record<string, string> = {},
): Promise<string> {
  const dir = await tmp(bucket, "wp7-repo-");
  await g(dir, "init", "-q", "-b", "main");
  await g(dir, "config", "user.email", "t@example.com");
  await g(dir, "config", "user.name", "Test");
  await g(dir, "config", "commit.gpgsign", "false");
  await put(dir, { ".gitignore": "node_modules/\n*.log\n", "a.txt": "one\n", ...extra });
  await g(dir, "add", "-A");
  await g(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Observable state of a repo that a snapshot must never change. */
export async function repoState(dir: string) {
  return {
    status: await g(dir, "status", "--porcelain"),
    stash: await g(dir, "stash", "list"),
    head: (await g(dir, "rev-parse", "HEAD")).trim(),
    index: (await g(dir, "write-tree")).trim(),
    refs: await g(dir, "for-each-ref"),
  };
}
