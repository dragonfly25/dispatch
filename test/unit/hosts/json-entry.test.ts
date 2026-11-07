import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditOp } from "../../../src/core/contracts.js";
import { applyOp, revertEntry } from "../../../src/hosts/_framework/edits.js";
import {
  applyJsonEntry,
  canonicalJson,
  detectFormatting,
  diffSpan,
  getJsonKey,
  parseJsonEntrySpec,
  removeKeyIfEmpty,
  revertJsonEntry,
  undoSpan,
} from "../../../src/hosts/_framework/json-entry.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

const CMD = `[ -n "$DISPATCH_DEPTH" ] && exit 0; exec '/n/node' '/h/hook.mjs' codex SessionStart`;
const PRE = `exec '/n/node' '/h/hook.mjs' codex PreToolUse`;

function op(file: string, event: string, command: string, extra: object = {}): EditOp {
  return {
    file,
    kind: "json-entry",
    signature: command,
    content: JSON.stringify({
      path: ["hooks", event],
      mode: "append",
      value: { hooks: [{ type: "command", command, timeout: 5, ...extra }] },
    }),
    trustGrant: null,
  };
}

const JSONC = `// user hooks, managed by hand
{
  /* keep this comment */
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo user" }] }, // mine
    ],
    "Stop": [],
  },
  "other": true
}
`;

async function roundTrip(file: string, ops: EditOp[]) {
  const entries = [];
  for (const o of ops) entries.push((await applyOp(o, undefined)).entry);
  const during = readFileSync(file, "utf8");
  for (const e of entries.reverse()) expect((await revertEntry(e)).status).toBe("reverted");
  return { during, entries };
}

describe("json-entry [UC14][AC2]", () => {
  it("round-trips a JSONC file with comments and user entries byte-identically", async () => {
    h = tempHome();
    const file = join(h.home, ".codex", "hooks.json");
    mkdirSync(join(h.home, ".codex"));
    writeFileSync(file, JSONC);
    const { during } = await roundTrip(file, [
      op(file, "SessionStart", CMD),
      op(file, "PreToolUse", PRE),
    ]);
    expect(during).toContain("// mine");
    expect(during).toContain("keep this comment");
    expect(during).toContain(JSON.stringify(CMD).slice(1, -1));
    expect(during).toContain('"PreToolUse"');
    expect(readFileSync(file, "utf8")).toBe(JSONC);
  });

  it("creates an absent file (and dirs) and removes both on revert [UC14]", async () => {
    h = tempHome();
    const file = join(h.home, ".codex", "hooks.json");
    const { during, entries } = await roundTrip(file, [
      op(file, "SessionStart", CMD),
      op(file, "PreToolUse", PRE),
    ]);
    expect(JSON.parse(during).hooks.SessionStart[0].hooks[0].command).toBe(CMD);
    expect(entries.map((e) => e.createdFile)).toEqual([false, true]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(h.home, ".codex"))).toBe(false);
  });

  it("is idempotent: re-applying the same entry changes nothing", async () => {
    h = tempHome();
    const file = join(h.home, "hooks.json");
    writeFileSync(file, JSONC);
    const first = await applyOp(op(file, "SessionStart", CMD), undefined);
    const bytes = readFileSync(file, "utf8");
    const again = await applyOp(op(file, "SessionStart", CMD), first.entry);
    expect(again.status).toBe("unchanged");
    expect(again.entry).toBe(first.entry);
    expect((await applyOp(op(file, "SessionStart", CMD), undefined)).status).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("refresh replaces a changed entry, and a foreign different entry is a conflict", async () => {
    h = tempHome();
    const file = join(h.home, "hooks.json");
    writeFileSync(file, JSONC);
    const first = await applyOp(op(file, "SessionStart", CMD), undefined);
    const changed = op(file, "SessionStart", CMD, { timeout: 9 });
    const second = await applyOp(changed, first.entry);
    expect(second.status).toBe("applied");
    const parsed = parseJsonEntrySpec(changed.content);
    expect(parsed.mode).toBe("append");
    expect(readFileSync(file, "utf8")).toContain('"timeout": 9');
    expect(readFileSync(file, "utf8").match(/hook\.mjs/g)).toHaveLength(1);
    await expect(applyOp(op(file, "SessionStart", CMD), undefined)).rejects.toThrow(
      /different Dispatch entry/,
    );
    await revertEntry(second.entry);
    expect(readFileSync(file, "utf8")).toBe(JSONC);
  });

  it("keeps a user-edited entry and warns with the path and a manual instruction", async () => {
    h = tempHome();
    const file = join(h.home, "hooks.json");
    writeFileSync(file, JSONC);
    const { entry } = await applyOp(op(file, "SessionStart", CMD), undefined);
    const edited = readFileSync(file, "utf8").replace('"timeout": 5', '"timeout": 30');
    writeFileSync(file, edited);
    const r = await revertEntry(entry);
    expect(r.status).toBe("kept");
    expect(r.warning).toContain(file);
    expect(r.warning).toMatch(/remove it by hand/);
    expect(readFileSync(file, "utf8")).toBe(edited);
  });

  it("falls back to a structural removal when the user edited around the entry", async () => {
    h = tempHome();
    const file = join(h.home, "hooks.json");
    writeFileSync(file, '{\n  "hooks": {}\n}\n');
    const { entry } = await applyOp(op(file, "SessionStart", CMD), undefined);
    const text = readFileSync(file, "utf8").replace('"hooks": {', '"hooks": {\n    "Mine": [1],');
    writeFileSync(file, text);
    expect((await revertEntry(entry)).status).toBe("reverted");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hooks: { Mine: [1] } });
  });

  it("reports a missing entry or file without touching anything", async () => {
    h = tempHome();
    const file = join(h.home, "hooks.json");
    writeFileSync(file, JSONC);
    const { entry } = await applyOp(op(file, "SessionStart", CMD), undefined);
    writeFileSync(file, JSONC);
    expect((await revertEntry(entry)).status).toBe("missing");
    expect(revertJsonEntry({ ...entry, file: join(h.home, "nope.json") }).status).toBe("missing");
  });

  it("set mode records the pre-image and restores it", () => {
    h = tempHome();
    const file = join(h.home, "settings.json");
    const original = '{\n  "a": 1, // c\n  "b": {"x": 2}\n}\n';
    writeFileSync(file, original);
    const content = JSON.stringify({ path: ["b", "x"], mode: "set", value: 3 });
    const r = applyJsonEntry(file, "b.x", content);
    expect(r.preImage).toBe(2);
    expect(applyJsonEntry(file, "b.x", content).status).toBe("unchanged");
    const rec = { file, signature: "b.x", content, ...r };
    expect(revertJsonEntry(rec).status).toBe("reverted");
    expect(readFileSync(file, "utf8")).toBe(original);

    const added = applyJsonEntry(file, "c", JSON.stringify({ path: ["c"], mode: "set", value: 1 }));
    expect(added.preImage).toBe("absent");
    writeFileSync(file, readFileSync(file, "utf8").replace('"a": 1', '"a": 7'));
    const back = revertJsonEntry({
      file,
      signature: "c",
      content: JSON.stringify({ path: ["c"], mode: "set", value: 1 }),
      ...added,
      inverse: undefined,
    });
    expect(back.status).toBe("reverted");
    expect(getJsonKey(file, "c")).toBe("absent");
    expect(getJsonKey(file, "a")).toBe(7);
  });

  it("refuses to edit invalid JSON and rejects malformed specs", () => {
    h = tempHome();
    const file = join(h.home, "bad.json");
    writeFileSync(file, "{ nope");
    expect(() =>
      applyJsonEntry(file, "s", JSON.stringify({ path: ["a"], mode: "set", value: 1 })),
    ).toThrow(/not valid JSON/);
    for (const bad of ["x", "{}", JSON.stringify({ path: [], mode: "set", value: 1 })]) {
      expect(() => parseJsonEntrySpec(bad)).toThrow(/json-entry content/);
    }
  });

  it("removeKeyIfEmpty removes only empty objects/arrays", () => {
    h = tempHome();
    const file = join(h.home, "s.json");
    writeFileSync(file, '{\n  "keep": 1,\n  "e": {},\n  "f": {"x": 1}\n}\n');
    expect(removeKeyIfEmpty(file, "e")).toBe(true);
    expect(removeKeyIfEmpty(file, "f")).toBe(false);
    expect(removeKeyIfEmpty(file, "keep")).toBe(false);
    expect(removeKeyIfEmpty(file, "zz")).toBe(false);
    expect(removeKeyIfEmpty(join(h.home, "none.json"), "e")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe('{\n  "keep": 1,\n  "f": {"x": 1}\n}\n');
  });

  it("helpers: canonical JSON, formatting detection, spans", () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":2,"d":1}]}',
    );
    expect(detectFormatting('{\n\t"a": 1\r\n}')).toEqual({
      insertSpaces: false,
      tabSize: 1,
      eol: "\r\n",
    });
    expect(detectFormatting('{\n    "a": 1\n}')).toMatchObject({ insertSpaces: true, tabSize: 4 });
    expect(detectFormatting("{}")).toMatchObject({ tabSize: 2, eol: "\n" });
    const inv = diffSpan("abcXYZdef", "abcXYZ123XYZdef");
    expect(undoSpan("abcXYZ123XYZdef", inv, 3, 12)).toBe("abcXYZdef");
    expect(undoSpan("abcdef", inv, 0, 6)).toBeNull();
    expect(undoSpan("abc", { original: "x", inserted: "" }, 0, 3)).toBeNull();
  });
});
