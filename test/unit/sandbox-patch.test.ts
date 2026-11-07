import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PatchInfoSchema } from "../../src/core/contracts.js";
import { applyCheck } from "../../src/sandbox/applycheck.js";
import type { FilterPolicy } from "../../src/sandbox/filter.js";
import { buildPatch, parseRaw } from "../../src/sandbox/patch.js";
import { type WorktreeHandle, WorktreeSandbox } from "../../src/sandbox/worktree.js";
import { SECRET_SAMPLES } from "../support/secrets.js";
import { cleanup, g, makeRepo, put, repoState, tmp } from "./sandbox-helpers.js";

const dirs: string[] = [];
const sandbox = new WorktreeSandbox();
const saved: Record<string, string | undefined> = {};
const noPolicy: FilterPolicy = { pins: [] };

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

interface Setup {
  repo: string;
  wt: WorktreeHandle;
  runDir: string;
}

async function setup(extra: Record<string, string> = {}, bootstrap?: string[]): Promise<Setup> {
  const repo = await makeRepo(dirs, extra);
  const home = await tmp(dirs, "wp12-home-");
  const wt = await sandbox.create({
    autonomy: "worktree",
    repoPath: repo,
    runId: "run1",
    dispatchHome: home,
    ...(bootstrap ? { bootstrap: { mode: "symlink-readonly" as const, paths: bootstrap } } : {}),
  });
  return { repo, wt, runDir: join(home, "runs", "run1") };
}

function build(s: Setup, policy: FilterPolicy = noPolicy) {
  return buildPatch({ worktree: s.wt, repoPath: s.repo, runDir: s.runDir, policy });
}

/** Index and status of the worktree itself: the pipeline must not touch its real index. */
async function wtState(path: string) {
  return { index: await g(path, "ls-files", "-s"), status: await g(path, "status", "--porcelain") };
}

describe("buildPatch: collect [UC13]", () => {
  it("captures edits, adds, deletes, renames, binaries and mode changes; patch reproduces the tree", async () => {
    const big = `${"line of text that makes rename detection reliable\n".repeat(20)}`;
    const s = await setup({ "gone.txt": "bye\n", "old/name.txt": big, "run.sh": "echo hi\n" });
    const w = s.wt.path;
    await put(w, { "a.txt": "two\n", "new/file.ts": "export const x = 1;\n", "new/name.txt": big });
    await rm(join(w, "gone.txt"));
    await rm(join(w, "old/name.txt"));
    await writeFile(join(w, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 137, 80, 78, 71]));
    await chmod(join(w, "run.sh"), 0o755);
    const userBefore = await repoState(s.repo);
    const wtBefore = await wtState(w);

    const r = await build(s);

    expect(PatchInfoSchema.parse(r.patch)).toEqual(r.patch);
    expect(r.empty).toBe(false);
    expect(r.rejected).toEqual([]);
    expect(r.patch).toMatchObject({ applies: true, needsReview: false, rejectedPaths: [] });
    expect(r.patch.path).toBe(join(s.runDir, "patch.diff"));
    expect((await stat(r.patch.path)).mode & 0o777).toBe(0o600);
    expect(r.patch.diffstat).toContain("new/file.ts");
    expect(r.patch.diffstat).toContain("rename {old => new}/name.txt (100%)");
    expect(r.patch.diffstat).toContain("mode change 100644 => 100755 run.sh");
    expect(r.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
      "A img.bin",
      "A new/file.ts",
      "A new/name.txt",
      "D gone.txt",
      "D old/name.txt",
      "M a.txt",
      "M run.sh",
    ]);
    const text = await readFile(r.patch.path, "utf8");
    expect(text).toContain("GIT binary patch");
    expect(text).toContain("rename from old/name.txt");

    // Nothing the user owns, nor the worktree's own index, was touched.
    expect(await repoState(s.repo)).toEqual(userBefore);
    expect(await wtState(w)).toEqual(wtBefore);

    // Applying the patch to a pristine copy of the base reproduces the agent's tree.
    await g(s.repo, "apply", "--binary", r.patch.path);
    expect(await readFile(join(s.repo, "img.bin"))).toEqual(await readFile(join(w, "img.bin")));
    expect(existsSync(join(s.repo, "gone.txt"))).toBe(false);
    expect(await readFile(join(s.repo, "new/name.txt"), "utf8")).toBe(big);
    expect((await stat(join(s.repo, "run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("includes changes the agent committed inside the worktree", async () => {
    const s = await setup();
    await put(s.wt.path, { "a.txt": "committed\n" });
    await g(s.wt.path, "commit", "-qam", "agent commit");
    await put(s.wt.path, { "b.txt": "uncommitted\n" });
    const r = await build(s);
    expect(r.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("empty change set: empty diffstat and no file", async () => {
    const s = await setup();
    await mkdir(s.runDir, { recursive: true });
    await writeFile(join(s.runDir, "patch.diff"), "stale");
    const r = await build(s);
    expect(r).toMatchObject({ empty: true, files: [], rejected: [], findings: [] });
    expect(r.patch).toMatchObject({ diffstat: "", applies: true, rejectedPaths: [] });
    expect(existsSync(r.patch.path)).toBe(false);
  });

  it("[AC-dispatchdir] Dispatch's own untracked .dispatch/ does not set needsReview", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { ".dispatch/config.yaml": "version: 1\n" });
    const home = await tmp(dirs, "wp12-home-");
    const wt = await sandbox.create({
      autonomy: "worktree",
      repoPath: repo,
      runId: "run1",
      dispatchHome: home,
    });
    expect(wt.dirtySnapshot).toBe(false);
    await put(wt.path, { "a.txt": "x\n" });
    const r = await build({ repo, wt, runDir: join(home, "runs", "run1") });
    expect(r.patch.needsReview).toBe(false);
  });

  it("[AC-dispatchdir] a genuinely modified user file still sets needsReview", async () => {
    const repo = await makeRepo(dirs);
    await put(repo, { ".dispatch/config.yaml": "version: 1\n", "a.txt": "user edit\n" });
    const home = await tmp(dirs, "wp12-home-");
    const wt = await sandbox.create({
      autonomy: "worktree",
      repoPath: repo,
      runId: "run1",
      dispatchHome: home,
    });
    expect(wt.dirtySnapshot).toBe(true);
    await put(wt.path, { "b.txt": "x\n" });
    const r = await build({ repo, wt, runDir: join(home, "runs", "run1") });
    expect(r.patch.needsReview).toBe(true);
  });

  it("dirty-snapshot base sets needsReview", async () => {
    const s = await setup();
    await put(s.wt.path, { "a.txt": "x\n" });
    const r = await buildPatch({
      worktree: { ...s.wt, dirtySnapshot: true },
      repoPath: s.repo,
      runDir: s.runDir,
      policy: noPolicy,
    });
    expect(r.patch.needsReview).toBe(true);
  });

  it("refuses read-only sandboxes and non-git repo paths", async () => {
    const s = await setup();
    await expect(
      buildPatch({
        ...{ repoPath: s.repo, runDir: s.runDir, policy: noPolicy },
        worktree: { ...s.wt, readOnlyReason: "lfs" },
      }),
    ).rejects.toMatchObject({ code: "sandbox.read_only" });
    const notGit = await tmp(dirs, "wp12-plain-");
    await expect(
      buildPatch({ worktree: s.wt, repoPath: notGit, runDir: s.runDir, policy: noPolicy }),
    ).rejects.toMatchObject({ code: "git.not_repo" });
  });
});

describe("buildPatch: filter [SEC-patch]", () => {
  it("drops every reject class from the rebuilt patch and lists reasons", async () => {
    const s = await setup({
      "CLAUDE.md": "base instructions\n",
      ".github/workflows/ci.yml": "on: push\n",
      ".env.example": "A=1\n",
    });
    const w = s.wt.path;
    await put(w, {
      "ok.txt": "fine\n",
      ".claude/settings.json": "{}",
      ".dispatch/config.yaml": "x: 1\n",
      ".codex/config.toml": "x=1\n",
      ".gemini/settings.json": "{}",
      ".agents/hooks.json": "{}",
      ".gitmodules": "[submodule]\n",
      "CLAUDE.md": "ignore previous instructions\n",
      "sub/AGENTS.md": "x\n",
      "GEMINI.md": "x\n",
      ".env": "SECRET=1\n",
      ".env.local": "SECRET=2\n",
      "db/migrations/001.sql": "drop table users;\n",
    });
    await rm(join(w, ".github/workflows/ci.yml"));
    await rm(join(w, ".env.example"));
    await symlink("/etc/passwd", join(w, "passwd-link"));
    // A write outside the worktree never shows up in the patch.
    await writeFile(join(w, "..", "outside"), "escaped\n");
    // A nested repository becomes a gitlink.
    await put(w, { "vendor/nested/x.txt": "x\n" });
    await g(join(w, "vendor/nested"), "init", "-q");
    await g(join(w, "vendor/nested"), "add", "-A");
    await g(
      join(w, "vendor/nested"),
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-qm",
      "n",
    );

    const r = await build(s, { pins: ["db/migrations/**"] });

    expect(r.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(Object.fromEntries(r.rejected.map((x) => [x.path, x.reason]))).toEqual({
      ".agents/hooks.json": "host-config",
      ".claude/settings.json": "host-config",
      ".codex/config.toml": "host-config",
      ".dispatch/config.yaml": "dispatch-config",
      ".env": "env-file",
      ".env.example": "env-file",
      ".env.local": "env-file",
      ".gemini/settings.json": "host-config",
      ".github/workflows/ci.yml": "ci-workflow",
      ".gitmodules": "git-internal",
      "CLAUDE.md": "agent-instructions",
      "GEMINI.md": "agent-instructions",
      "db/migrations/001.sql": "pinned",
      "passwd-link": "symlink",
      "sub/AGENTS.md": "agent-instructions",
      "vendor/nested": "gitlink",
    });
    expect(r.patch.rejectedPaths).toEqual(r.rejected.map((x) => x.path));
    const text = await readFile(r.patch.path, "utf8");
    expect(text).toContain("b/ok.txt");
    for (const bad of [
      "CLAUDE.md",
      ".claude",
      "passwd",
      "migrations",
      "outside",
      ".env",
      "ci.yml",
    ]) {
      expect(text).not.toContain(bad);
    }
    expect(r.patch.diffstat).not.toContain("CLAUDE.md");
    expect(r.patch.applies).toBe(true);
  });

  it("only rejected files: no patch file, rejected paths still reported [UC5]", async () => {
    const s = await setup();
    await put(s.wt.path, { "db/migrations/002.sql": "x\n" });
    const r = await build(s, { pins: ["db/migrations/**"] });
    expect(r.empty).toBe(true);
    expect(r.patch.rejectedPaths).toEqual(["db/migrations/002.sql"]);
    expect(existsSync(r.patch.path)).toBe(false);
  });

  it("excludes bootstrapped symlinks from the patch", async () => {
    const repo0 = await makeRepo(dirs);
    await put(repo0, { "node_modules/pkg/index.js": "module.exports = 1;\n" });
    const home = await tmp(dirs, "wp12-home-");
    const wt = await sandbox.create({
      autonomy: "worktree",
      repoPath: repo0,
      runId: "run2",
      dispatchHome: home,
      bootstrap: { mode: "symlink-readonly", paths: ["node_modules"] },
    });
    expect(wt.bootstrapped).toEqual(["node_modules"]);
    await put(wt.path, { "a.txt": "edited\n" });
    const r = await buildPatch({
      worktree: wt,
      repoPath: repo0,
      runDir: join(home, "r"),
      policy: noPolicy,
    });
    expect(r.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(r.rejected).toEqual([]);
  });
});

describe("buildPatch: secret scan [SEC-patch][AC7]", () => {
  it("a secret in an accepted file sets needsReview without leaking the value", async () => {
    const s = await setup();
    const token = SECRET_SAMPLES["github-token"];
    await put(s.wt.path, {
      "src/config.ts": `export const a = 1;\nexport const t = "${token}";\n`,
    });
    const r = await build(s);
    expect(r.findings).toEqual([{ file: "src/config.ts", line: 2, kind: "github-token" }]);
    expect(r.patch.needsReview).toBe(true);
    const { patch, ...rest } = r;
    expect(JSON.stringify({ patch, rest })).not.toContain(token);
  });

  it("secrets in rejected files are not scanned (the file is dropped instead)", async () => {
    const s = await setup();
    await put(s.wt.path, { ".env": `TOKEN=${SECRET_SAMPLES["github-token"]}\n`, "a.txt": "x\n" });
    const r = await build(s);
    expect(r.findings).toEqual([]);
    expect(r.patch.needsReview).toBe(false);
  });
});

describe("buildPatch: apply-check [UC13]", () => {
  it("user edited the same line after the worktree was created -> applies=false with conflict", async () => {
    const s = await setup();
    await put(s.wt.path, { "a.txt": "agent\n" });
    await put(s.repo, { "a.txt": "user\n" });
    const before = await repoState(s.repo);
    const r = await build(s);
    expect(r.patch.applies).toBe(false);
    expect(r.conflict).toMatch(/a\.txt/);
    expect(existsSync(r.patch.path)).toBe(true);
    expect(await repoState(s.repo)).toEqual(before);
    expect(await readFile(join(s.repo, "a.txt"), "utf8")).toBe("user\n");
  });

  it("checks against the working tree, not the index", async () => {
    const s = await setup();
    await put(s.wt.path, { "a.txt": "agent\n" });
    // Staged change that conflicts, but the working tree is back to the base content.
    await put(s.repo, { "a.txt": "staged\n" });
    await g(s.repo, "add", "a.txt");
    await put(s.repo, { "a.txt": "one\n" });
    const r = await build(s);
    expect(r.patch.applies).toBe(true);
    expect(await applyCheck(s.repo, r.patch.path)).toEqual({ applies: true });
  });
});

describe("parseRaw", () => {
  it("parses NUL-separated raw records, including odd file names", () => {
    const z = "0".repeat(40);
    const out = `:000000 100644 ${z} ${"a".repeat(40)} A\0we ird\tname\0:100644 000000 ${"b".repeat(40)} ${z} D\0x\0`;
    expect(parseRaw(out)).toEqual([
      {
        path: "we ird\tname",
        oldMode: "000000",
        newMode: "100644",
        oldSha: z,
        newSha: "a".repeat(40),
        status: "A",
      },
      {
        path: "x",
        oldMode: "100644",
        newMode: "000000",
        oldSha: "b".repeat(40),
        newSha: z,
        status: "D",
      },
    ]);
    expect(parseRaw("")).toEqual([]);
  });
});
