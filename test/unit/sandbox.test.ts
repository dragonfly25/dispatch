import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DispatchError } from "../../src/core/errors.js";
import * as gitx from "../../src/sandbox/git.js";
import { snapshotBase } from "../../src/sandbox/snapshot.js";
import { WorktreeSandbox } from "../../src/sandbox/worktree.js";
import { cleanup, g, makeRepo, put, repoState, tmp } from "./sandbox-helpers.js";

const dirs: string[] = [];
const sandbox = new WorktreeSandbox();
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  // Hermetic git: ignore the developer's global/system config.
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => cleanup(dirs));

const base = { autonomy: "worktree" as const };

async function create(repoPath: string, home: string, runId: string) {
  return sandbox.create({ ...base, repoPath, runId, dispatchHome: home });
}

describe("snapshotBase [UC13]", () => {
  it("clean tree -> HEAD, not a snapshot", async () => {
    const repo = await makeRepo(dirs);
    const head = (await g(repo, "rev-parse", "HEAD")).trim();
    expect(await snapshotBase(repo)).toEqual({ baseRef: head, dirtySnapshot: false });
  });

  it("[AC-dispatchdir] an untracked .dispatch/ directory does not make the tree dirty", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { ".dispatch/config.yaml": "version: 1\n", ".dispatch/hooks/x.json": "{}\n" });
    const head = (await g(repo, "rev-parse", "HEAD")).trim();
    expect(await snapshotBase(repo)).toEqual({ baseRef: head, dirtySnapshot: false });
  });

  it("[AC-dispatchdir] a genuine change still snapshots, and the snapshot omits .dispatch/", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { ".dispatch/config.yaml": "version: 1\n", "a.txt": "changed\n" });
    const snap = await snapshotBase(repo);
    expect(snap.dirtySnapshot).toBe(true);
    const files = (await g(repo, "ls-tree", "-r", "--name-only", snap.baseRef)).split("\n");
    expect(files).toContain("a.txt");
    expect(files.some((f) => f.startsWith(".dispatch/"))).toBe(false);
  });

  it("dirty tree -> snapshot with modified, staged, deleted and untracked files, without ignored ones", async () => {
    const repo = await makeRepo(dirs, { "gone.txt": "bye\n", "keep/b.txt": "b\n" });
    await put(repo, {
      "a.txt": "changed\n",
      "staged.txt": "staged\n",
      "new/untracked.txt": "u\n",
      "debug.log": "ignored\n",
      "node_modules/pkg/index.js": "ignored\n",
    });
    await g(repo, "add", "staged.txt");
    await rm(join(repo, "gone.txt"));
    const head = (await g(repo, "rev-parse", "HEAD")).trim();

    const snap = await snapshotBase(repo);
    expect(snap.dirtySnapshot).toBe(true);
    expect(snap.baseRef).not.toBe(head);
    expect((await g(repo, "rev-parse", `${snap.baseRef}^`)).trim()).toBe(head);
    const files = (await g(repo, "ls-tree", "-r", "--name-only", snap.baseRef))
      .split("\n")
      .filter(Boolean);
    expect(files).toEqual(
      [".gitignore", "a.txt", "keep/b.txt", "new/untracked.txt", "staged.txt"].sort(),
    );
    expect(await g(repo, "show", `${snap.baseRef}:a.txt`)).toBe("changed\n");
  });

  it("[SEC] leaves index, working tree, stash, HEAD and refs untouched", async () => {
    const repo = await makeRepo(dirs);
    // A pre-existing stash, a partially staged file and an untracked file.
    await put(repo, { "a.txt": "stashed\n" });
    await g(repo, "stash", "push", "-q", "-m", "keep-me");
    await put(repo, { "a.txt": "staged version\n" });
    await g(repo, "add", "a.txt");
    await put(repo, {
      "a.txt": "unstaged version\n",
      "u.txt": "untracked\n",
      "x.log": "ignored\n",
    });

    const before = await repoState(repo);
    const stagedBefore = await g(repo, "ls-files", "-s");
    const wtBefore = await readFile(join(repo, "a.txt"), "utf8");

    const snap = await snapshotBase(repo);
    expect(snap.dirtySnapshot).toBe(true);

    expect(await repoState(repo)).toEqual(before);
    expect(await g(repo, "ls-files", "-s")).toBe(stagedBefore);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe(wtBefore);
    expect(await g(repo, "stash", "list")).toContain("keep-me");
    // The snapshot captured the working-tree (unstaged) content, untracked file included.
    expect(await g(repo, "show", `${snap.baseRef}:a.txt`)).toBe("unstaged version\n");
    expect(await g(repo, "show", `${snap.baseRef}:u.txt`)).toBe("untracked\n");
  });

  it("works when no git identity is configured", async () => {
    const repo = await makeRepo(dirs);
    await g(repo, "config", "--unset", "user.name");
    await g(repo, "config", "--unset", "user.email");
    await put(repo, { "a.txt": "x\n" });
    expect((await snapshotBase(repo)).dirtySnapshot).toBe(true);
  });

  it("rejects a repository without commits", async () => {
    const dir = await tmp(dirs);
    await g(dir, "init", "-q");
    await expect(snapshotBase(dir)).rejects.toBeInstanceOf(DispatchError);
  });
});

describe("git helpers", () => {
  it("detects dirtiness, submodules, lfs and lists worktrees", async () => {
    const repo = await makeRepo(dirs);
    expect(await gitx.repoRoot(repo)).toBe(repo);
    expect(await gitx.repoRoot(await tmp(dirs))).toBeNull();
    expect(await gitx.isDirty(repo)).toBe(false);
    await put(repo, { "n.txt": "n\n" });
    expect(await gitx.isDirty(repo)).toBe(true);
    expect(await gitx.hasSubmodules(repo)).toBe(false);
    expect(await gitx.usesLfs(repo)).toBe(false);
    await put(repo, { ".git/info/attributes": "*.bin filter=lfs\n" });
    expect(await gitx.usesLfs(repo)).toBe(true);
    expect(await gitx.worktreeList(repo)).toEqual([repo]);
    await expect(gitx.git(repo, ["no-such-subcommand"])).rejects.toThrow(/git.*failed/);
  });
});

describe("WorktreeSandbox.create [UC13]", () => {
  it("clean repo: detached worktree at HEAD under <home>/worktrees/<hash>/<runId>", async () => {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    const h = await create(repo, home, "run-1");

    const common = await realpath(join(repo, ".git"));
    const hash = createHash("sha256").update(common).digest("hex").slice(0, 12);
    expect(h.path).toBe(join(home, "worktrees", hash, "run-1"));
    expect(h.baseRef).toBe((await g(repo, "rev-parse", "HEAD")).trim());
    expect(h.dirtySnapshot).toBe(false);
    expect(h.readOnlyReason).toBeUndefined();
    expect(h.bootstrapped).toEqual([]);
    expect(await readFile(join(h.path, "a.txt"), "utf8")).toBe("one\n");
    expect((await g(h.path, "rev-parse", "HEAD")).trim()).toBe(h.baseRef);
    expect((await g(h.path, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("HEAD"); // detached
  });

  it("dirty repo: worktree has modified + untracked files, not ignored ones; user tree intact", async () => {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    await put(repo, { "a.txt": "edited\n", "fresh.txt": "fresh\n", "d.log": "ignored\n" });
    const before = await repoState(repo);

    const h = await create(repo, home, "run-d");
    expect(h.dirtySnapshot).toBe(true);
    expect(await readFile(join(h.path, "a.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(join(h.path, "fresh.txt"), "utf8")).toBe("fresh\n");
    expect(existsSync(join(h.path, "d.log"))).toBe(false);
    expect(await repoState(repo)).toEqual(before);
    expect(await g(repo, "stash", "list")).toBe("");
  });

  it("refuses to reuse an existing run path", async () => {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    await create(repo, home, "dup");
    await expect(create(repo, home, "dup")).rejects.toThrow(/already exists/);
  });

  it("non-git directory: no worktree, read-only, original path", async () => {
    const dir = await tmp(dirs);
    await put(dir, { "f.txt": "x" });
    const home = await tmp(dirs);
    const h = await create(dir, home, "ng");
    expect(h).toMatchObject({ path: dir, readOnlyReason: "not-git", dirtySnapshot: false });
    expect(existsSync(join(home, "worktrees"))).toBe(false);
    await sandbox.dispose(h.path, false);
    expect(existsSync(join(dir, "f.txt"))).toBe(true); // never deletes the user's directory
  });

  it("submodules force read-only", async () => {
    const repo = await makeRepo(dirs, {
      ".gitmodules": '[submodule "s"]\n\tpath = s\n\turl = ./s\n',
    });
    const h = await create(repo, await tmp(dirs), "sm");
    expect(h.readOnlyReason).toBe("submodules");
  });

  it("a real submodule is detected via git submodule status", async () => {
    const lib = await makeRepo(dirs);
    const repo = await makeRepo(dirs);
    await g(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
    await g(repo, "commit", "-q", "-m", "add submodule");
    expect(await gitx.hasSubmodules(repo)).toBe(true);
    expect((await create(repo, await tmp(dirs), "sm2")).readOnlyReason).toBe("submodules");
  });

  it("LFS usage forces read-only", async () => {
    const repo = await makeRepo(dirs, {
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    });
    const h = await create(repo, await tmp(dirs), "lfs");
    expect(h.readOnlyReason).toBe("lfs");
  });

  it("two runs on the same repo can be created concurrently", async () => {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    await put(repo, { "dirty.txt": "d\n" });
    const hs = await Promise.all(["c1", "c2", "c3", "c4"].map((id) => create(repo, home, id)));
    expect(new Set(hs.map((h) => h.path)).size).toBe(4);
    for (const h of hs) expect(await readFile(join(h.path, "dirty.txt"), "utf8")).toBe("d\n");
    expect((await gitx.worktreeList(repo)).length).toBe(5);
  });
});

describe("bootstrap symlink-readonly [UC13]", () => {
  it("links only ignored, untracked, existing paths", async () => {
    const repo = await makeRepo(dirs, { "src/x.ts": "x\n", "forced.log": "tracked but ignored\n" });
    await g(repo, "add", "-f", "forced.log");
    await g(repo, "commit", "-q", "-m", "force");
    await put(repo, {
      "node_modules/pkg/index.js": "module\n",
      "packages/app/node_modules/dep/i.js": "dep\n",
    });
    const home = await tmp(dirs);
    const h = await sandbox.create({
      ...base,
      repoPath: repo,
      runId: "bs",
      dispatchHome: home,
      bootstrap: {
        mode: "symlink-readonly",
        paths: [
          "node_modules",
          "packages/app/node_modules",
          "src",
          "forced.log",
          "missing",
          "a.txt",
        ],
      },
    });
    expect(h.bootstrapped.sort()).toEqual(["node_modules", "packages/app/node_modules"]);
    expect((await lstat(join(h.path, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(h.path, "node_modules"))).toBe(join(repo, "node_modules"));
    expect(await readFile(join(h.path, "packages/app/node_modules/dep/i.js"), "utf8")).toBe(
      "dep\n",
    );
    // Tracked files stay real files from the base, not links to the user's checkout.
    expect((await lstat(join(h.path, "src/x.ts"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(h.path, "forced.log"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(h.path, "a.txt"))).isSymbolicLink()).toBe(false);
    expect(existsSync(join(h.path, "missing"))).toBe(false);
  });

  it("mode none links nothing", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { "node_modules/p.js": "p\n" });
    const h = await sandbox.create({
      ...base,
      repoPath: repo,
      runId: "none",
      dispatchHome: await tmp(dirs),
      bootstrap: { mode: "none", paths: ["node_modules"] },
    });
    expect(h.bootstrapped).toEqual([]);
    expect(existsSync(join(h.path, "node_modules"))).toBe(false);
  });

  it("rejects absolute and escaping paths and cleans up the worktree", async () => {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    for (const bad of ["../escape", "/etc", "."]) {
      await expect(
        sandbox.create({
          ...base,
          repoPath: repo,
          runId: "bad",
          dispatchHome: home,
          bootstrap: { mode: "symlink-readonly", paths: [bad] },
        }),
      ).rejects.toThrow(/bootstrap path/);
      expect(await gitx.worktreeList(repo)).toEqual([repo]);
    }
  });
});

describe("dispose [UC13]", () => {
  it("keep=true leaves the worktree; keep=false removes it and keeps symlink targets", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { "node_modules/p.js": "p\n" });
    const home = await tmp(dirs);
    const h = await sandbox.create({
      ...base,
      repoPath: repo,
      runId: "dsp",
      dispatchHome: home,
      bootstrap: { mode: "symlink-readonly", paths: ["node_modules"] },
    });
    await put(h.path, { "scratch.txt": "uncommitted work\n" });

    await sandbox.dispose(h.path, true);
    expect(existsSync(h.path)).toBe(true);
    expect(await gitx.worktreeList(repo)).toContain(h.path);

    await sandbox.dispose(h.path, false);
    expect(existsSync(h.path)).toBe(false);
    expect(await gitx.worktreeList(repo)).toEqual([repo]);
    expect(await readFile(join(repo, "node_modules/p.js"), "utf8")).toBe("p\n");
    await sandbox.dispose(h.path, false); // idempotent
  });
});

describe("gc [UC13]", () => {
  const HOUR = 3_600_000;

  async function three() {
    const repo = await makeRepo(dirs);
    const home = await tmp(dirs);
    const hs = [
      await create(repo, home, "r1"),
      await create(repo, home, "r2"),
      await create(repo, home, "r3"),
    ];
    return { repo, home, hs };
  }

  it("removes only terminal runs", async () => {
    const { repo, home, hs } = await three();
    const removed = await sandbox.gc({
      dispatchHome: home,
      isTerminal: (id) => id !== "r2",
      olderThanMs: 0,
      now: Date.now() + 1000,
    });
    expect(removed.sort()).toEqual([hs[0]?.path, hs[2]?.path].sort());
    expect(existsSync(hs[1]?.path ?? "")).toBe(true);
    expect(await gitx.worktreeList(repo)).toEqual([repo, hs[1]?.path]);
  });

  it("keeps worktrees younger than olderThanMs, reaps the rest and empty repo dirs", async () => {
    const { repo, home, hs } = await three();
    const young = await sandbox.gc({
      dispatchHome: home,
      isTerminal: async () => true,
      olderThanMs: HOUR,
      now: Date.now(),
    });
    expect(young).toEqual([]);
    const old = new Date(Date.now() - 2 * HOUR);
    await utimes(hs[0]?.path ?? "", old, old);
    const removed = await sandbox.gc({
      dispatchHome: home,
      isTerminal: () => true,
      olderThanMs: HOUR,
      now: Date.now(),
    });
    expect(removed).toEqual([hs[0]?.path]);
    const rest = await sandbox.gc({
      dispatchHome: home,
      isTerminal: () => true,
      olderThanMs: HOUR,
      now: Date.now() + 3 * HOUR,
    });
    expect(rest.length).toBe(2);
    expect(await gitx.worktreeList(repo)).toEqual([repo]);
    expect(await stat(join(home, "worktrees")).then((s) => s.isDirectory())).toBe(true);
    expect(existsSync(join(hs[0]?.path ?? "", ".."))).toBe(false);
  });

  it("reclaims worktrees whose repository is gone and ignores stray files", async () => {
    const { repo, home, hs } = await three();
    await rm(repo, { recursive: true, force: true });
    await put(home, { "worktrees/README": "not a dir" });
    await mkdir(join(home, "worktrees", "deadbeef0000", "orphan"), { recursive: true });
    const removed = await sandbox.gc({
      dispatchHome: home,
      isTerminal: () => true,
      olderThanMs: 0,
      now: Date.now() + 1000,
    });
    expect(removed.length).toBe(4);
    for (const h of hs) expect(existsSync(h.path)).toBe(false);
  });

  it("is a no-op when nothing was ever created", async () => {
    const home = await tmp(dirs);
    expect(
      await sandbox.gc({ dispatchHome: home, isTerminal: () => true, olderThanMs: 0, now: 0 }),
    ).toEqual([]);
  });

  it("prunes dangling records of worktrees deleted behind git's back", async () => {
    const { repo, home, hs } = await three();
    await rm(hs[0]?.path ?? "", { recursive: true, force: true });
    await sandbox.gc({
      dispatchHome: home,
      isTerminal: () => true,
      olderThanMs: 0,
      now: Date.now() + 1000,
    });
    expect(await gitx.worktreeList(repo)).toEqual([repo]);
  });
});

describe("misc", () => {
  it("a symlinked repoPath resolves to the real repo", async () => {
    const repo = await makeRepo(dirs);
    const holder = await tmp(dirs);
    await symlink(repo, join(holder, "link"));
    const h = await create(join(holder, "link"), await tmp(dirs), "sl");
    expect(await readFile(join(h.path, "a.txt"), "utf8")).toBe("one\n");
  });
});
