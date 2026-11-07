/**
 * Patch path filter (plan §2 "Sandbox", §3 security; spec §9 rule 3, UC5). Pure: no I/O.
 *
 * Decides, per changed file, whether a change produced by an external agent may be handed back to
 * the user. Everything that could become an execution or trust vector once the patch is applied
 * (git internals, host and Dispatch configuration, agent instruction files, CI workflows, env
 * files, symlinks) is rejected, as are pinned paths that must stay with the host.
 *
 * Name checks are case-insensitive: the default macOS and Windows file systems are, so `.Claude/`
 * would land in `.claude/`.
 */
import picomatch from "picomatch";

/** Why a path was dropped from the patch. */
export type RejectReason =
  | "invalid-path"
  | "control-char"
  | "absolute"
  | "traversal"
  | "symlink"
  | "gitlink"
  | "git-internal"
  | "dispatch-config"
  | "host-config"
  | "ci-workflow"
  | "agent-instructions"
  | "env-file"
  | "pinned"
  | "denied";

/** Caller-supplied policy: pins (UC5) and extra deny globs, both repo-relative picomatch globs. */
export interface FilterPolicy {
  pins: readonly string[];
  denyGlobs?: readonly string[];
}

/** One side-by-side change as reported by `git diff --raw --no-renames` (modes are octal text). */
export interface ChangedFile {
  path: string;
  /** Mode before the change, `000000` when the file is new. */
  oldMode: string;
  /** Mode after the change, `000000` when the file was deleted. */
  newMode: string;
  /** Git status letter (A, M, D, T). */
  status: string;
}

/** A dropped path and why. */
export interface Rejection {
  path: string;
  reason: RejectReason;
}

/** Result of {@link filterChanges}. */
export interface FilterResult<T extends ChangedFile = ChangedFile> {
  accepted: T[];
  rejected: Rejection[];
}

const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

/** Directory names that configure Dispatch or a host CLI, rejected at any depth. */
const CONFIG_DIRS: ReadonlyMap<string, RejectReason> = new Map([
  [".dispatch", "dispatch-config"],
  [".claude", "host-config"],
  [".codex", "host-config"],
  [".gemini", "host-config"],
  [".agents", "host-config"],
]);

/** File names agents read as instructions, rejected at any depth. */
const INSTRUCTION_FILES = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "agents.override.md",
  "gemini.md",
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isEnvFile(name: string): boolean {
  // `.envrc` is executed by direnv on `cd`, so it is as dangerous as a dotenv file.
  return name === ".env" || name === ".envrc" || name.startsWith(".env.");
}

function compile(globs: readonly string[] | undefined): ((p: string) => boolean) | null {
  if (!globs || globs.length === 0) return null;
  return picomatch([...globs], { dot: true, nocase: true });
}

/** A path matches a glob when it or any of its ancestor directories does (pin `db/` covers `db/x`). */
function matchesSelfOrAncestor(segments: readonly string[], isMatch: (p: string) => boolean) {
  for (let i = segments.length; i > 0; i--) {
    if (isMatch(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

/** Returns why `path` (repo-relative, `/`-separated) must be rejected, or null when it is allowed. */
export function checkPath(path: string, policy: FilterPolicy): RejectReason | null {
  return makeChecker(policy)(path);
}

function makeChecker(policy: FilterPolicy): (path: string) => RejectReason | null {
  const pinned = compile(policy.pins);
  const denied = compile(policy.denyGlobs);
  return (path) => {
    if (path.length === 0) return "invalid-path";
    if (CONTROL_CHARS.test(path)) return "control-char";
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return "absolute";
    // Backslash is a separator on Windows: treat it as one so `a\..\b` cannot slip through.
    const segments = path.split(/[\\/]/);
    if (segments.includes("..")) return "traversal";
    if (segments.some((s) => s === "" || s === ".")) return "invalid-path";

    const lower = segments.map((s) => s.toLowerCase());
    const name = lower[lower.length - 1] as string;
    if (lower.includes(".git") || name === ".gitmodules") return "git-internal";
    for (const seg of lower) {
      const reason = CONFIG_DIRS.get(seg);
      if (reason) return reason;
    }
    for (let i = 0; i + 1 < lower.length; i++) {
      if (lower[i] === ".github" && lower[i + 1] === "workflows") return "ci-workflow";
    }
    if (INSTRUCTION_FILES.has(name)) return "agent-instructions";
    if (isEnvFile(name)) return "env-file";

    if (pinned && matchesSelfOrAncestor(segments, pinned)) return "pinned";
    if (denied && matchesSelfOrAncestor(segments, denied)) return "denied";
    return null;
  };
}

/** Mode-based rejection: symlinks and submodule entries, before or after the change. */
function checkModes(file: ChangedFile): RejectReason | null {
  if (file.newMode === SYMLINK_MODE || file.oldMode === SYMLINK_MODE) return "symlink";
  if (file.newMode === GITLINK_MODE || file.oldMode === GITLINK_MODE) return "gitlink";
  return null;
}

/**
 * Splits `files` into accepted and rejected changes. Path problems are reported before mode
 * problems, so a symlink named `../x` is reported as `traversal`.
 */
export function filterChanges<T extends ChangedFile>(
  files: readonly T[],
  policy: FilterPolicy,
): FilterResult<T> {
  const check = makeChecker(policy);
  const accepted: T[] = [];
  const rejected: Rejection[] = [];
  for (const file of files) {
    const reason = check(file.path) ?? checkModes(file);
    if (reason) rejected.push({ path: file.path, reason });
    else accepted.push(file);
  }
  return { accepted, rejected };
}
