/**
 * Repo trust (plan §2 "Config", SEC-trust).
 *
 * - Identity: realpath of the git common dir, found through the filesystem only (a linked
 *   worktree's `.git` file → `gitdir:` → `commondir`), so every worktree and every symlinked
 *   path of a repo share one identity.
 * - Policy set: `.dispatch/config.yaml`, `profiles/*.yaml`, `mappings/*.yaml`, sorted.
 * - Hash: sha256 over `relpath \0 byteLength \0 bytes` of each file. Each file is read ONCE
 *   (O_NOFOLLOW) into a buffer; the same buffers are hashed and later parsed, so a file
 *   swapped after hashing cannot change the policy that is applied.
 * - Any symlink inside `.dispatch/` makes the repo untrusted.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  CONFIG_FILE,
  globalConfigPath,
  MAPPINGS_DIR,
  type PathEnv,
  PROFILES_DIR,
  REPO_DIR,
} from "./paths.js";
import type { TrustedRepo } from "./schema.js";

/** A git checkout and the identity of its repository. */
export interface RepoLocation {
  /** Top of the checkout (the directory holding `.git`), realpath'd. */
  worktreeRoot: string;
  /** realpath of the git common dir: the repo identity used as the trust key. */
  id: string;
}

/** Finds the enclosing git checkout of `cwd`, or `null` when there is none. */
export function findRepo(cwd: string): RepoLocation | null {
  let dir = realpathSync(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    const st = lstatOrNull(dotGit);
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m?.[1]) return null;
        gitDir = resolve(dir, m[1]);
      }
      const commonFile = join(gitDir, "commondir");
      const common = existsSync(commonFile)
        ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
        : gitDir;
      return { worktreeRoot: dir, id: realpathSync(common) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** One policy file, read once. */
export interface PolicyFile {
  /** Path relative to the worktree root, e.g. ".dispatch/profiles/team.yaml". */
  rel: string;
  bytes: Buffer;
}

/** The repo's policy files plus their hashes. */
export interface PolicySet {
  files: PolicyFile[];
  /** sha256 of the whole set (hex). */
  hash: string;
  /** rel → sha256 of each file, stored in `trusted_repos` to name changed files. */
  fileHashes: Record<string, string>;
  /** First symlink found inside `.dispatch/` (relative path), or null. */
  symlink: string | null;
}

/** Test seam: called after the set is read and hashed, before anything parses it. */
export interface TrustHooks {
  afterHash?(set: PolicySet): void;
}

/** Reads and hashes the policy set of a checkout. Missing `.dispatch/` = empty set. */
export function readPolicySet(worktreeRoot: string, hooks?: TrustHooks): PolicySet {
  const symlink = findSymlink(worktreeRoot, REPO_DIR);
  const files: PolicyFile[] = [];
  if (!symlink && existsSync(join(worktreeRoot, REPO_DIR))) {
    const rels = [`${REPO_DIR}/${CONFIG_FILE}`];
    for (const sub of [PROFILES_DIR, MAPPINGS_DIR]) {
      const dir = join(worktreeRoot, REPO_DIR, sub);
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".yaml")) rels.push(`${REPO_DIR}/${sub}/${e.name}`);
      }
    }
    for (const rel of rels.sort()) {
      const bytes = readNoFollow(join(worktreeRoot, rel));
      if (bytes) files.push({ rel, bytes });
    }
  }
  const total = createHash("sha256");
  const fileHashes: Record<string, string> = {};
  for (const f of files) {
    total.update(f.rel).update("\0").update(String(f.bytes.byteLength)).update("\0");
    total.update(f.bytes);
    fileHashes[f.rel] = createHash("sha256").update(f.bytes).digest("hex");
  }
  const set: PolicySet = { files, hash: total.digest("hex"), fileHashes, symlink };
  hooks?.afterHash?.(set);
  return set;
}

/** Relative path of the first symlink at or below `root/rel`, or null. */
function findSymlink(root: string, rel: string): string | null {
  const st = lstatOrNull(join(root, rel));
  if (!st) return null;
  if (st.isSymbolicLink()) return rel;
  if (!st.isDirectory()) return null;
  for (const name of readdirSync(join(root, rel)).sort()) {
    const hit = findSymlink(root, `${rel}/${name}`);
    if (hit) return hit;
  }
  return null;
}

/** Reads a regular file without following a final symlink; null when absent. */
function readNoFollow(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new DispatchError(`cannot read ${path}`, ExitCode.USAGE, "config.trust", { cause: err });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export type TrustStatus = "none" | "trusted" | "untrusted" | "changed" | "symlink";

/** Outcome of checking a checkout's policy against `trusted_repos`. */
export interface TrustState {
  /** none: no repo or no policy files; trusted: apply `policy`; anything else: ignore it. */
  status: TrustStatus;
  repo: RepoLocation | null;
  policy: PolicySet | null;
  /** Files added, removed or modified since `dispatch trust` (status "changed"). */
  changed: string[];
}

/** Checks whether the policy set of the checkout around `cwd` is trusted. */
export function checkTrust(
  cwd: string,
  trusted: Readonly<Record<string, TrustedRepo>>,
  hooks?: TrustHooks,
): TrustState {
  const repo = findRepo(cwd);
  if (!repo) return { status: "none", repo, policy: null, changed: [] };
  const policy = readPolicySet(repo.worktreeRoot, hooks);
  if (policy.symlink) return { status: "symlink", repo, policy, changed: [] };
  if (policy.files.length === 0) return { status: "none", repo, policy, changed: [] };
  const entry = trusted[repo.id];
  if (!entry) return { status: "untrusted", repo, policy, changed: [] };
  if (entry.hash === policy.hash) return { status: "trusted", repo, policy, changed: [] };
  const names = new Set([...Object.keys(entry.files), ...Object.keys(policy.fileHashes)]);
  const changed = [...names].filter((n) => entry.files[n] !== policy.fileHashes[n]).sort();
  return { status: "changed", repo, policy, changed };
}

/**
 * `dispatch trust`: records the current policy set of the checkout around `cwd` in the global
 * config (`trusted_repos[<id>]`), preserving the file's comments; atomic write (temp + rename).
 */
export function trustRepo(opts: { cwd: string; env: PathEnv; now: Date }): {
  id: string;
  entry: TrustedRepo;
} {
  const repo = findRepo(opts.cwd);
  if (!repo) {
    throw new DispatchError("not inside a git repository", ExitCode.USAGE, "config.trust");
  }
  const policy = readPolicySet(repo.worktreeRoot);
  if (policy.symlink) {
    throw new DispatchError(
      `refusing to trust: ${policy.symlink} is a symlink`,
      ExitCode.USAGE,
      "config.trust",
    );
  }
  if (policy.files.length === 0) {
    throw new DispatchError("no .dispatch/ policy files to trust", ExitCode.USAGE, "config.trust");
  }
  const entry: TrustedRepo = {
    hash: policy.hash,
    files: policy.fileHashes,
    trusted_at: opts.now.toISOString(),
  };
  const path = globalConfigPath(opts.env);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "version: 1\n";
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new DispatchError(`${path}: ${doc.errors[0]?.message}`, ExitCode.USAGE, "config.invalid");
  }
  if (!isMap(doc.get("trusted_repos"))) doc.set("trusted_repos", doc.createNode({}));
  doc.setIn(["trusted_repos", repo.id], doc.createNode(entry));
  writeAtomic(path, doc.toString());
  return { id: repo.id, entry };
}

/** Writes `text` to `path` via a sibling temp file and rename. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
