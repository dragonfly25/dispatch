import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadEffectiveConfig } from "../../../src/config/load.js";
import { checkTrust, findRepo, readPolicySet, trustRepo } from "../../../src/config/trust.js";
import { sandbox, writeFiles } from "./helpers.js";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const POLICY = {
  ".dispatch/config.yaml": "version: 1\nprofile: off\n",
  ".dispatch/profiles/team.yaml": "version: 1\nrules:\n  - id: t\n    action: { type: host }\n",
};

describe("findRepo", () => {
  it("returns null outside a git repository", () => {
    const sb = sandbox();
    expect(findRepo(sb.home)).toBeNull();
  });

  it("returns null for a malformed .git file", () => {
    const sb = sandbox();
    writeFiles(sb.root, { "bad/.git": "nonsense\n" });
    expect(findRepo(join(sb.root, "bad"))).toBeNull();
  });

  it("[SEC-trust] a linked worktree and a symlinked path resolve to the same identity", () => {
    const sb = sandbox();
    const main = sb.repo("main");
    mkdirSync(join(main, "src"));
    // Simulate `git worktree add ../wt`: .git file → gitdir → commondir.
    writeFiles(main, { ".git/worktrees/wt/commondir": "../..\n" });
    writeFiles(sb.root, { "wt/.git": `gitdir: ${join(main, ".git/worktrees/wt")}\n` });
    symlinkSync(main, join(sb.root, "link"));

    const id = findRepo(main)?.id;
    expect(id).toBe(join(main, ".git"));
    expect(findRepo(join(main, "src"))?.id).toBe(id);
    expect(findRepo(join(sb.root, "wt"))).toEqual({ worktreeRoot: join(sb.root, "wt"), id });
    expect(findRepo(join(sb.root, "link"))?.id).toBe(id);
  });

  it("handles a relative gitdir without commondir", () => {
    const sb = sandbox();
    mkdirSync(join(sb.root, "store.git"));
    writeFiles(sb.root, { "co/.git": "gitdir: ../store.git\n" });
    expect(findRepo(join(sb.root, "co"))?.id).toBe(join(sb.root, "store.git"));
  });
});

describe("[SEC-trust] policy set and hash", () => {
  it("is empty without .dispatch/ and stable for identical content", () => {
    const sb = sandbox();
    expect(readPolicySet(sb.repo("a")).files).toEqual([]);
    const a = readPolicySet(sb.repo("b", POLICY));
    const b = readPolicySet(sb.repo("c", POLICY));
    expect(a.hash).toBe(b.hash);
    expect(a.files.map((f) => f.rel)).toEqual([
      ".dispatch/config.yaml",
      ".dispatch/profiles/team.yaml",
    ]);
  });

  it("ignores non-yaml files, sub-directories and a .dispatch that is a plain file", () => {
    const sb = sandbox();
    const r = sb.repo("r", {
      ...POLICY,
      ".dispatch/profiles/notes.txt": "x",
      ".dispatch/state/x": "",
    });
    mkdirSync(join(r, ".dispatch/mappings/dir.yaml"), { recursive: true });
    expect(readPolicySet(r).files).toHaveLength(2);
    const plain = sb.repo("plain", { ".dispatch": "not a dir" });
    expect(readPolicySet(plain).files).toEqual([]);
  });

  // Windows: chmod 0 does not deny reading (ACLs decide); root ignores modes.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable policy file is an error, not an empty policy",
    () => {
      const sb = sandbox();
      const r = sb.repo("r", POLICY);
      chmodSync(join(r, ".dispatch/config.yaml"), 0);
      expect(() => readPolicySet(r)).toThrow(/cannot read/);
    },
  );

  it("a symlink anywhere in .dispatch/ (or .dispatch itself) is reported", () => {
    const sb = sandbox();
    const r = sb.repo("r", { ...POLICY, ".dispatch/state/deep/x": "" });
    symlinkSync("/etc/hosts", join(r, ".dispatch/state/deep/link"));
    expect(readPolicySet(r).symlink).toBe(".dispatch/state/deep/link");
    expect(readPolicySet(r).files).toEqual([]);

    const r2 = sb.repo("r2");
    symlinkSync(join(r, ".dispatch"), join(r2, ".dispatch"));
    expect(readPolicySet(r2).symlink).toBe(".dispatch");
  });
});

describe("[SEC-trust] trust lifecycle", () => {
  function trusted() {
    const sb = sandbox();
    sb.global("# my settings\nversion: 1 # keep\nautonomy: worktree\n");
    const repo = sb.repo("repo", POLICY);
    trustRepo({ cwd: repo, env: sb.env, now: NOW });
    const status = () => checkTrust(repo, loadTrusted(sb.dispatchHome));
    return { sb, repo, status };
  }

  it("writes trusted_repos preserving comments, and the repo becomes trusted", () => {
    const { sb, repo, status } = trusted();
    const text = readFileSync(join(sb.dispatchHome, "config.yaml"), "utf8");
    expect(text).toContain("# my settings");
    expect(text).toContain("version: 1 # keep");
    expect(text).toContain("trusted_at: 2026-11-07T10:00:00.000Z");
    expect(status().status).toBe("trusted");
    expect(loadEffectiveConfig({ cwd: repo, env: sb.env }).trusted).toBe(true);
  });

  it("creates the global config when missing and replaces a null trusted_repos", () => {
    const sb = sandbox();
    const repo = sb.repo("repo", POLICY);
    const { id } = trustRepo({ cwd: repo, env: sb.env, now: NOW });
    expect(id).toBe(join(repo, ".git"));
    expect(checkTrust(repo, loadTrusted(sb.dispatchHome)).status).toBe("trusted");

    sb.global("version: 1\ntrusted_repos:\n");
    trustRepo({ cwd: repo, env: sb.env, now: NOW });
    expect(checkTrust(repo, loadTrusted(sb.dispatchHome)).status).toBe("trusted");
  });

  it("modifying, adding or renaming a file invalidates trust and names the files", () => {
    const { repo, status } = trusted();
    writeFileSync(join(repo, ".dispatch/config.yaml"), "version: 1\nprofile: preserve\n");
    expect(status()).toMatchObject({ status: "changed", changed: [".dispatch/config.yaml"] });

    const t2 = trusted();
    writeFiles(t2.repo, { ".dispatch/mappings/new.yaml": "version: 1\n" });
    expect(t2.status().changed).toEqual([".dispatch/mappings/new.yaml"]);

    const t3 = trusted();
    renameSync(
      join(t3.repo, ".dispatch/profiles/team.yaml"),
      join(t3.repo, ".dispatch/profiles/other.yaml"),
    );
    expect(t3.status().changed).toEqual([
      ".dispatch/profiles/other.yaml",
      ".dispatch/profiles/team.yaml",
    ]);
  });

  it("a symlink added after trust makes the repo untrusted", () => {
    const { repo, status } = trusted();
    symlinkSync("/etc/hosts", join(repo, ".dispatch/profiles/evil.yaml"));
    expect(status().status).toBe("symlink");
  });

  it("a different repo with identical config is not trusted", () => {
    const { sb } = trusted();
    const other = sb.repo("other", POLICY);
    expect(checkTrust(other, loadTrusted(sb.dispatchHome)).status).toBe("untrusted");
  });

  it("a linked worktree of the trusted repo with the same policy is trusted", () => {
    const { sb, repo } = trusted();
    writeFiles(repo, { ".git/worktrees/wt/commondir": "../..\n" });
    writeFiles(sb.root, {
      "wt/.git": `gitdir: ${join(repo, ".git/worktrees/wt")}\n`,
      ...Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [`wt/${k}`, v])),
    });
    expect(checkTrust(join(sb.root, "wt"), loadTrusted(sb.dispatchHome)).status).toBe("trusted");
  });

  it("TOCTOU: swapping a file after hashing does not change the parsed policy", () => {
    const { sb, repo } = trusted();
    const cfg = loadEffectiveConfig({
      cwd: repo,
      env: sb.env,
      hooks: {
        afterHash() {
          writeFileSync(join(repo, ".dispatch/config.yaml"), "version: 1\nprofile: preserve\n");
        },
      },
    });
    expect(cfg.trusted).toBe(true);
    expect(cfg.routing.activeProfile).toBe("off");
  });

  it("refuses to trust outside a repo, without policy, or with a symlink", () => {
    const sb = sandbox();
    expect(() => trustRepo({ cwd: sb.home, env: sb.env, now: NOW })).toThrow(/not inside a git/);
    const empty = sb.repo("empty");
    expect(() => trustRepo({ cwd: empty, env: sb.env, now: NOW })).toThrow(/no .dispatch/);
    const link = sb.repo("link", POLICY);
    symlinkSync("/etc/hosts", join(link, ".dispatch/x"));
    expect(() => trustRepo({ cwd: link, env: sb.env, now: NOW })).toThrow(/symlink/);
  });

  it("refuses to rewrite an unparseable global config", () => {
    const sb = sandbox();
    sb.global("version: 1\n  bad: [\n");
    const repo = sb.repo("repo", POLICY);
    expect(() => trustRepo({ cwd: repo, env: sb.env, now: NOW })).toThrow(/config.yaml/);
  });
});

/** Reads trusted_repos from the global config. */
function loadTrusted(home: string) {
  const doc = parse(readFileSync(join(home, "config.yaml"), "utf8"));
  return doc.trusted_repos ?? {};
}
