/**
 * Apply-check (spec §9 rule 6, UC13; plan amendment 10): does the patch apply cleanly to the
 * user's CURRENT working tree? Runs `git apply --check` without `--index`/`--cached`, which reads
 * working-tree files and writes nothing: neither the index nor any file is touched.
 */
import { gitRaw } from "./git.js";

/** Result of {@link applyCheck}. */
export interface ApplyCheckResult {
  applies: boolean;
  /** git's explanation when the patch does not apply (e.g. `patch failed: a.txt:1`). */
  conflict?: string;
}

/**
 * Checks the patch file at `patchPath` (absolute) against the working tree rooted at `repoRoot`.
 * Must run from the repo root: from a subdirectory, git silently skips paths outside it.
 */
export async function applyCheck(repoRoot: string, patchPath: string): Promise<ApplyCheckResult> {
  // Whitespace warnings are noise here, not conflicts.
  const r = await gitRaw(repoRoot, [
    "apply",
    "--check",
    "--binary",
    "--whitespace=nowarn",
    patchPath,
  ]);
  if (r.code === 0) return { applies: true };
  return { applies: false, conflict: (r.stderr || r.stdout).trim() };
}
