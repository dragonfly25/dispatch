import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditOp } from "../../../src/core/contracts.js";
import {
  applyOp,
  parseCliSpec,
  renderTextBlock,
  revertEntry,
} from "../../../src/hosts/_framework/edits.js";
import { atomicWrite, sha256 } from "../../../src/hosts/_framework/fsutil.js";
import type { ManifestEntry } from "../../../src/hosts/_framework/manifest.js";
import { fakeClaudeRunner } from "../../support/fake-host.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

function fileOp(file: string, content: string, kind: EditOp["kind"] = "new-file"): EditOp {
  return {
    file,
    kind,
    signature: file,
    content,
    mode: "0755",
    trustGrant: kind === "rules-file" ? "grant" : null,
  };
}

describe("new-file / rules-file", () => {
  it.each(["new-file", "rules-file"] as const)(
    "%s creates the file with its mode and removes it with its dirs",
    async (kind) => {
      h = tempHome();
      const file = join(h.home, ".codex", "rules", "dispatch.rules");
      const { status, entry } = await applyOp(fileOp(file, "rule\n", kind), undefined);
      expect(status).toBe("applied");
      // Windows: mode bits do not reflect ACLs.
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o755);
      }
      expect(entry).toMatchObject({ createdFile: true, sha256: sha256("rule\n") });
      expect(entry.createdDirs).toEqual([join(h.home, ".codex"), join(h.home, ".codex", "rules")]);
      expect(entry.trustGrant).toBe(kind === "rules-file" ? "grant" : null);
      expect((await applyOp(fileOp(file, "rule\n", kind), entry)).status).toBe("unchanged");
      expect((await revertEntry(entry)).status).toBe("reverted");
      expect(existsSync(join(h.home, ".codex"))).toBe(false);
    },
  );

  it("refuses to clobber a file Dispatch did not create [UC14]", async () => {
    h = tempHome();
    const file = join(h.home, "SKILL.md");
    writeFileSync(file, "user's own skill\n");
    await expect(applyOp(fileOp(file, "ours\n"), undefined)).rejects.toThrow(
      /not created by Dispatch/,
    );
    await expect(applyOp(fileOp(file, "ours\n", "rules-file"), undefined)).rejects.toThrow(
      /refusing to overwrite/,
    );
    expect(readFileSync(file, "utf8")).toBe("user's own skill\n");
  });

  it("an identical pre-existing file is adopted but never deleted", async () => {
    h = tempHome();
    const file = join(h.home, "same.md");
    writeFileSync(file, "x");
    const { status, entry } = await applyOp(fileOp(file, "x"), undefined);
    expect(status).toBe("unchanged");
    expect(entry.createdFile).toBe(false);
    expect((await revertEntry(entry)).status).toBe("kept");
    expect(existsSync(file)).toBe(true);
  });

  it("refresh rewrites an intact file; an edited one is kept with a warning", async () => {
    h = tempHome();
    const file = join(h.home, "d", "f.md");
    const first = await applyOp(fileOp(file, "v1\n"), undefined);
    const second = await applyOp(fileOp(file, "v2\n"), first.entry);
    expect(second).toMatchObject({ status: "applied", entry: { createdFile: true } });
    expect(readFileSync(file, "utf8")).toBe("v2\n");
    writeFileSync(file, "user edit\n");
    await expect(applyOp(fileOp(file, "v3\n"), second.entry)).rejects.toThrow(/edited since setup/);
    const r = await revertEntry(second.entry);
    expect(r.status).toBe("kept");
    expect(r.warning).toContain(file);
    writeFileSync(file, "v2\n");
    const gone = { ...second.entry, file: join(h.home, "missing") };
    expect((await revertEntry(gone)).status).toBe("missing");
  });

  it("rejects an op whose sha256 does not match its content", async () => {
    h = tempHome();
    const op = { ...fileOp(join(h.home, "x"), "a"), sha256: sha256("b") };
    await expect(applyOp(op, undefined)).rejects.toThrow(/sha256/);
  });

  it("atomicWrite writes through a symlink and keeps the mode", () => {
    h = tempHome();
    const real = join(h.home, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    const link = join(h.home, "link.json");
    symlinkSync(real, link);
    atomicWrite(link, '{"a":1}');
    expect(readFileSync(real, "utf8")).toBe('{"a":1}');
    // Windows: mode bits do not reflect ACLs.
    if (process.platform !== "win32") {
      expect(statSync(real).mode & 0o777).toBe(0o600);
    }
    expect(() => atomicWrite(join(h.home, "no", "dir", "f"), "x")).toThrow();
  });
});

describe("text-block", () => {
  const op = (file: string, content: string): EditOp => ({
    file,
    kind: "text-block",
    signature: "codex",
    content,
    trustGrant: null,
  });

  it("appends a marked block and removes it byte-exactly", async () => {
    h = tempHome();
    const file = join(h.home, ".profile");
    const original = "export A=1"; // no trailing newline
    writeFileSync(file, original);
    const { entry } = await applyOp(op(file, "line one"), undefined);
    expect(readFileSync(file, "utf8")).toBe(
      `export A=1\n# dispatch:begin codex\nline one\n# dispatch:end codex\n`,
    );
    expect((await applyOp(op(file, "line one"), entry)).status).toBe("unchanged");
    const refreshed = await applyOp(op(file, "line two\n"), entry);
    expect(refreshed.status).toBe("applied");
    await expect(applyOp(op(file, "x"), undefined)).rejects.toThrow(/edited Dispatch block/);
    expect((await revertEntry(refreshed.entry)).status).toBe("reverted");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("creates and deletes a file; warns on an edited block; reports missing", async () => {
    h = tempHome();
    const file = join(h.home, "new", "rc");
    const { entry } = await applyOp(op(file, ""), undefined);
    expect(readFileSync(file, "utf8")).toBe(renderTextBlock("codex", ""));
    expect((await revertEntry(entry)).status).toBe("reverted");
    expect(existsSync(join(h.home, "new"))).toBe(false);
    expect((await revertEntry(entry)).status).toBe("missing");

    const again = await applyOp(op(file, "a"), undefined);
    writeFileSync(file, readFileSync(file, "utf8").replace("\na\n", "\nb\n"));
    const r = await revertEntry(again.entry);
    expect(r).toMatchObject({ status: "kept" });
    expect(r.warning).toContain(file);
    writeFileSync(file, "# dispatch:begin codex\nno end marker\n");
    expect((await revertEntry(again.entry)).status).toBe("missing");
  });
});

describe("cli-command [UC14][AC2]", () => {
  function claudeOps(home: string): EditOp[] {
    const settings = join(home, ".claude", "settings.json");
    const plugins = join(home, ".claude", "plugins");
    return [
      {
        file: "claude",
        kind: "cli-command",
        signature: "mk",
        content: JSON.stringify({
          argv: ["plugin", "marketplace", "add", "/d/hosts/claude-code", "--scope", "user"],
          undo: ["plugin", "marketplace", "remove", "dispatch-local"],
          snapshot: { jsonKeys: [{ file: settings, keys: ["extraKnownMarketplaces"] }] },
        }),
        trustGrant: null,
      },
      {
        file: "claude",
        kind: "cli-command",
        signature: "inst",
        content: JSON.stringify({
          argv: ["plugin", "install", "dispatch@dispatch-local", "-s", "user"],
          undo: ["plugin", "uninstall", "dispatch@dispatch-local", "-s", "user"],
          snapshot: {
            jsonKeys: [{ file: settings, keys: ["enabledPlugins"] }],
            leftovers: [
              { path: join(plugins, "installed_plugins.json"), match: { version: 2, plugins: {} } },
              { path: join(plugins, "cache", "dispatch-local"), recursive: true },
              { path: join(plugins, "data") },
            ],
          },
        }),
        trustGrant: null,
      },
    ];
  }

  it("records the undo and restores settings.json byte-exactly after the host's own uninstall", async () => {
    h = tempHome();
    const settings = join(h.home, ".claude", "settings.json");
    mkdirSync(join(h.home, ".claude"));
    const original = `${JSON.stringify({ theme: "dark", permissions: { allow: [] } }, null, 2)}\n`;
    writeFileSync(settings, original);
    const runner = fakeClaudeRunner(h.home);
    const entries: ManifestEntry[] = [];
    for (const op of claudeOps(h.home))
      entries.push((await applyOp(op, undefined, { runner })).entry);
    expect(entries[1]?.undo).toEqual([
      "plugin",
      "uninstall",
      "dispatch@dispatch-local",
      "-s",
      "user",
    ]);
    expect(entries[0]?.snapshot?.jsonKeys).toEqual([
      { file: settings, key: "extraKnownMarketplaces", before: "absent" },
    ]);
    expect(JSON.parse(readFileSync(settings, "utf8")).enabledPlugins).toEqual({
      "dispatch@dispatch-local": true,
    });
    expect((await applyOp(claudeOps(h.home)[1] as EditOp, entries[1], { runner })).status).toBe(
      "unchanged",
    );

    for (const e of [...entries].reverse()) {
      expect((await revertEntry(e, { runner })).status).toBe("reverted");
    }
    expect(runner.calls.map((c) => c.slice(1, 3).join(" "))).toEqual([
      "plugin marketplace",
      "plugin install",
      "plugin uninstall",
      "plugin marketplace",
    ]);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(join(h.home, ".claude", "plugins"))).toBe(true);
    expect(existsSync(join(h.home, ".claude", "plugins", "installed_plugins.json"))).toBe(false);
    expect(existsSync(join(h.home, ".claude", "plugins", "cache", "dispatch-local"))).toBe(false);
    expect(existsSync(join(h.home, ".claude", "plugins", "data"))).toBe(false);
  });

  it("keeps keys and paths that existed before setup", async () => {
    h = tempHome();
    const settings = join(h.home, ".claude", "settings.json");
    const data = join(h.home, ".claude", "plugins", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ enabledPlugins: {} }, null, 2)}\n`);
    const runner = fakeClaudeRunner(h.home);
    const op = claudeOps(h.home)[1] as EditOp;
    const { entry } = await applyOp(op, undefined, { runner });
    await revertEntry(entry, { runner });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ enabledPlugins: {} });
    expect(existsSync(data)).toBe(true);
  });

  it("fails setup on a non-zero exit and warns when undo fails or is missing", async () => {
    h = tempHome();
    const runner = fakeClaudeRunner(h.home);
    const bad: EditOp = {
      file: "claude",
      kind: "cli-command",
      signature: "x",
      content: '["frob"]',
      trustGrant: null,
    };
    await expect(applyOp(bad, undefined, { runner })).rejects.toThrow(/claude frob.*exit 1/);
    await expect(applyOp(bad, undefined)).rejects.toThrow(/no command runner/);
    const base = {
      file: "claude",
      kind: "cli-command" as const,
      signature: "x",
      sha256: "",
      createdFile: false,
      createdDirs: [],
      trustGrant: null,
      content: '["frob"]',
    };
    expect((await revertEntry({ ...base, undo: [] }, { runner })).warning).toMatch(/no undo/);
    const r = await revertEntry({ ...base, undo: ["nope"] }, { runner });
    expect(r).toMatchObject({ status: "kept" });
    expect(r.warning).toMatch(/run it by hand/);
  });

  it("parses argv arrays and objects; rejects anything else", () => {
    expect(parseCliSpec('["a","b"]')).toEqual({ argv: ["a", "b"] });
    expect(parseCliSpec('{"argv":["a"],"undo":["b"]}').undo).toEqual(["b"]);
    for (const bad of ["nope", "[1]", '{"argv":["a"],"undo":"b"}']) {
      expect(() => parseCliSpec(bad)).toThrow(/cli-command content/);
    }
  });
});
