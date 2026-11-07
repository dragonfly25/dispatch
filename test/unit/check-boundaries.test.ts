import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../scripts/check-boundaries.mjs");
const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-bounds-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function run(root: string) {
  const r = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("check-boundaries", () => {
  it("passes on a clean tree (and on the real repo)", () => {
    const root = tree({
      "src/router/decide.ts": "// Date is fine in comments\nexport const x = input.now;\n",
      "src/runner/proc.ts": 'import { spawn } from "node:child_process";\n',
      ".github/workflows/ci.yml": "on: [push]\n",
      "src/hosts/_framework/edits.ts": 'writeFileSync(join(home, ".claude", "x"), "");\n',
      "src/platform/host.ts": 'export const m = "see ~/.codex/rules";\n',
    });
    expect(run(root)).toEqual({ code: 0, out: "Boundaries OK\n" });
    expect(run(resolve(import.meta.dirname, "../..")).code).toBe(0);
  });

  it.each([
    ["src/router/a.ts", "const t = new Date();", "Date"],
    ["src/router/b.ts", "const r = Math.random();", "Math.random"],
    ["src/router/c.ts", "const e = process.env.HOME;", "process.env"],
    ["src/cli/x.ts", 'import { spawn } from "child_process";', "child_process"],
    ["src/quota/y.ts", 'const cp = await import("node:child_process");', "child_process"],
    [".github/workflows/ci.yml", "env: { TOKEN: secrets.NPM }", "secrets"],
    [".github/workflows/pr.yaml", "on: pull_request_target", "pull_request_target"],
    ["src/cli/w.ts", 'writeFileSync(join(home, ".codex", "hooks.json"), "{}");', ".codex"],
    ["src/hosts/codex/p.ts", 'await mkdir("~/.agents/skills", {});', ".agents"],
    ["src/state/g.ts", 'rmSync(home + "/.gemini/x");', ".gemini"],
  ])("flags %s", (file, content, needle) => {
    const { code, out } = run(tree({ [file]: content }));
    expect(code).toBe(1);
    expect(out).toContain(file);
    expect(out).toContain(needle);
  });
});
