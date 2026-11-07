/**
 * Patch pipeline (plan §2 "Sandbox", spec §9 rules 3 and 6, UC5, UC13, AC7):
 * collect → filter → secret scan → apply-check → write `<runDir>/patch.diff`.
 *
 * The change set is collected in a TEMPORARY index (`GIT_INDEX_FILE`), never the worktree's real
 * one: `read-tree <base>`, `add -A` (bootstrapped symlinks excluded), then `diff --cached` against
 * the base. That captures edits, adds, deletes, renames, binaries and mode changes whether or not
 * the agent committed. Rejected paths are reset to the base inside the temporary index before the
 * final diff, so the patch is rebuilt from the accepted files only. Dispatch never applies it.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchInfo } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { applyCheck } from "./applycheck.js";
import { type ChangedFile, type FilterPolicy, filterChanges, type Rejection } from "./filter.js";
import { git, repoRoot } from "./git.js";
import { type SecretFinding, scanPatch } from "./secrets.js";
import type { WorktreeHandle } from "./worktree.js";

/** Name of the patch file inside the run directory. */
export const PATCH_FILE = "patch.diff";

/** Options for {@link buildPatch}. */
export interface BuildPatchOptions {
  /** The sandbox the agent worked in. Read-only sandboxes cannot produce a patch. */
  worktree: Pick<WorktreeHandle, "path" | "baseRef" | "dirtySnapshot" | "bootstrapped"> &
    Partial<Pick<WorktreeHandle, "readOnlyReason">>;
  /** The user's repository (any directory inside it); the apply-check runs at its root. */
  repoPath: string;
  /** Run directory; the patch is written to `<runDir>/patch.diff` (mode 0600). */
  runDir: string;
  policy: FilterPolicy;
}

/** A change from `git diff --raw`, with the blob ids needed to reset it. */
export interface RawChange extends ChangedFile {
  oldSha: string;
  newSha: string;
}

/** Result of {@link buildPatch}. */
export interface PatchResult {
  /** Contract view. When `empty`, `path` names where the patch would be but no file exists. */
  patch: PatchInfo;
  /** True when no accepted change remains (nothing written). */
  empty: boolean;
  /** Accepted changes, as seen without rename detection. */
  files: RawChange[];
  rejected: Rejection[];
  /** Secret-scan hits in accepted files; never contains the matched value. */
  findings: SecretFinding[];
  /** git's explanation when the patch does not apply to the current working tree. */
  conflict?: string;
}

/** Flags that pin diff output regardless of the user's git config. */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Parses `git diff --raw -z --no-abbrev --no-renames` output. */
export function parseRaw(out: string): RawChange[] {
  const tokens = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = (tokens[i] as string).slice(1).split(" ");
    changes.push({
      path: tokens[i + 1] as string,
      oldMode: oldMode as string,
      newMode: newMode as string,
      oldSha: oldSha as string,
      newSha: newSha as string,
      status: status as string,
    });
  }
  return changes;
}

const ABSENT_MODE = "000000";

/** Puts rejected paths back to their base state in the (temporary) index selected by `env`. */
async function resetToBase(cwd: string, env: Record<string, string>, dropped: RawChange[]) {
  const added = dropped.filter((c) => c.oldMode === ABSENT_MODE).map((c) => c.path);
  const existed = dropped.filter((c) => c.oldMode !== ABSENT_MODE);
  if (added.length > 0) await git(cwd, ["update-index", "--force-remove", "--", ...added], env);
  if (existed.length > 0) {
    const infos = existed.flatMap((c) => ["--cacheinfo", `${c.oldMode},${c.oldSha},${c.path}`]);
    await git(cwd, ["update-index", "--add", ...infos], env);
  }
}

/** Pathspec that excludes one literal path (and everything under it). */
function excludeSpec(path: string): string {
  return `:(exclude,literal)${path}`;
}

/**
 * Collects, filters, scans and checks the agent's changes, then writes the patch.
 * Never touches the worktree's real index nor the user's index or working tree.
 */
export async function buildPatch(opts: BuildPatchOptions): Promise<PatchResult> {
  const { worktree: wt, runDir, policy } = opts;
  if (wt.readOnlyReason) {
    throw new DispatchError(
      `read-only sandbox (${wt.readOnlyReason}) cannot produce a patch`,
      undefined,
      "sandbox.read_only",
    );
  }
  const root = await repoRoot(opts.repoPath);
  if (!root) {
    throw new DispatchError(`not a git repository: ${opts.repoPath}`, undefined, "git.not_repo");
  }

  const scratch = await mkdtemp(join(tmpdir(), "dispatch-patch-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const patchPath = join(runDir, PATCH_FILE);
  try {
    await git(wt.path, ["read-tree", wt.baseRef], env);
    await git(wt.path, ["add", "-A", "--", ".", ...wt.bootstrapped.map(excludeSpec)], env);
    const raw = await git(
      wt.path,
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", wt.baseRef],
      env,
    );
    const changes = parseRaw(raw);
    const { accepted, rejected } = filterChanges(changes, policy);
    const rejectedSet = new Set(rejected.map((r) => r.path));
    const dropped = changes.filter((c) => rejectedSet.has(c.path));
    await resetToBase(wt.path, env, dropped);

    await mkdir(runDir, { recursive: true });
    await rm(patchPath, { force: true });
    const base = {
      path: patchPath,
      rejectedPaths: rejected.map((r) => r.path),
    };
    if (accepted.length === 0) {
      const patch = { ...base, diffstat: "", applies: true, needsReview: wt.dirtySnapshot };
      return { patch, empty: true, files: [], rejected, findings: [] };
    }

    // Created 0600 first so git's `--output` (which truncates, keeping the mode) never widens it.
    await writeFile(patchPath, "", { mode: 0o600 });
    await chmod(patchPath, 0o600);
    await git(
      wt.path,
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "-M",
        ...DIFF_FLAGS,
        `--output=${patchPath}`,
        wt.baseRef,
      ],
      env,
    );
    const diffstat = await git(
      wt.path,
      ["diff", "--cached", "-M", "--stat=200", "--summary", ...DIFF_FLAGS, wt.baseRef],
      env,
    );

    const findings = scanPatch(await readFile(patchPath, "utf8"));
    const check = await applyCheck(root, patchPath);
    const patch: PatchInfo = {
      ...base,
      diffstat,
      applies: check.applies,
      needsReview: findings.length > 0 || wt.dirtySnapshot,
    };
    const result: PatchResult = { patch, empty: false, files: accepted, rejected, findings };
    if (check.conflict !== undefined) result.conflict = check.conflict;
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
