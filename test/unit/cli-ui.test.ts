/**
 * Terminal presentation helpers (`src/cli/ui.ts`): plain text without ANSI when decoration is off,
 * ANSI when on, `~/` paths, meter bounds, column alignment, boxed notes and the stderr spinner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  box,
  columns,
  createUi,
  decorationEnabled,
  errUi,
  meter,
  nextSteps,
  outUi,
  plainUi,
  startSpinner,
  tildify,
  tildifyText,
  visibleLength,
} from "../../src/cli/ui.js";

const ESC = "\x1b[";

describe("createUi", () => {
  it("disabled: every helper returns the text unchanged, symbols are ASCII", () => {
    const ui = createUi(false);
    for (const f of [ui.bold, ui.dim, ui.green, ui.yellow, ui.red, ui.cyan]) {
      expect(f("text")).toBe("text");
    }
    expect(ui.mark("ok")).toBe("ok");
    expect(ui.mark("warn")).toBe("warn");
    expect(ui.mark("fail")).toBe("FAIL");
    expect(ui.tone("fail", "x")).toBe("x");
    expect(plainUi.enabled).toBe(false);
  });

  it("enabled: ANSI colors and Unicode symbols, whatever the real stdout is", () => {
    const ui = createUi(true);
    expect(ui.bold("b")).toBe(`${ESC}1mb${ESC}22m`);
    expect(ui.green("g")).toContain(`${ESC}32m`);
    expect(ui.red("r")).toContain(`${ESC}31m`);
    expect(ui.yellow("y")).toContain(`${ESC}33m`);
    expect(ui.cyan("c")).toContain(`${ESC}36m`);
    expect(ui.dim("d")).toContain(`${ESC}2m`);
    expect(ui.dim("")).toBe("");
    expect(ui.mark("ok")).toContain("✔");
    expect(ui.mark("warn")).toContain("⚠");
    expect(ui.mark("fail")).toContain("✖");
    expect(ui.sym.dot).toBe("●");
  });

  it("outUi / errUi follow io.decorate; no decorate means plain", () => {
    const io = { out: () => {}, err: () => {} };
    expect(outUi(io).enabled).toBe(false);
    expect(errUi(io).enabled).toBe(false);
    const both = { ...io, decorate: { out: true, err: false } };
    expect(outUi(both).enabled).toBe(true);
    expect(errUi(both).enabled).toBe(false);
  });
});

describe("decorationEnabled", () => {
  const tty = { isTTY: true };
  it("TTY only by default", () => {
    expect(decorationEnabled(tty, {})).toBe(true);
    expect(decorationEnabled({}, {})).toBe(false);
    expect(decorationEnabled({ isTTY: false }, {})).toBe(false);
  });
  it("NO_COLOR wins over everything; FORCE_COLOR forces it on or off", () => {
    expect(decorationEnabled(tty, { NO_COLOR: "1" })).toBe(false);
    expect(decorationEnabled(tty, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
    expect(decorationEnabled({}, { FORCE_COLOR: "1" })).toBe(true);
    expect(decorationEnabled({}, { FORCE_COLOR: "" })).toBe(true);
    expect(decorationEnabled(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(decorationEnabled(tty, { FORCE_COLOR: "false" })).toBe(false);
    expect(decorationEnabled(tty, { NO_COLOR: "" })).toBe(true);
  });
});

describe("tildify", () => {
  it("shows paths under home as ~/…", () => {
    expect(tildify("/Users/me/.dispatch/bin/dispatch", "/Users/me", "linux")).toBe(
      "~/.dispatch/bin/dispatch",
    );
    expect(tildify("/Users/me", "/Users/me", "linux")).toBe("~");
    expect(tildify("/Users/me/x", "/Users/me/", "linux")).toBe("~/x");
  });
  it("leaves other paths alone", () => {
    expect(tildify("/Users/meme/x", "/Users/me", "linux")).toBe("/Users/meme/x");
    expect(tildify("/opt/x", "/Users/me", "linux")).toBe("/opt/x");
    expect(tildify("/opt/x", undefined, "linux")).toBe("/opt/x");
    expect(tildify("/opt/x", "/", "linux")).toBe("/opt/x");
  });
  it("tildifyText rewrites every home path inside a message", () => {
    expect(tildifyText("a /h/me/x and /h/me/y", "/h/me")).toBe("a ~/x and ~/y");
    expect(tildifyText("a /h/me/x", undefined)).toBe("a /h/me/x");
    expect(tildifyText("a /h/x", "/")).toBe("a /h/x");
  });
});

describe("meter", () => {
  it("is empty at 0 and full at 100", () => {
    expect(meter(0, 10)).toBe("----------");
    expect(meter(100, 10)).toBe("##########");
    expect(meter(45, 10)).toBe("#####-----");
    expect(meter(100, 4, true)).toBe("████");
    expect(meter(0, 4, true)).toBe("░░░░");
  });
  it("clamps out-of-range and non-finite values, and a bad width", () => {
    expect(meter(-20, 5)).toBe("-----");
    expect(meter(250, 5)).toBe("#####");
    expect(meter(Number.NaN, 5)).toBe("-----");
    expect(meter(50, -3)).toBe("");
    expect(meter(50, 4.7)).toBe("##--");
  });
});

describe("layout", () => {
  it("columns aligns by displayed width (ANSI does not count) and trims the end", () => {
    const ui = createUi(true);
    const rows = columns([
      ["a", ui.green("bb"), "c"],
      ["aaa", "b", ""],
    ]);
    expect(rows[0]).toBe(`a    ${ui.green("bb")}  c`);
    expect(rows[1]).toBe("aaa  b");
    expect(visibleLength(ui.bold("héllo"))).toBe(5);
  });

  it("box: a frame when decorated, a title and indented lines otherwise", () => {
    expect(box(plainUi, "Title", ["one", "two"])).toBe("Title\n  one\n  two\n");
    const framed = box(createUi(true), "T", ["line"]);
    expect(framed).toMatch(/^╭─ .*T.*╮\n│ line\s+│\n╰─+╯\n$/);
  });

  it("nextSteps aligns command and description", () => {
    expect(
      nextSteps(plainUi, [
        ["dispatch doctor", "check"],
        ["x", "y"],
      ]),
    ).toBe("Next steps:\n  dispatch doctor  check\n  x                y\n");
  });
});

describe("startSpinner", () => {
  afterEach(() => vi.useRealTimers());

  it("is a no-op without decoration", () => {
    const err: string[] = [];
    const s = startSpinner({ out: () => {}, err: (t) => err.push(t) }, "x");
    s.update("y");
    s.stop();
    expect(err).toEqual([]);
  });

  it("redraws one stderr line and clears it on stop", () => {
    vi.useFakeTimers();
    const err: string[] = [];
    const io = {
      out: () => {},
      err: (t: string) => err.push(t),
      decorate: { out: false, err: true },
    };
    const s = startSpinner(io, "codex · starting", 50);
    s.update("codex · editing src/a.ts");
    vi.advanceTimersByTime(120);
    s.stop();
    s.stop();
    expect(err[0]).toContain("codex · starting");
    expect(err.some((t) => t.includes("editing src/a.ts"))).toBe(true);
    expect(err.at(-1)).toBe("\r\x1b[K");
    const writes = err.length;
    vi.advanceTimersByTime(500);
    expect(err.length).toBe(writes);
  });

  it("draws a new text at once, before the next tick; same text or after stop draws nothing", () => {
    vi.useFakeTimers();
    const err: string[] = [];
    const io = {
      out: () => {},
      err: (t: string) => err.push(t),
      decorate: { out: false, err: true },
    };
    const s = startSpinner(io, "routing · starting", 1_000);
    s.update("codex · starting");
    expect(err).toHaveLength(2);
    expect(err[1]).toContain("codex · starting");
    s.update("codex · starting");
    expect(err).toHaveLength(2);
    s.stop();
    s.update("codex · editing src/a.ts");
    expect(err.at(-1)).toBe("\r\x1b[K");
  });
});
