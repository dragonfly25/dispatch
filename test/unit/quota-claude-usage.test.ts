import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../src/core/contracts.js";
import { DefaultQuotaProvider } from "../../src/quota/provider.js";
import { QuotaReaderRegistry, runReader } from "../../src/quota/reader.js";
import {
  CLAUDE_USAGE_ARGV,
  CLAUDE_USAGE_LLM_ARGV,
  ClaudeUsageReader,
  isGrounded,
  kindOfLabel,
  parseUsageHeader,
  QuotaAuthError,
  QuotaFormatError,
  resolveReset,
  splitZone,
  trimUsageHeader,
} from "../../src/quota/readers/index.js";
import { SqliteStateStore } from "../../src/state/store.js";
import { FakeClock } from "../stubs/index.js";
import { createFakes, type FakeScenarioMap, type FakesContext } from "../support/index.js";
import { instance, NodeSpawner } from "./quota-readers-helpers.js";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "claude", "2.1.301", "usage.txt"),
  "utf8",
);
/** Strings that only occur in the (invented) local-usage breakdown of the fixture. */
const PRIVATE = [
  "PRIVATE-BREAKDOWN-MARKER",
  "zebra-crawler-secret",
  "quokka-indexer-secret",
  "1234 requests",
];
const NOW = new Date("2026-11-07T12:00:00.000Z");
const TIRANE = "Europe/Tirane";

describe("claude /usage header and parser", () => {
  it("keeps only the quota header of the recorded output", () => {
    const header = trimUsageHeader(FIXTURE);
    expect(header).toBe(
      [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current week (all models): 34% used · resets Nov 11 at 10am (Europe/Tirane)",
        "Current week (Fable): 8% used · resets Nov 11 at 10am (Europe/Tirane)",
      ].join("\n"),
    );
    for (const p of PRIVATE) expect(header).not.toContain(p);
    // Without any `Current` line the cut still happens at the breakdown, and ANSI codes go.
    expect(trimUsageHeader("\u001b[1mHello\u001b[0m\nLast 24h · 3 requests\nsecret")).toBe("Hello");
    // A block that does not end with a blank line is still cut at the first other line.
    expect(trimUsageHeader("Current session: 1% used\nTop: x")).toBe("Current session: 1% used");
    expect(
      trimUsageHeader(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")).split("\n"),
    ).toHaveLength(12);
  });

  it("parses the sample: weekly all-models -> 7d, weekly per model -> 7d:<model>", () => {
    const parsed = parseUsageHeader(trimUsageHeader(FIXTURE));
    expect(parsed).toEqual({
      ok: true,
      lines: [
        {
          label: "week (all models)",
          kind: "7d",
          usedPct: 34,
          resetText: "Nov 11 at 10am",
          timeZone: TIRANE,
        },
        {
          label: "week (Fable)",
          kind: "7d:fable",
          usedPct: 8,
          resetText: "Nov 11 at 10am",
          timeZone: TIRANE,
        },
      ],
    });
  });

  it("parses a `Current session` line and tolerates other separators, spacing and case", () => {
    const parsed = parseUsageHeader(
      [
        "  current SESSION :  12.5 %  used  -  resets 3:30pm (Europe/Tirane)",
        "Current week (all models): 40% used | resets Nov 11, 10:30pm",
        "Current week (Sonnet 5): 3% used",
        "Current month: 3% used · resets Dec 1",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.lines.map((l) => [l.kind, l.usedPct, l.resetText, l.timeZone])).toEqual([
      ["5h", 12.5, "3:30pm", TIRANE],
      ["7d", 40, "Nov 11, 10:30pm", null],
      ["7d:sonnet-5", 3, null, null],
    ]);
  });

  it("rejects garbage, bad percentages and unknown-only labels", () => {
    expect(parseUsageHeader("")).toMatchObject({ ok: false, lines: [] });
    expect(parseUsageHeader("hello\nworld")).toMatchObject({
      ok: false,
      problem: "no `Current …` line",
    });
    expect(parseUsageHeader("Current week: lots used")).toMatchObject({ ok: false });
    expect(parseUsageHeader("Current week (all models): 140% used")).toMatchObject({ ok: false });
    expect(parseUsageHeader("Current month: 3% used")).toMatchObject({
      ok: false,
      problem: "no known window label",
    });
  });

  it("maps labels to window kinds", () => {
    expect(kindOfLabel("session")).toBe("5h");
    expect(kindOfLabel("week")).toBe("7d");
    expect(kindOfLabel("Week (All Models)")).toBe("7d");
    expect(kindOfLabel("week (Opus 5.5)")).toBe("7d:opus-5.5");
    expect(kindOfLabel("week (---)")).toBeNull();
    expect(kindOfLabel("year")).toBeNull();
    expect(splitZone("Nov 11 at 10am (America/Argentina/Buenos_Aires)")).toEqual({
      text: "Nov 11 at 10am",
      zone: "America/Argentina/Buenos_Aires",
    });
  });
});

describe("claude /usage reset times", () => {
  it("resolves month/day/time in the given zone (12h formats)", () => {
    expect(resolveReset("Nov 11 at 10am", TIRANE, NOW)).toEqual({
      iso: "2026-11-11T09:00:00.000Z",
      zone: TIRANE,
      zoneAssumed: false,
    });
    expect(resolveReset("Nov 11, 10:30pm", TIRANE, NOW)?.iso).toBe("2026-11-11T21:30:00.000Z");
    expect(resolveReset("November 8th 12am", "UTC", NOW)?.iso).toBe("2026-11-08T00:00:00.000Z");
    expect(resolveReset("Nov 8 at 12pm", "UTC", NOW)?.iso).toBe("2026-11-08T12:00:00.000Z");
    expect(resolveReset("Nov 9", "UTC", NOW)?.iso).toBe("2026-11-09T00:00:00.000Z");
    expect(resolveReset("Nov 9 14:00", "UTC", NOW)?.iso).toBe("2026-11-09T14:00:00.000Z");
  });

  it("a bare time is its next occurrence", () => {
    expect(resolveReset("3pm", "UTC", NOW)?.iso).toBe("2026-11-07T15:00:00.000Z");
    expect(resolveReset("10am", "UTC", NOW)?.iso).toBe("2026-11-08T10:00:00.000Z");
    expect(resolveReset("10:30pm", TIRANE, NOW)?.iso).toBe("2026-11-07T21:30:00.000Z");
  });

  it("[year rollover] picks the year that puts the reset in the future, allowing a day of skew", () => {
    const dec30 = new Date("2026-12-30T12:00:00.000Z");
    expect(resolveReset("Jan 2 at 10am", "UTC", dec30)?.iso).toBe("2027-01-02T10:00:00.000Z");
    const jan1 = new Date("2027-01-01T01:00:00.000Z");
    expect(resolveReset("Dec 31 at 10pm", "UTC", jan1)?.iso).toBe("2026-12-31T22:00:00.000Z");
    expect(resolveReset("Nov 6 at 3pm", "UTC", NOW)?.iso).toBe("2026-11-06T15:00:00.000Z");
    expect(resolveReset("Nov 6 at 10am", "UTC", NOW)?.iso).toBe("2027-11-06T10:00:00.000Z");
    expect(resolveReset("Nov 1 at 10am", "UTC", NOW)?.iso).toBe("2027-11-01T10:00:00.000Z");
  });

  it("without a zone uses the local zone and says so", () => {
    expect(resolveReset("Nov 11 at 10am", null, NOW, "America/New_York")).toEqual({
      iso: "2026-11-11T15:00:00.000Z",
      zone: "America/New_York",
      zoneAssumed: true,
    });
    expect(resolveReset("Nov 11 at 10am", null, NOW)?.zoneAssumed).toBe(true);
  });

  it("returns null for text it does not understand", () => {
    for (const bad of [
      "soon",
      "",
      "Foo 11 at 10am",
      "Nov 41",
      "Feb 30 at 1am",
      "13pm",
      "25:00",
      "Nov 11 at 10:75am",
    ]) {
      expect(resolveReset(bad, "UTC", NOW), bad).toBeNull();
    }
    expect(resolveReset("Nov 11", "Mars/Olympus", NOW)).toBeNull();
  });
});

describe("grounding of LLM readings", () => {
  const src = trimUsageHeader(FIXTURE);
  it("accepts facts copied from the header and rejects invented ones", () => {
    const ok = {
      label: "week (all models)",
      usedPercent: 34,
      resetText: "Nov 11 at 10am",
      timeZone: TIRANE,
    };
    expect(isGrounded(src, ok)).toBe(true);
    expect(isGrounded(src, { ...ok, usedPercent: 77 })).toBe(false);
    expect(isGrounded(src, { ...ok, usedPercent: 4 })).toBe(false); // "34%" does not ground 4
    expect(isGrounded(src, { ...ok, resetText: "Nov 12 at 10am" })).toBe(false);
    expect(isGrounded(src, { ...ok, resetText: "Dec 11 at 10am" })).toBe(false);
    expect(isGrounded(src, { ...ok, timeZone: "Europe/Rome" })).toBe(false);
    expect(isGrounded(src, { ...ok, label: "session" })).toBe(false);
    expect(isGrounded(src, { label: "week (Fable)", usedPercent: 8 })).toBe(true);
  });
});

describe("claude /usage reader (fake claude) [UC11]", () => {
  let home: string;
  let clock: FakeClock;
  const disposables: FakesContext[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dispatch-claude-usage-"));
    clock = new FakeClock(NOW);
  });
  afterEach(() => {
    for (const f of disposables.splice(0)) f.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const claude = (over: Partial<ProviderInstance> = {}) =>
    instance({ id: "claude", adapter: "claude", ...over });
  const setup = (
    scenarios: FakeScenarioMap = {},
    opts: { llmFallback?: boolean; timeoutMs?: number } = {},
  ) => {
    const fakes = createFakes(scenarios);
    disposables.push(fakes);
    const spawner = new NodeSpawner();
    const reader = new ClaudeUsageReader({
      spawner,
      clock,
      env: { ...fakes.env, HOME: home, ANTHROPIC_API_KEY: "nope", DISPATCH_DEPTH: "1" },
      localZone: "UTC",
      ...(opts.llmFallback === undefined ? {} : { llmFallback: opts.llmFallback }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    return { fakes, spawner, reader };
  };
  const longCtx = () => ({ signal: new AbortController().signal, timeoutMs: 25_000 });

  it("reads the recorded output: real 7d and 7d:fable windows, isolated quota-free call", async () => {
    const { reader, spawner, fakes } = setup();
    const windows = await reader.read(claude({ configDir: "~/.claude-alt" }));
    const common = {
      resetAt: "2026-11-11T09:00:00.000Z",
      source: "claude-usage",
      readAt: NOW.toISOString(),
      reliability: "real",
    };
    expect(windows).toEqual([
      { kind: "7d", usedPct: 34, ...common },
      { kind: "7d:fable", usedPct: 8, ...common },
    ]);
    const req = spawner.requests[0];
    expect(req?.argv).toEqual([...CLAUDE_USAGE_ARGV]);
    expect(req?.cwd).toBe(tmpdir());
    expect(req?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(req?.env.DISPATCH_DEPTH).toBe("2");
    expect(req?.env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude-alt"));
    expect(fakes.readLog({ cli: "claude" }).map((c) => c.key)).toEqual(["usage"]);
    expect(reader.zoneAssumed).toBe(false);
  });

  it("reads the optional session line; a relative config dir is not forwarded", async () => {
    const { reader, spawner } = setup({ "claude:usage": { variant: "session" } });
    const windows = await reader.read(claude({ configDir: "relative/dir" }));
    expect(windows.map((w) => [w.kind, w.usedPct, w.resetAt])).toEqual([
      ["5h", 12, "2026-11-07T14:30:00.000Z"],
      ["7d", 34, "2026-11-11T09:00:00.000Z"],
      ["7d:fable", 8, "2026-11-11T09:00:00.000Z"],
    ]);
    expect(spawner.requests[0]?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("reset times without a zone are read in the local zone and flagged", async () => {
    const stdout = "Current week (all models): 34% used · resets Nov 11 at 10am\n";
    const { reader } = setup({ "claude:usage": { stdout } });
    const [w] = await reader.read(claude());
    expect(w?.resetAt).toBe("2026-11-11T10:00:00.000Z");
    expect(reader.zoneAssumed).toBe(true);
  });

  it("skips api_credit instances without starting claude", async () => {
    const { reader, spawner } = setup();
    expect(await reader.read(claude({ pool: "api_credit" }))).toEqual([]);
    expect(spawner.requests).toEqual([]);
  });

  it("[UC11] not logged in -> QuotaAuthError (stderr or stdout), other failures -> reader errors", async () => {
    let t = setup({ "claude:usage": { variant: "unauthenticated" } });
    await expect(t.reader.read(claude())).rejects.toBeInstanceOf(QuotaAuthError);
    t = setup({ "claude:usage": { stdout: "Please run /login to sign in.\n" } });
    await expect(t.reader.read(claude())).rejects.toBeInstanceOf(QuotaAuthError);
    t = setup({ "claude:usage": { exitCode: 3, stdout: "", stderr: "boom\n" } });
    await expect(t.reader.read(claude())).rejects.toThrow(/exited with code 3/);
    t = setup({ "claude:usage": { delayMs: 5_000 } }, { timeoutMs: 300 });
    await expect(t.reader.read(claude())).rejects.toThrow(/timed out after 300 ms/);
  });

  it("[UC11] a changed format is a QuotaFormatError on the routing budget: no model call", async () => {
    const { reader, fakes } = setup({ "claude:usage": { variant: "changed_format" } });
    const err = await reader.read(claude()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaFormatError);
    expect(fakes.readLog({ cli: "claude" }).map((c) => c.key)).toEqual(["usage"]);
    // Through the core's guard with the default 5 s budget: same outcome.
    const outcome = await runReader(reader, claude());
    expect(outcome).toMatchObject({ ok: false, timedOut: false });
    expect(fakes.readLog({ key: "usage-llm" })).toEqual([]);
  });

  it("an unreadable reset time also falls back to the model (long budget only)", async () => {
    const stdout = "Current week (all models): 34% used · resets whenever (Europe/Tirane)\n";
    const { reader, fakes } = setup({
      "claude:usage": { stdout },
      "claude:usage-llm": {
        stdout: `${JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ windows: [{ label: "week (all models)", usedPercent: 34, resetText: null, timeZone: TIRANE }] }) })}\n`,
      },
    });
    await expect(reader.read(claude())).rejects.toThrow(/unreadable reset time "whenever"/);
    const windows = await reader.read(claude(), longCtx());
    expect(windows).toEqual([
      expect.objectContaining({
        kind: "7d",
        usedPct: 34,
        resetAt: null,
        source: "claude-usage+llm",
      }),
    ]);
    expect(fakes.readLog({ key: "usage-llm" })).toHaveLength(1);
  });

  it("falls back to Haiku with a long budget: grounded answer -> claude-usage+llm reading", async () => {
    const { reader, spawner, fakes } = setup({ "claude:usage": { variant: "changed_format" } });
    const windows = await reader.read(claude(), longCtx());
    expect(windows).toEqual([
      {
        kind: "7d",
        usedPct: 34,
        resetAt: "2026-11-11T09:00:00.000Z",
        source: "claude-usage+llm",
        readAt: NOW.toISOString(),
        reliability: "real",
      },
    ]);
    const llm = spawner.requests[1];
    expect(llm?.argv).toEqual([...CLAUDE_USAGE_LLM_ARGV]);
    expect(llm?.env.DISPATCH_DEPTH).toBe("2");
    expect(fakes.readLog({ key: "usage-llm" })[0]?.stdin).toContain(
      "Current week (all models) — 34 percent",
    );
  });

  it("[SEC-privacy] the usage breakdown never reaches the fallback, the store or the reader health", async () => {
    const { reader, spawner, fakes } = setup({ "claude:usage": { variant: "changed_format" } });
    const dir = mkdtempSync(join(tmpdir(), "dispatch-claude-usage-db-"));
    const store = SqliteStateStore.open(join(dir, "dispatch.db"), { clock });
    try {
      const provider = new DefaultQuotaProvider({
        store,
        clock,
        readers: new QuotaReaderRegistry().register("claude", reader),
      });
      const snap = await provider.snapshot([claude()], { readerTimeoutMs: 25_000 });
      expect(snap.instances.claude?.windows.find((w) => w.kind === "7d")).toMatchObject({
        usedPct: 34,
        source: "claude-usage+llm",
        reliability: "real",
      });
      const stdin = spawner.requests[1]?.stdin ?? "";
      const logged = fakes.readLog({ key: "usage-llm" })[0]?.stdin ?? "";
      expect(stdin).toContain("34 percent");
      expect(logged).toBe(stdin);
      store.close();
      const db = readFileSync(join(dir, "dispatch.db")).toString("latin1");
      const health = JSON.stringify(provider.readerHealth());
      for (const p of PRIVATE) {
        expect(stdin).not.toContain(p);
        expect(spawner.requests[1]?.argv.join(" ")).not.toContain(p);
        expect(db).not.toContain(p);
        expect(health).not.toContain(p);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grounding rejects an invented number: the whole reading is discarded", async () => {
    const result = JSON.stringify({
      windows: [
        {
          label: "week (all models)",
          usedPercent: 34,
          resetText: "Nov 11 at 10am",
          timeZone: TIRANE,
        },
        { label: "week (Fable)", usedPercent: 77, resetText: "Nov 11 at 10am", timeZone: TIRANE },
      ],
    });
    const { reader } = setup({
      "claude:usage": { variant: "changed_format" },
      "claude:usage-llm": {
        stdout: `${JSON.stringify({ type: "result", is_error: false, result })}\n`,
      },
    });
    await expect(reader.read(claude(), longCtx())).rejects.toThrow(/not grounded/);
  });

  it("rejects fallback answers that are errors, not JSON or empty", async () => {
    const answers = [
      ["not json at all", /no usable result/],
      [
        JSON.stringify({ type: "result", is_error: true, result: "rate limited" }),
        /no usable result/,
      ],
      [JSON.stringify({ type: "result", result: "sure! {not json}" }), /not valid JSON/],
      [JSON.stringify({ type: "result", result: '```json\n{"windows":[]}\n```' }), /no window/],
      [
        JSON.stringify({
          type: "result",
          result: JSON.stringify({ windows: [{ label: "you are", usedPercent: 34 }] }),
        }),
        /no window/,
      ],
    ] as const;
    for (const [stdout, error] of answers) {
      const { reader } = setup({
        "claude:usage": { variant: "changed_format" },
        "claude:usage-llm": { stdout: `${stdout}\n` },
      });
      await expect(reader.read(claude(), longCtx()), stdout).rejects.toThrow(error);
    }
  });

  it("fallback disabled by config -> no model call even with a long budget", async () => {
    const { reader, fakes } = setup(
      { "claude:usage": { variant: "changed_format" } },
      { llmFallback: false },
    );
    expect(reader.llmFallback).toBe(false);
    await expect(reader.read(claude(), longCtx())).rejects.toBeInstanceOf(QuotaFormatError);
    expect(fakes.readLog({ key: "usage-llm" })).toEqual([]);
  });

  it("empty output is a format error without any fallback", async () => {
    const { reader, fakes } = setup({ "claude:usage": { stdout: "" } });
    await expect(reader.read(claude(), longCtx())).rejects.toBeInstanceOf(QuotaFormatError);
    expect(fakes.readLog({ key: "usage-llm" })).toEqual([]);
  });
});
