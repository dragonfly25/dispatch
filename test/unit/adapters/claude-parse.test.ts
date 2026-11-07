import { describe, expect, it } from "vitest";
import { createClaudeAdapter, windowKind } from "../../../src/adapters/claude/index.js";
import {
  AdapterOutcomeSchema,
  NormalizedEventSchema,
  type QuotaObservation,
  QuotaObservationSchema,
} from "../../../src/core/contracts.js";
import { fixtureExit, fixtureLines, replay, runCtx } from "./helpers.js";

const adapter = createClaudeAdapter();
const TMP = "/tmp/fx";
const V = "claude/2.1.301";

function run(name: string, wt = `${TMP}/cl-iso`, scratch: Record<string, unknown> = {}) {
  const spec = `${V}/${name}`;
  const ctx = runCtx(wt, { instanceId: "claude", ...scratch });
  const lines = fixtureLines(spec, { "<TMP>": TMP });
  const r = replay(adapter, lines, ctx, { exitCode: fixtureExit(spec) });
  for (const e of r.events) NormalizedEventSchema.parse(e);
  AdapterOutcomeSchema.parse(r.outcome);
  const obs = (ctx.scratch.quotaObservations ?? []) as QuotaObservation[];
  for (const o of obs) QuotaObservationSchema.parse(o);
  return { ...r, ctx, obs };
}

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe("claude adapter: recorded fixtures 2.1.301 [UC2]", () => {
  it("[UC2] child_isolation_canary → success with both denials, usage, cost and a 7d reading", () => {
    const { events, outcome, obs, ctx } = run("child_isolation_canary");
    expect(outcome.outcome).toBe("success");
    expect(outcome.summary).toMatch(/^Results, in order/);
    expect(outcome.deniedActions).toEqual([
      `Read: ${TMP}/canary/secret.txt`,
      "Bash: curl -sS -m 5 https://example.com -o /dev/null -w '%{http_code}'",
    ]);
    expect(outcome.usage).toMatchObject({
      inputTokens: 4 + 6926 + 16446,
      outputTokens: 953,
      cachedTokens: 16446,
      costUsd: 0.00202656,
    });
    expect(ctx.scratch.model).toBe("claude-haiku-5-5");
    expect(kinds(events)).toEqual([
      "thinking",
      "reading",
      "denied",
      "running",
      "running",
      "running",
      "denied",
      "thinking",
      "done",
    ]);
    expect(events[1]).toMatchObject({ path: `${TMP}/canary/secret.txt` });
    expect(events[3]).toMatchObject({ detail: `cat ${TMP}/canary/secret.txt` });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      instanceId: "claude",
      window: {
        kind: "7d",
        usedPct: 27,
        resetAt: new Date(1794387600 * 1000).toISOString(),
        source: "claude-passive",
        reliability: "real",
      },
    });
  });

  it("[UC2] plugin_dir_session_start → success, hook events ignored", () => {
    const { outcome, events } = run("plugin_dir_session_start");
    expect(outcome).toMatchObject({ outcome: "success", summary: "PLUM-7", deniedActions: [] });
    expect(kinds(events)).toEqual(["thinking", "thinking", "done"]);
  });

  it("[UC2] read_outside_cwd_needs_permission → one denial per tool call (deduplicated)", () => {
    const { outcome, events } = run("read_outside_cwd_needs_permission");
    expect(outcome.outcome).toBe("success");
    expect(outcome.deniedActions).toEqual([
      `Read: ${TMP}/canary/secret.txt`,
      "Bash: curl -sS -m 5 https://example.com -o /dev/null -w '%{http_code}'",
    ]);
    expect(events.filter((e) => e.kind === "denied")).toHaveLength(2);
  });

  it("[UC2] sandbox_denyread_bash → success; an OS 'Operation not permitted' is not a denial", () => {
    const { outcome } = run("sandbox_denyread_bash");
    expect(outcome.outcome).toBe("success");
    expect(outcome.deniedActions).toEqual([]);
    expect(outcome.summary).toMatch(/Operation not permitted/);
  });

  it("quota_exhausted (synthetic) → quota_exhausted with signal, resetAt and a full 5h window", () => {
    const { outcome, obs } = run("quota_exhausted");
    expect(outcome.outcome).toBe("quota_exhausted");
    expect(outcome.quotaSignal?.source).toBe("claude.rate_limit_event.rejected");
    expect(outcome.resetAt).toBe(new Date(1794400000 * 1000).toISOString());
    expect(outcome.summary).toMatch(/hit your session limit/);
    expect(obs[0]?.window).toMatchObject({ kind: "5h", usedPct: 100 });
  });

  it("worktree-relative paths for files inside the worktree", () => {
    const ctx = runCtx("/wt");
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-07T08:00:00Z",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/wt/src/a.ts" } },
          { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/wt" } },
          { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo", path: "src" } },
          { type: "tool_use", id: "t4", name: "Glob", input: {} },
          { type: "tool_use", id: "t5", name: "WebFetch", input: {} },
          { type: "tool_use", id: "t6", name: "NotebookEdit", input: {} },
        ],
      },
    });
    expect(adapter.parseLine("stdout", line, ctx)).toEqual([
      { kind: "editing", ts: "2026-11-07T08:00:00.000Z", detail: "Edit", path: "src/a.ts" },
      { kind: "editing", ts: "2026-11-07T08:00:00.000Z", detail: "Write", path: "." },
      { kind: "reading", ts: "2026-11-07T08:00:00.000Z", detail: "foo", path: "src" },
      { kind: "reading", ts: "2026-11-07T08:00:00.000Z", detail: "Glob" },
      { kind: "running", ts: "2026-11-07T08:00:00.000Z", detail: "WebFetch" },
      { kind: "editing", ts: "2026-11-07T08:00:00.000Z", detail: "NotebookEdit" },
    ]);
  });
});

const line = (o: unknown) => JSON.stringify(o);
const result = (o: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: "done", ...o });

describe("claude adapter: quota exhaustion signals", () => {
  it.each([
    [
      "assistant.error rate_limit",
      [line({ type: "assistant", error: "rate_limit", message: { content: [] } })],
      "claude.assistant.error",
    ],
    [
      "result.api_error_status 429",
      [result({ is_error: true, api_error_status: 429, result: "rate limited" })],
      "claude.api_error_status_429",
    ],
    [
      "weekly limit text in an error result",
      [result({ is_error: true, result: "You've hit your weekly limit · resets Mon" })],
      "claude.text",
    ],
    [
      "Opus limit text from a synthetic assistant message",
      [
        line({
          type: "assistant",
          message: {
            model: "<synthetic>",
            content: [{ type: "text", text: "You've hit your Opus limit" }],
          },
        }),
      ],
      "claude.text",
    ],
    ["plain-text stderr", [], "claude.text"],
  ])("%s → quota_exhausted", (name, lines, source) => {
    const ctx = runCtx("/wt");
    const stderr = name === "plain-text stderr" ? ["Error: You've hit your session limit"] : [];
    const { outcome } = replay(adapter, lines, ctx, { exitCode: 1 }, stderr);
    expect(outcome.outcome).toBe("quota_exhausted");
    expect(outcome.quotaSignal?.source).toBe(source);
    expect(outcome.resetAt).toBeUndefined();
  });

  it("does not treat agent prose about limits as exhaustion", () => {
    const ctx = runCtx("/wt");
    const text = "The handler returns 'you hit your session limit' to users.";
    const { outcome } = replay(
      adapter,
      [
        line({ type: "assistant", message: { content: [{ type: "text", text }] } }),
        result({ result: text }),
      ],
      ctx,
    );
    expect(outcome.outcome).toBe("success");
  });

  it("a rejected event with overage allowed is not exhaustion", () => {
    const ctx = runCtx("/wt");
    const rl = line({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", overageStatus: "allowed", rateLimitType: "five_hour" },
    });
    expect(replay(adapter, [rl, result()], ctx).outcome.outcome).toBe("success");
  });
});

describe("claude adapter: passive quota readings", () => {
  it("maps unifiedWindows keys and utilization; skips without an instance id", () => {
    const rl = line({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.915, resetsAt: 1794300000 },
          seven_day_opus: { utilization: 1.4, resetsAt: "bad" },
          seven_day: { resetsAt: 1794387600 },
          bogus: 3,
        },
      },
    });
    const ctx = runCtx("/wt", { instanceId: "claude-alt", quotaObservations: [] });
    adapter.parseLine("stdout", rl, ctx);
    const obs = ctx.scratch.quotaObservations as QuotaObservation[];
    expect(
      obs.map((o) => [o.instanceId, o.window?.kind, o.window?.usedPct, o.window?.resetAt]),
    ).toEqual([
      ["claude-alt", "5h", 91.5, new Date(1794300000 * 1000).toISOString()],
      ["claude-alt", "7d-opus", 100, null],
      ["claude-alt", "7d", null, new Date(1794387600 * 1000).toISOString()],
    ]);
    const anon = runCtx("/wt");
    adapter.parseLine("stdout", rl, anon);
    expect(anon.scratch.quotaObservations).toBeUndefined();
  });

  it("falls back to rateLimitType when unifiedWindows is absent", () => {
    const ctx = runCtx("/wt", { instanceId: "claude" });
    const rl = (info: Record<string, unknown>) =>
      line({ type: "rate_limit_event", rate_limit_info: info });
    adapter.parseLine(
      "stdout",
      rl({ status: "allowed", rateLimitType: "seven_day", utilization: 0.5 }),
      ctx,
    );
    adapter.parseLine("stdout", rl({ status: "allowed" }), ctx);
    adapter.parseLine("stdout", line({ type: "rate_limit_event" }), ctx);
    const obs = ctx.scratch.quotaObservations as QuotaObservation[];
    expect(obs.map((o) => o.window)).toMatchObject([{ kind: "7d", usedPct: 50, resetAt: null }]);
  });

  it("windowKind", () => {
    expect(windowKind("five_hour")).toBe("5h");
    expect(windowKind("seven_day")).toBe("7d");
    expect(windowKind("seven_day_sonnet")).toBe("7d-sonnet");
    expect(windowKind("monthly")).toBe("monthly");
  });
});

describe("claude adapter: outcomes [UC13]", () => {
  it("[UC13] timeout keeps the partial summary and usage-less outcome", () => {
    const ctx = runCtx("/wt");
    const { outcome } = replay(
      adapter,
      [line({ type: "assistant", message: { content: [{ type: "text", text: "half way" }] } })],
      ctx,
      { exitCode: null, signal: "SIGKILL", timedOut: true, durationMs: 5000 },
    );
    expect(outcome).toMatchObject({ outcome: "timeout", summary: "half way", durationMs: 5000 });
    expect(outcome.usage).toBeUndefined();
  });

  it("sandbox unavailable at startup → rejected with an explanation", () => {
    const ctx = runCtx("/wt");
    const { outcome } = replay(adapter, [], ctx, { exitCode: 1 }, [
      "Error: sandbox is required (failIfUnavailable) but not available: bwrap not found",
    ]);
    expect(outcome.outcome).toBe("rejected");
    expect(outcome.nativeError).toMatch(/OS sandbox is unavailable.*bubblewrap.*bwrap not found/s);
  });

  it("max turns → failed with the subtype", () => {
    const ctx = runCtx("/wt");
    const { outcome, events } = replay(
      adapter,
      [
        result({
          subtype: "error_max_turns",
          is_error: true,
          result: undefined,
          usage: { input_tokens: 3 },
        }),
      ],
      ctx,
      { exitCode: 1 },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.nativeError).toBe("error_max_turns");
    expect(outcome.usage).toMatchObject({ inputTokens: 3, outputTokens: 0, cachedTokens: 0 });
    expect(outcome.usage?.costUsd).toBeUndefined();
    expect(events.at(-1)?.kind).toBe("error");
  });

  it("success result with a non-zero exit → failed", () => {
    const ctx = runCtx("/wt");
    expect(replay(adapter, [result()], ctx, { exitCode: 2 }).outcome.outcome).toBe("failed");
  });

  it("only denials and no output → failed", () => {
    const ctx = runCtx("/wt");
    const { outcome } = replay(
      adapter,
      [
        line({ type: "system", subtype: "init", model: "m" }),
        line({ type: "system", subtype: "permission_denied", tool_name: "Write" }),
        result({ result: "" }),
      ],
      ctx,
    );
    expect(outcome).toMatchObject({ outcome: "failed", deniedActions: ["Write"] });
  });

  it("no result event → failed with exit info, last api retry and stderr", () => {
    const ctx = runCtx("/wt");
    const { outcome, events } = replay(
      adapter,
      [
        line({ type: "system", subtype: "init", model: "m" }),
        line({
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 10,
          error_status: 529,
          error: "overloaded",
        }),
        line({ type: "system", subtype: "api_retry" }),
      ],
      ctx,
      { exitCode: null, signal: "SIGTERM" },
      ["boom"],
    );
    expect(events.map((e) => e.detail)).toEqual([
      "api retry 2/10 (status 529: overloaded)",
      "api retry ?/? (status ?)",
    ]);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.nativeError).toBe(
      "no result event (killed by SIGTERM)\napi retry ?/? (status ?)\nboom",
    );
    const bare = runCtx("/wt");
    expect(replay(adapter, [], bare, { exitCode: 3 }).outcome.nativeError).toBe(
      "no result event (exit code 3)",
    );
  });

  it("assistant errors other than rate_limit become error events", () => {
    const ctx = runCtx("/wt");
    const ev = adapter.parseLine(
      "stdout",
      line({ type: "assistant", error: "authentication_failed", message: { content: [] } }),
      ctx,
    );
    expect(ev).toMatchObject([{ kind: "error", detail: "authentication_failed" }]);
  });
});

describe("claude adapter: malformed and unknown input never throws", () => {
  it.each([
    ["empty", ""],
    ["not json", "WARNING: this line is not json at all"],
    ["truncated json", '{"type":"assistant","message":{"content":[{"type":"te'],
    ["array", "[1,2]"],
    ["unknown type", '{"type":"zz_unknown_event","payload":{}}'],
    ["unknown system subtype", '{"type":"system","subtype":"hook_started"}'],
    ["bad content", '{"type":"assistant","message":{"content":[null,1,{"type":"text","text":5}]}}'],
    ["bad message", '{"type":"assistant","message":"x"}'],
    ["user without content", '{"type":"user","message":{}}'],
    [
      "user non-error result",
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
    ],
    [
      "user error not denial",
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":[{"type":"text","text":"Exit code 1"}]}]}}',
    ],
    ["rate limit without info", '{"type":"rate_limit_event","rate_limit_info":3}'],
    ["result with junk denials", '{"type":"result","permission_denials":[1,{"tool_input":3}]}'],
    ["bad timestamp", '{"type":"assistant","timestamp":"nope","message":{"content":[]}}'],
  ])("%s", (_name, l) => {
    const ctx = runCtx("/wt");
    const events = adapter.parseLine("stdout", l, ctx);
    for (const e of events) NormalizedEventSchema.parse(e);
    expect(() =>
      adapter.finalize({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 }, ctx),
    ).not.toThrow();
  });

  it("survives a corrupted scratch and reports an error event", () => {
    const ctx = runCtx("/wt", { claude: { tools: null } });
    const ev = adapter.parseLine(
      "stdout",
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      ctx,
    );
    expect(ev).toMatchObject([{ kind: "error" }]);
  });

  it("fake 'malformed' scenario stream", () => {
    const ctx = runCtx("/wt");
    const lines = [
      '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}',
      '{"type":"assistant","message":{"role":"assis',
      "WARNING: this line is not json at all",
      '{"type":"zz_unknown_event","payload":{}}',
      '{"type":"result","subtype":"succ',
    ];
    const { outcome } = replay(adapter, lines, ctx);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.nativeError).toMatch(/no result event/);
  });

  it("denied tool_result denials without a tool_use_id still count once each", () => {
    const ctx = runCtx("/wt");
    const denial = line({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            is_error: true,
            content: "File is in a directory that is denied by your permission settings.",
          },
        ],
      },
    });
    const { outcome } = replay(adapter, [denial, denial, result()], ctx);
    expect(outcome.deniedActions).toEqual(["tool", "tool"]);
  });
});
