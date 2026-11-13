/**
 * Repo trust (plan §2 "Config", SEC-trust).
 *
 * - Identity: realpath of the git common dir, found through the filesystem only (a linked
 *   worktree's `.git` file → `gitdir:` → `commondir`), so every worktree and every symlinked
 *   path of a repo share one identity.
 * - Policy set: `.dispatch/config.yaml`, `profiles/*.yaml`, `mappings/*.yaml`, sorted.
 * - Hash: sha256 over `relpath \0 byteLength \0 bytes` of each file. Each file is read ONCE
 *   (O_NOFOLLOW; Windows has no such flag: lstat before and fstat after the open must name the
 *   same non-link file) into a buffer; the same buffers are hashed and later parsed, so a file
 *   swapped after hashing cannot change the policy that is applied.
 * - Any symlink inside `.dispatch/` makes the repo untrusted (on Windows, junctions too: Node's
 *   lstat reports them as symbolic links).
 * - Windows: the id comes from the native realpath (canonical drive-letter and name case) and is
 *   looked up in `trusted_repos` case-insensitively, so `c:\repo` and `C:\Repo` share a trust.
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
import { isWindows, type OsPlatform } from "../platform/os.js";
import { pathKey } from "./pathkey.js";
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

/**
 * realpath used for repo identities. Windows: the native resolver (GetFinalPathNameByHandle),
 * which also canonicalises the case of every component; POSIX: Node's default.
 */
function realpathFor(platform: OsPlatform): (p: string) => string {
  return isWindows(platform) ? realpathSync.native : realpathSync;
}

/** Finds the enclosing git checkout of `cwd`, or `null` when there is none. */
export function findRepo(
  cwd: string,
  platform: OsPlatform = process.platform,
): RepoLocation | null {
  const real = realpathFor(platform);
  let dir = real(cwd);
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
      return { worktreeRoot: dir, id: real(common) };
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

/** Test seams. */
export interface TrustHooks {
  /** Called after the set is read and hashed, before anything parses it. */
  afterHash?(set: PolicySet): void;
  /** Platform whose rules apply (default `process.platform`). */
  platform?: OsPlatform;
  /** File operations of the no-follow read (default: `node:fs`). */
  fs?: NoFollowFs;
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
      const bytes = readNoFollow(join(worktreeRoot, rel), hooks?.platform, hooks?.fs);
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

/** The `node:fs` calls {@link readNoFollow} makes (a test seam). */
export interface NoFollowFs {
  lstatSync(path: string, opts: { bigint: true }): FileIdentity;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number, opts: { bigint: true }): FileIdentity & { size: bigint };
  readSync(fd: number, buf: Buffer, off: number, len: number, pos: number): number;
  closeSync(fd: number): void;
}

/** What identifies a file across lstat and fstat. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const nodeFs: NoFollowFs = { lstatSync, openSync, fstatSync, readSync, closeSync };

function cannotRead(path: string, cause: unknown): DispatchError {
  return new DispatchError(`cannot read ${path}`, ExitCode.USAGE, "config.trust", { cause });
}

/**
 * Opens `path` for reading without following a final symlink, or returns null when absent.
 * POSIX: `O_NOFOLLOW` (a link fails with ELOOP). Windows has no `O_NOFOLLOW` (Node's constant is
 * undefined, so the flag would silently be 0): the path is lstat'ed first (a symlink or junction
 * is refused), opened, and the open handle must have the same volume and file index as the
 * lstat'ed entry, so a link swapped in between is refused too.
 */
function openNoFollow(path: string, platform: OsPlatform, fs: NoFollowFs): number | null {
  const absent = (err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  };
  if (!isWindows(platform)) {
    try {
      return fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      if (absent(err)) return null;
      throw cannotRead(path, err);
    }
  }
  let before: FileIdentity;
  let fd: number;
  try {
    before = fs.lstatSync(path, { bigint: true });
    if (before.isSymbolicLink()) throw Object.assign(new Error("symbolic link"), { code: "ELOOP" });
    fd = fs.openSync(path, constants.O_RDONLY);
  } catch (err) {
    if (absent(err)) return null;
    throw cannotRead(path, err);
  }
  try {
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw cannotRead(
        path,
        Object.assign(new Error("file replaced while opening"), { code: "ELOOP" }),
      );
    }
  } catch (err) {
    fs.closeSync(fd);
    throw err instanceof DispatchError ? err : cannotRead(path, err);
  }
  return fd;
}

/**
 * Reads a regular file without following a final symlink (see {@link openNoFollow}); null when
 * absent or not a regular file. Exported for tests.
 */
export function readNoFollow(
  path: string,
  platform: OsPlatform = process.platform,
  fs: NoFollowFs = nodeFs,
): Buffer | null {
  const fd = openNoFollow(path, platform, fs);
  if (fd === null) return null;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
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
  const platform = hooks?.platform ?? process.platform;
  const repo = findRepo(cwd, platform);
  if (!repo) return { status: "none", repo, policy: null, changed: [] };
  const policy = readPolicySet(repo.worktreeRoot, hooks);
  if (policy.symlink) return { status: "symlink", repo, policy, changed: [] };
  if (policy.files.length === 0) return { status: "none", repo, policy, changed: [] };
  const entry = trustedEntry(trusted, repo.id, platform);
  if (!entry) return { status: "untrusted", repo, policy, changed: [] };
  if (entry.hash === policy.hash) return { status: "trusted", repo, policy, changed: [] };
  const names = new Set([...Object.keys(entry.files), ...Object.keys(policy.fileHashes)]);
  const changed = [...names].filter((n) => entry.files[n] !== policy.fileHashes[n]).sort();
  return { status: "changed", repo, policy, changed };
}

/**
 * The `trusted_repos` entry of repo `id`: exact key first; on Windows also any key naming the
 * same path ({@link pathKey}: case and separators ignored).
 */
export function trustedEntry(
  trusted: Readonly<Record<string, TrustedRepo>>,
  id: string,
  platform: OsPlatform = process.platform,
): TrustedRepo | undefined {
  if (Object.hasOwn(trusted, id)) return trusted[id];
  if (!isWindows(platform)) return undefined;
  const key = pathKey(id, platform);
  const hit = Object.keys(trusted).find((k) => pathKey(k, platform) === key);
  return hit === undefined ? undefined : trusted[hit];
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
