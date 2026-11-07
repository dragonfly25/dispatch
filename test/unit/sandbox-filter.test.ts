import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  checkPath,
  type FilterPolicy,
  filterChanges,
} from "../../src/sandbox/filter.js";

const none: FilterPolicy = { pins: [] };
const file = (path: string, newMode = "100644", oldMode = "000000"): ChangedFile => ({
  path,
  oldMode,
  newMode,
  status: "A",
});

/** A safe path segment: never starts with a dot, never a reserved name. */
const segment = fc
  .stringMatching(/^[a-z0-9_-][a-z0-9_.-]{0,10}$/)
  .filter((s) => !/^(claude|agents|gemini)(\.local|\.override)?\.md$/.test(s));
const safePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join("/"));
const randomCase = (s: string) =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) => [...s].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(""));

describe("checkPath [SEC-patch]", () => {
  it.each([
    ["", "invalid-path"],
    ["a//b", "invalid-path"],
    ["./a", "invalid-path"],
    ["a\nb", "control-char"],
    ["a\u0000b", "control-char"],
    ["a\u007fb", "control-char"],
    ["/etc/passwd", "absolute"],
    ["\\\\server\\share", "absolute"],
    ["C:/x", "absolute"],
    ["../outside", "traversal"],
    ["a/../../b", "traversal"],
    ["a\\..\\b", "traversal"],
    [".git/config", "git-internal"],
    ["sub/.git/hooks/pre-commit", "git-internal"],
    [".GIT/HEAD", "git-internal"],
    [".gitmodules", "git-internal"],
    [".dispatch/config.yaml", "dispatch-config"],
    [".claude/settings.json", "host-config"],
    ["pkg/.Claude/agents/x.md", "host-config"],
    [".codex/config.toml", "host-config"],
    [".gemini/settings.json", "host-config"],
    [".agents/hooks.json", "host-config"],
    [".github/workflows/ci.yml", "ci-workflow"],
    [".GitHub/Workflows/x.yml", "ci-workflow"],
    ["CLAUDE.md", "agent-instructions"],
    ["src/claude.md", "agent-instructions"],
    ["CLAUDE.local.md", "agent-instructions"],
    ["deep/AGENTS.md", "agent-instructions"],
    ["AGENTS.override.md", "agent-instructions"],
    ["GEMINI.md", "agent-instructions"],
    [".env", "env-file"],
    [".env.local", "env-file"],
    ["app/.ENV.production", "env-file"],
    [".envrc", "env-file"],
  ])("%j -> %s", (path, reason) => {
    expect(checkPath(path, none)).toBe(reason);
  });

  it.each([
    "src/index.ts",
    ".gitignore",
    ".gitattributes",
    ".github/CODEOWNERS",
    "docs/claude-notes.md",
    "environment.ts",
    ".envoy/x",
    "a/..b/c",
    "README.md",
  ])("allows %j", (path) => {
    expect(checkPath(path, none)).toBeNull();
  });

  it("rejects pinned paths, the pinned directory itself and case variants [UC5]", () => {
    const policy = { pins: ["db/migrations/**", "secrets"] };
    expect(checkPath("db/migrations/001.sql", policy)).toBe("pinned");
    expect(checkPath("DB/Migrations/002.sql", policy)).toBe("pinned");
    expect(checkPath("secrets/a/b.txt", policy)).toBe("pinned");
    expect(checkPath("db/seed.sql", policy)).toBeNull();
  });

  it("rejects extra deny globs after pins", () => {
    const policy = { pins: ["*.lock"], denyGlobs: ["*.lock", "infra/**"] };
    expect(checkPath("yarn.lock", policy)).toBe("pinned");
    expect(checkPath("infra/main.tf", policy)).toBe("denied");
    expect(checkPath("src/a.ts", { pins: [], denyGlobs: [] })).toBeNull();
  });
});

describe("filterChanges [SEC-patch]", () => {
  it("rejects symlinks and gitlinks on either side of the change, path reasons first", () => {
    const { accepted, rejected } = filterChanges(
      [
        file("ok.txt"),
        file("evil", "120000"),
        file("was-link", "100644", "120000"),
        file("vendor/lib", "160000"),
        file("gone-sub", "000000", "160000"),
        file("../x", "120000"),
      ],
      none,
    );
    expect(accepted.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(rejected).toEqual([
      { path: "evil", reason: "symlink" },
      { path: "was-link", reason: "symlink" },
      { path: "vendor/lib", reason: "gitlink" },
      { path: "gone-sub", reason: "gitlink" },
      { path: "../x", reason: "traversal" },
    ]);
  });

  it("property: accepted and rejected partition the input, preserving order", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (paths) => {
        const files = paths.map((p) => file(p));
        const { accepted, rejected } = filterChanges(files, none);
        expect(accepted.length + rejected.length).toBe(files.length);
        for (const f of accepted) expect(checkPath(f.path, none)).toBeNull();
        for (const r of rejected) expect(checkPath(r.path, none)).toBe(r.reason);
      }),
    );
  });
});

describe("filter properties [SEC-patch]", () => {
  it("safe paths are accepted", () => {
    fc.assert(fc.property(safePath, (p) => checkPath(p, none) === null));
  });

  it("any `..` segment is rejected", () => {
    fc.assert(
      fc.property(safePath, safePath, (a, b) => {
        expect(checkPath(`${a}/../${b}`, none)).toBe("traversal");
        expect(checkPath(`../${a}`, none)).toBe("traversal");
      }),
    );
  });

  it("any control character is rejected", () => {
    const ctrl = fc.integer({ min: 0, max: 31 }).map((n) => String.fromCharCode(n));
    fc.assert(
      fc.property(safePath, ctrl, safePath, (a, c, b) => {
        expect(checkPath(`${a}${c}${b}`, none)).toBe("control-char");
      }),
    );
  });

  it("absolute paths are rejected", () => {
    fc.assert(fc.property(safePath, (p) => checkPath(`/${p}`, none) === "absolute"));
  });

  it("protected directories are rejected at any depth and in any letter case", () => {
    const dirs = [".git", ".dispatch", ".claude", ".codex", ".gemini", ".agents"];
    fc.assert(
      fc.property(
        fc.constantFrom(...dirs).chain(randomCase),
        fc.array(segment, { maxLength: 3 }),
        safePath,
        (dir, prefix, rest) => {
          const p = [...prefix, dir, rest].join("/");
          expect(checkPath(p, none)).not.toBeNull();
        },
      ),
    );
  });

  it("instruction and env files are rejected anywhere", () => {
    const names = ["claude.md", "agents.md", "gemini.md", ".env", ".env.local"];
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 3 }),
        fc.constantFrom(...names).chain(randomCase),
        (dirs, name) => checkPath([...dirs, name].join("/"), none) !== null,
      ),
    );
  });

  it("everything under a pinned directory is rejected [UC5]", () => {
    fc.assert(
      fc.property(safePath, safePath, (dir, rest) => {
        expect(checkPath(`${dir}/${rest}`, { pins: [`${dir}/**`] })).toBe("pinned");
      }),
    );
  });
});
