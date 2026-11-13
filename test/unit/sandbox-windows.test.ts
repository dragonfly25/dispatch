/**
 * Windows rules of the worktree sandbox: junction bootstrap, refusal of file entries, and link
 * removal before any recursive delete. Runs on every OS with `platform: "win32"` injected (Node
 * ignores the "junction" type off Windows and makes a plain symlink, which lstat reports the same
 * way as a junction on Windows), plus a real-junction test on Windows.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as gitx from "../../src/sandbox/git.js";
import {
  bootstrapLinkType,
  type SandboxFs,
  safeBootstrapRel,
  unlinkLinksBelow,
  WorktreeSandbox,
} from "../../src/sandbox/worktree.js";
import { cleanup, makeRepo, put, tmp } from "./sandbox-helpers.js";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
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

describe("bootstrap helpers on Windows", () => {
  it("directories become junctions; files are refused; POSIX uses plain symlinks", () => {
    expect(bootstrapLinkType("node_modules", true, "win32")).toBe("junction");
    expect(() => bootstrapLinkType(".env", false, "win32")).toThrow(/only directories/);
    expect(bootstrapLinkType(".env", false, "linux")).toBeUndefined();
    expect(bootstrapLinkType("node_modules", true, "darwin")).toBeUndefined();
  });

  it("bootstrap paths: backslashes accepted, drive-relative and escaping paths refused", () => {
    expect(safeBootstrapRel("packages\\app\\node_modules\\", "win32")).toBe(
      "packages/app/node_modules",
    );
    for (const bad of ["C:node_modules", "C:\\x", "\\\\srv\\share", "..\\up", "."]) {
      expect(() => safeBootstrapRel(bad, "win32")).toThrow(/bootstrap path/);
    }
    expect(safeBootstrapRel("C:node_modules", "linux")).toBe("C:node_modules");
    expect(safeBootstrapRel("a\\b", "linux")).toBe("a\\b");
  });
});

/** An in-memory tree: dirs, files and links (a link's target is never listed). */
function memFs(tree: Record<string, "dir" | "file" | "link">, fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const kind = (p: string) => tree[p];
  const fs: SandboxFs = {
    lstat: async (p) => {
      const k = kind(p);
      if (!k) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => k === "link", isDirectory: () => k === "dir" };
    },
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    symlink: async () => {},
    mkdir: async () => undefined,
    readdir: async (p) => {
      calls.push(`readdir ${p}`);
      if (kind(p) !== "dir") throw new Error(`readdir of non-directory ${p}`);
      const prefix = `${p}/`;
      return Object.keys(tree)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
    },
    unlink: async (p) => {
      calls.push(`unlink ${p}`);
      if (fail.has(`unlink ${p}`)) throw new Error("EPERM");
      delete tree[p];
    },
    rmdir: async (p) => {
      calls.push(`rmdir ${p}`);
      if (fail.has(`rmdir ${p}`)) throw new Error("EPERM");
      delete tree[p];
    },
    rm: async (p) => {
      calls.push(`rm ${p}`);
    },
  };
  return { fs, calls, tree };
}

describe("unlinkLinksBelow", () => {
  it("removes links without descending into them, and recurses into real directories", async () => {
    const m = memFs({
      "/w": "dir",
      "/w/node_modules": "link",
      "/w/src": "dir",
      "/w/src/a.ts": "file",
      "/w/src/evil": "link",
    });
    await unlinkLinksBelow("/w", m.fs);
    expect(m.calls).toEqual([
      "readdir /w",
      "unlink /w/node_modules",
      "readdir /w/src",
      "unlink /w/src/evil",
    ]);
    expect(Object.keys(m.tree).sort()).toEqual(["/w", "/w/src", "/w/src/a.ts"]);
  });

  it("falls back to rmdir, and throws when a link cannot be removed at all", async () => {
    const one = memFs({ "/w": "dir", "/w/j": "link" }, new Set(["unlink /w/j"]));
    await unlinkLinksBelow("/w", one.fs);
    expect(one.calls).toContain("rmdir /w/j");
    const stuck = memFs({ "/w": "dir", "/w/j": "link" }, new Set(["unlink /w/j", "rmdir /w/j"]));
    await expect(unlinkLinksBelow("/w", stuck.fs)).rejects.toThrow(/EPERM/);
  });

  it("gc on Windows leaves a worktree alone when one of its links cannot be removed", async () => {
    const m = memFs(
      { "/h/worktrees": "dir", "/h/worktrees/abc": "dir", "/h/worktrees/abc/r1": "dir" },
      new Set(),
    );
    m.tree["/h/worktrees/abc/r1/j"] = "link";
    const failing = new Set(["unlink /h/worktrees/abc/r1/j", "rmdir /h/worktrees/abc/r1/j"]);
    const stuck = memFs(m.tree, failing);
    const sb = new WorktreeSandbox({ platform: "win32", fs: stuck.fs });
    const removed = await sb.gc({
      dispatchHome: "/h",
      isTerminal: () => true,
      olderThanMs: 0,
      now: 1,
    });
    expect(removed).toEqual([]);
    expect(stuck.calls.some((c) => c.startsWith("rm "))).toBe(false);
  });
});

describe("worktree sandbox with platform win32 (real git)", () => {
  it("links directories, refuses a file entry and cleans up, and dispose keeps link targets", async () => {
    const repo = await makeRepo(dirs, { ".gitignore": "node_modules/\n.env\n" });
    await put(repo, { "node_modules/p/index.js": "p\n", ".env": "SECRET=1\n" });
    const home = await tmp(dirs);
    const sb = new WorktreeSandbox({ platform: "win32" });

    await expect(
      sb.create({
        ...base,
        repoPath: repo,
        runId: "file",
        dispatchHome: home,
        bootstrap: { mode: "symlink-readonly", paths: ["node_modules", ".env"] },
      }),
    ).rejects.toMatchObject({ code: "sandbox.bootstrap_file" });
    expect(await gitx.worktreeList(repo)).toEqual([repo]);
    // The junction made before the refusal was unlinked, not followed, by the cleanup.
    expect(await readFile(join(repo, "node_modules/p/index.js"), "utf8")).toBe("p\n");

    const h = await sb.create({
      ...base,
      repoPath: repo,
      runId: "dir",
      dispatchHome: home,
      bootstrap: { mode: "symlink-readonly", paths: ["node_modules"] },
    });
    expect(h.bootstrapped).toEqual(["node_modules"]);
    expect((await lstat(join(h.path, "node_modules"))).isSymbolicLink()).toBe(true);
    // An agent-made link to the user's checkout must not be followed by the removal either.
    await symlink(join(repo, "node_modules"), join(h.path, "agent-link"));
    await sb.dispose(h.path, false);
    expect(existsSync(h.path)).toBe(false);
    expect(await readFile(join(repo, "node_modules/p/index.js"), "utf8")).toBe("p\n");
    expect(existsSync(join(repo, ".env"))).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("real junctions (Windows only)", () => {
  it("lstat reports a junction as a link and unlinkLinksBelow removes only the junction", async () => {
    const root = await tmp(dirs);
    await mkdir(join(root, "target"));
    await writeFile(join(root, "target", "keep.txt"), "keep\n");
    await mkdir(join(root, "wt"));
    await symlink(join(root, "target"), join(root, "wt", "j"), "junction");
    expect((await lstat(join(root, "wt", "j"))).isSymbolicLink()).toBe(true);
    await unlinkLinksBelow(join(root, "wt"));
    expect(existsSync(join(root, "wt", "j"))).toBe(false);
    expect(await readFile(join(root, "target", "keep.txt"), "utf8")).toBe("keep\n");
  });
});
