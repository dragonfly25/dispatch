import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFakeShimsInstalled,
  assertNoRealCli,
  createFakes,
  FAKE_CLIS,
  FAKES_BIN,
  resolveOnPath,
  snapshotTree,
  tempHome,
  tempRepo,
  treeHash,
  withFakes,
} from "../support/index.js";

describe("real-CLI guard [AC1]", () => {
  it("[AC1] the committed shims exist and are executable", () => {
    expect(() => assertFakeShimsInstalled()).not.toThrow();
    if (process.platform === "win32") return; // no exec bit; the .cmd extension makes it runnable
    for (const cli of FAKE_CLIS) expect(statSync(join(FAKES_BIN, cli)).mode & 0o111).not.toBe(0);
  });

  it("[AC1] withFakes env resolves claude, codex and agy to test/fakes/bin only", async () => {
    await withFakes({}, ({ env }) => {
      for (const cli of FAKE_CLIS)
        expect(resolveOnPath(cli, env.PATH)).toContain("dispatch-fakes-");
      expect(() => assertNoRealCli(env)).not.toThrow();
      expect(env.HOME).toBeUndefined(); // the real HOME never leaks into the code under test
    });
  });

  // POSIX layout (sh decoys, exec bit); the Windows layout is covered in "Windows fake layout".
  it.skipIf(process.platform === "win32")(
    "[AC1] assertNoRealCli throws when a real or foreign CLI would be picked",
    async () => {
      await withFakes({}, ({ env, stateDir }) => {
        expect(() => assertNoRealCli({ PATH: "/usr/bin:/bin" })).toThrow(/not on PATH|resolves to/);
        const decoyDir = join(stateDir, "decoy");
        mkdirSync(decoyDir);
        writeFileSync(join(decoyDir, "claude"), "#!/bin/sh\necho real\n");
        chmodSync(join(decoyDir, "claude"), 0o755);
        const path = `${decoyDir}:${env.PATH}`;
        expect(() => assertNoRealCli({ PATH: path })).toThrow(/claude: resolves to/);
        symlinkSync(join(decoyDir, "claude"), join(decoyDir, "codex"));
        expect(() => assertNoRealCli({ PATH: `${decoyDir}:${env.PATH}` })).toThrow(
          /codex: resolves to/,
        );
      });
    },
  );

  it("[AC1] createFakes/dispose manage the lifecycle manually and options extend env", () => {
    const fakes = createFakes({}, { env: { EXTRA: "1" } });
    expect(fakes.env.EXTRA).toBe("1");
    expect(existsSync(fakes.logPath)).toBe(true);
    fakes.dispose();
    expect(existsSync(fakes.binDir)).toBe(false);
    fakes.dispose();
    const inherited = createFakes({}, { inheritEnv: true });
    expect(inherited.env.PATH?.startsWith(inherited.binDir)).toBe(true);
    inherited.dispose();
  });
});

describe("tempHome / tempRepo [AC1]", () => {
  it("[AC1] tempHome points HOME and DISPATCH_HOME at a throwaway directory", () => {
    const h = tempHome();
    expect(h.env.HOME).toBe(h.home);
    expect(h.env.DISPATCH_HOME).toBe(join(h.home, ".dispatch"));
    expect(h.home.startsWith(homedir())).toBe(false);
    expect(existsSync(h.home)).toBe(true);
    h.cleanup();
    expect(existsSync(h.home)).toBe(false);
  });

  it("[AC1] tempRepo creates a committed repo with a local identity", () => {
    const repo = tempRepo({
      files: {
        "src/a.txt": "a",
        "bin/run.sh": { content: "#!/bin/sh\n", mode: 0o755 },
        link: { symlink: "src/a.txt" },
        "bin.dat": new Uint8Array([1, 2, 3]),
      },
      message: "seed",
    });
    expect(repo.git("log", "-1", "--format=%s")).toBe("seed");
    expect(repo.git("log", "-1", "--format=%ae")).toBe("test@example.invalid");
    expect(repo.git("branch", "--show-current")).toBe("main");
    expect(repo.git("status", "--porcelain")).toBe("");
    if (process.platform !== "win32") {
      expect(statSync(join(repo.dir, "bin/run.sh")).mode & 0o111).not.toBe(0);
    }
    repo.write("new.txt", "n");
    expect(repo.git("status", "--porcelain")).toBe("?? new.txt");
    expect(repo.commitAll("second")).toMatch(/^[0-9a-f]{40}$/);
    repo.cleanup();
    expect(existsSync(repo.dir)).toBe(false);
  });

  it("[AC1] tempRepo can skip the commit and pick a branch", () => {
    const repo = tempRepo({ commit: false, branch: "trunk" });
    expect(repo.git("symbolic-ref", "--short", "HEAD")).toBe("trunk");
    expect(() => repo.git("rev-parse", "HEAD")).toThrow();
    expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toContain("fixture repo");
    repo.cleanup();
  });
});

describe("snapshotTree / treeHash [AC1]", () => {
  // POSIX permission bits (Windows reports 0o666/0o444 only).
  it.skipIf(process.platform === "win32")(
    "[AC1] records sha256, mode, symlink targets and empty dirs, skipping .git/objects",
    () => {
      const repo = tempRepo({
        files: { "a.txt": "a", "sub/b.sh": { content: "b", mode: 0o755 }, l: { symlink: "a.txt" } },
      });
      mkdirSync(join(repo.dir, "empty"));
      const snap = snapshotTree(repo.dir);
      expect(snap["a.txt"]).toMatchObject({ type: "file", mode: 0o644 });
      expect(snap["a.txt"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(snap["sub/b.sh"]?.mode).toBe(0o755);
      expect(snap.l).toEqual({ type: "symlink", target: "a.txt" });
      expect(snap.empty?.type).toBe("dir");
      expect(snap[".git/HEAD"]?.type).toBe("file");
      expect(Object.keys(snap).some((k) => k.startsWith(".git/objects"))).toBe(false);
      expect(Object.keys(snapshotTree(repo.dir, { exclude: [/^\.git/, "sub"] })).sort()).toEqual([
        "a.txt",
        "empty",
        "l",
      ]);
      repo.cleanup();
    },
  );

  it("[AC1] treeHash is stable across read-only git commands and changes on any edit", () => {
    const repo = tempRepo();
    const before = treeHash(repo.dir);
    repo.git("status");
    repo.git("log");
    expect(treeHash(repo.dir)).toBe(before);
    writeFileSync(join(repo.dir, ".git/info/exclude"), "x\n", { flag: "a" });
    const afterExclude = treeHash(repo.dir);
    expect(afterExclude).not.toBe(before);
    mkdirSync(join(repo.dir, ".dispatch"));
    expect(treeHash(repo.dir)).not.toBe(afterExclude);
    chmodSync(join(repo.dir, "README.md"), 0o755);
    expect(treeHash(repo.dir)).not.toBe(afterExclude);
    expect(treeHash(repo.dir, { exclude: [".git", ".dispatch", "README.md"] })).toBe(
      treeHash(repo.dir, { exclude: [".git", ".dispatch", "README.md"] }),
    );
    expect(execFileSync("git", ["--version"]).toString()).toMatch(/git version/);
    repo.cleanup();
  });
});
