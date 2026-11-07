import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, headSha, isDirty, repoRoot } from "./git.js";

/** Result of {@link snapshotBase}. */
export interface SnapshotResult {
  /** Commit the worktree should start from. */
  baseRef: string;
  /** True when `baseRef` is a synthetic commit capturing uncommitted changes. */
  dirtySnapshot: boolean;
}

/** Fixed identity so snapshot commits never depend on (or fail without) the user's git config. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "dispatch",
  GIT_AUTHOR_EMAIL: "dispatch@localhost",
  GIT_COMMITTER_NAME: "dispatch",
  GIT_COMMITTER_EMAIL: "dispatch@localhost",
};

/**
 * Picks the commit a task worktree starts from. A clean tree yields HEAD. A dirty tree yields a
 * new commit (parent HEAD) holding tracked changes plus untracked-but-not-ignored files.
 *
 * The user's repository state is never touched: the tree is assembled in a throw-away index file
 * (`GIT_INDEX_FILE`), so the real index, working tree, stash and refs stay byte-for-byte as they
 * were. The commit is unreferenced; the detached worktree that checks it out keeps it alive.
 */
export async function snapshotBase(dir: string): Promise<SnapshotResult> {
  const root = (await repoRoot(dir)) ?? dir;
  const head = await headSha(root);
  if (!(await isDirty(root))) return { baseRef: head, dirtySnapshot: false };

  const scratch = await mkdtemp(join(tmpdir(), "dispatch-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index"), ...SNAPSHOT_IDENTITY };
    await git(root, ["read-tree", head], env);
    await git(root, ["add", "-A"], env);
    const tree = await git(root, ["write-tree"], env);
    if (tree === (await git(root, ["rev-parse", `${head}^{tree}`]))) {
      return { baseRef: head, dirtySnapshot: false };
    }
    const commit = await git(
      root,
      [
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        head,
        "-m",
        "dispatch: snapshot of uncommitted changes",
      ],
      env,
    );
    return { baseRef: commit, dirtySnapshot: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
