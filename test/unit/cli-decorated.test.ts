/**
 * Decorated (terminal) forms of the CLI output: the run summary block, the run spinner text and
 * store tap, the install/uninstall lines and the grouped setup plan preview. The plain forms stay
 * free of ANSI codes.
 */
import { describe, expect, it } from "vitest";
import { phaseText, renderRunResult, tapStore } from "../../src/cli/commands/run.js";
import { styleInstallLine } from "../../src/cli/repo-commands.js";
import { renderPlanPreview, setupNextSteps } from "../../src/cli/setup-preview.js";
import { createUi, plainUi } from "../../src/cli/ui.js";
import type {
  DecisionRecord,
  EditOp,
  NormalizedEvent,
  RunResult,
} from "../../src/core/contracts.js";

const ui = createUi(true);
const ESC = "\x1b[";

const result = (over: Partial<RunResult>): RunResult => ({
  schemaVersion: 1,
  runId: "r1",
  status: "completed",
  externalAgent: null,
  outcome: "success",
  summary: "",
  patch: null,
  log: { path: "/home/me/repo/.dispatch/state/runs/r1/events.jsonl" },
  decisions: [],
  durationMs: 83_000,
  ...over,
});

describe("run summary block", () => {
  const agent = {
    provider: "codex",
    instance: "codex",
    model: "gpt-x",
    marker: "EXTERNAL_AGENT_OUTPUT" as const,
  };
  const patch = {
    path: "/home/me/repo/.dispatch/state/runs/r1/patch.diff",
    diffstat: " src/a.ts | 3 ++-\n",
    applies: true,
    rejectedPaths: [],
    needsReview: false,
  };

  it("shows outcome symbol, provider, duration, tildified patch path and applies yes/no", () => {
    const text = renderRunResult(
      result({
        externalAgent: agent,
        summary: "did it",
        patch,
        decisions: [{ action: "delegate", reason: "most quota" } as RunResult["decisions"][number]],
      }),
      { ui, home: "/home/me" },
    );
    expect(text).toContain("✔");
    expect(text).toContain("codex");
    expect(text).toContain("1m");
    expect(text).toContain("~/repo/.dispatch/state/runs/r1/patch.diff");
    expect(text).toContain("applies: yes");
    expect(text).toContain("src/a.ts | 3 ++-");
    expect(text).toContain("EXTERNAL AGENT OUTPUT (untrusted");
    expect(text).toContain("  did it");
    expect(text).toContain("Log: ~/repo/.dispatch/state/runs/r1/events.jsonl");
    expect(text).toContain(ESC);
  });

  it("marks hand-backs and failures, empty and flagged patches, and nests fanout children", () => {
    const back = renderRunResult(result({ status: "returned_to_host", outcome: null }), { ui });
    expect(back).toContain("⚠");
    const failed = renderRunResult(
      result({
        outcome: "failed",
        summary: "boom",
        patch: { ...patch, applies: false, needsReview: true, rejectedPaths: [".env"] },
        results: [result({ runId: "child", outcome: "timeout" })],
      }),
      { ui },
    );
    expect(failed).toContain("✖");
    expect(failed).toContain("applies: no");
    expect(failed).toContain("needs review");
    expect(failed).toContain("dropped paths: .env");
    expect(failed).toContain("Reason: boom");
    expect(failed).toMatch(/ {2}\| .*run child/);
    const none = renderRunResult(result({ patch: { ...patch, diffstat: "" } }), { ui });
    expect(none).toContain("none (every change was rejected; nothing to apply)");
  });

  it("plain stays the stable text form without ANSI", () => {
    const text = renderRunResult(result({ externalAgent: agent, summary: "x", patch }));
    expect(text).toMatch(/^Run r1: completed \(success\)\n/);
    expect(text).toContain("Patch: /home/me/repo/.dispatch/state/runs/r1/patch.diff");
    expect(text).not.toContain(ESC);
    expect(renderRunResult(result({}), { ui: plainUi })).toBe(renderRunResult(result({})));
  });
});

describe("run progress", () => {
  it("phaseText names the provider, the phase and its path or detail", () => {
    const ts = "2026-11-07T10:00:00.000Z";
    expect(phaseText(null, undefined)).toBe("routing · starting");
    expect(phaseText("codex", { kind: "editing", ts, path: "src/a.ts" })).toBe(
      "codex · editing src/a.ts",
    );
    expect(phaseText("codex", { kind: "running", ts, detail: "pnpm\n  test" })).toBe(
      "codex · running pnpm test",
    );
    expect(phaseText("c", { kind: "thinking", ts, detail: "x".repeat(200) })).toHaveLength(72);
  });

  it("tapStore reports decisions and events and still writes through", async () => {
    const written: string[] = [];
    const store = {
      tag: "real",
      appendEvent: async (id: string, _ev: NormalizedEvent) => {
        written.push(`event ${id}`);
      },
      recordDecision: async (r: DecisionRecord) => {
        written.push(`decision ${r.id}`);
      },
      other() {
        return this.tag;
      },
    };
    const seen: string[] = [];
    const tapped = tapStore(
      store,
      (instance) => seen.push(`instance ${instance}`),
      (ev) => seen.push(`kind ${ev.kind}`),
    );
    await tapped.appendEvent("r1", { kind: "reading", ts: "2026-11-07T10:00:00.000Z" });
    await tapped.recordDecision({
      id: "d1",
      decision: { targets: [{ instance: "codex" }] },
    } as unknown as DecisionRecord);
    await tapped.recordDecision({
      id: "d2",
      decision: { targets: [] },
    } as unknown as DecisionRecord);
    expect(tapped.other()).toBe("real");
    expect(tapped.tag).toBe("real");
    expect(written).toEqual(["event r1", "decision d1", "decision d2"]);
    expect(seen).toEqual(["kind reading", "instance codex", "instance null"]);
  });
});

describe("install lines", () => {
  it("decorates creations, removals, warnings and results; plain passes through", () => {
    expect(styleInstallLine(plainUi, "  + a\n")).toBe("  + a\n");
    expect(styleInstallLine(ui, "  + a\n")).toContain(`${ESC}32m+`);
    expect(styleInstallLine(ui, "  - a\n")).toContain(`${ESC}33m-`);
    expect(styleInstallLine(ui, "  = a\n")).toContain(`${ESC}2m`);
    expect(styleInstallLine(ui, "warning: kept x\n")).toContain("⚠");
    expect(styleInstallLine(ui, "Aborted; nothing was changed.\n")).toContain("⚠");
    expect(styleInstallLine(ui, "Removed 3 file(s).\n")).toContain("✔");
    expect(styleInstallLine(ui, "other\n")).toBe("other\n");
  });
});

describe("setup plan preview", () => {
  const op = (file: string, trustGrant: string | null = null): EditOp => ({
    file,
    kind: "new-file",
    signature: "s",
    content: "",
    mode: "0644",
    trustGrant,
  });
  const plan = {
    groups: [
      { host: "dispatch", ops: [op("/home/me/.dispatch/bin/dispatch")] },
      { host: "codex", ops: [op("/home/me/.codex/rules/dispatch.rules", "lets ONLY x run")] },
      { host: "other", ops: [op("/home/me/.other/x", "a grant")] },
    ],
    stale: [{ file: "/home/me/.old" }] as never,
    detected: ["codex"],
    absent: ["claude-code"],
  };
  const change = {
    path: "/home/me/.dispatch/config.yaml",
    mode: "create" as const,
    lines: ["main client: codex"],
  };

  it("plain: grouped by destination, ~/ paths, grants with a short line and the exact text", () => {
    const p = renderPlanPreview(plan, change, { home: "/home/me" });
    expect(p.changes).toContain("\nDispatch\n  + Global config: create ~/.dispatch/config.yaml\n");
    expect(p.changes).toContain("      main client: codex\n");
    expect(p.changes).toContain("  + create ~/.dispatch/bin/dispatch (mode 0644)");
    expect(p.changes).toContain("\nCodex\n  + create ~/.codex/rules/dispatch.rules");
    expect(p.changes).toContain(
      "No longer planned\n  - remove the earlier Dispatch edit in ~/.old",
    );
    expect(p.changes).toContain("Hosts detected: codex");
    expect(p.changes).toContain("Hosts not found (nothing is written for them): claude-code");
    expect(p.grants).toMatch(/^Trust grants \(they give a host extra authority/);
    expect(p.grants).toContain("  Codex may run the Dispatch launcher outside its sandbox");
    expect(p.grants).toContain("    ~/.codex/rules/dispatch.rules: lets ONLY x run");
    expect(p.grants).toContain("  other:\n    ~/.other/x: a grant");
    expect(`${p.changes}${p.grants}`).not.toContain(ESC);
  });

  it("decorated: colors and a warning symbol on the grants; nothing to grant gives no block", () => {
    const p = renderPlanPreview(plan, null, { ui, home: "/home/me" });
    expect(p.grants).toContain("⚠");
    expect(p.changes).toContain(ESC);
    const none = renderPlanPreview(
      { groups: [plan.groups[0] as never], stale: [], detected: [], absent: [] },
      null,
    );
    expect(none.grants).toBe("");
  });

  it("next steps mention /hooks only when Codex was set up", () => {
    expect(setupNextSteps(["codex"]).map(([c]) => c)).toContain("codex → /hooks");
    expect(setupNextSteps(["claude-code"]).map(([c]) => c)).not.toContain("codex → /hooks");
    expect(setupNextSteps([]).map(([c]) => c)).toEqual([
      "dispatch install",
      "new session",
      "dispatch doctor",
    ]);
  });
});

describe("doctor copy-paste lines keep absolute paths", () => {
  it("fix and continuation lines are not tildified", async () => {
    const { renderLines } = await import("../../src/doctor/render.js");
    const home = "/home/u";
    const rule = "Bash(/home/u/.dispatch/bin/dispatch run:*)";
    const text = renderLines(
      [
        {
          section: "host",
          id: "x.rule",
          status: "warn",
          message: `add:\n  ${rule}`,
          fix: `add ${rule}`,
        },
      ],
      { home, verbose: false },
    );
    expect(text).toContain(`  ${rule}`);
    expect(text).toContain(`fix: add ${rule}`);
    expect(text).not.toContain("Bash(~/");
  });
});
