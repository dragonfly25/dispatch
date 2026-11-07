import { describe, expect, it } from "vitest";
import { type FakeSubConfig, withFakes } from "../support/index.js";
import { isAlive, sleep, startFake, waitFor } from "./fakes-helpers.js";

type Obj = Record<string, unknown>;

/** Starts `codex app-server` with `cfg`, performs the handshake unless told not to, and reads rate limits. */
async function session(cfg: FakeSubConfig, opts: { skipInit?: boolean; extra?: Obj[] } = {}) {
  return withFakes({ "codex:app-server": cfg }, async (ctx) => {
    const { child, done } = startFake(ctx, "codex", ["app-server"], { keepStdin: true });
    const send = (m: Obj) => child.stdin?.write(`${JSON.stringify(m)}\n`);
    if (!opts.skipInit) {
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "dispatch-test", version: "0" } },
      });
      send({ method: "initialized" });
    }
    send({ id: 2, method: "account/rateLimits/read" });
    for (const m of opts.extra ?? []) send(m);
    if (cfg.variant === "hang") {
      await sleep(400);
      const alive = isAlive(child.pid as number);
      child.kill("SIGTERM");
      const r = await done;
      return { raw: r.stdout, alive, code: r.code, log: ctx.readLog({ key: "app-server" })[0] };
    }
    child.stdin?.end();
    const r = await done;
    return {
      raw: r.stdout,
      alive: false,
      code: r.code,
      log: ctx.readLog({ key: "app-server" })[0],
    };
  });
}

const parse = (raw: string): { messages: Obj[]; garbage: string[] } => {
  const messages: Obj[] = [];
  const garbage: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      messages.push(JSON.parse(line) as Obj);
    } catch {
      garbage.push(line);
    }
  }
  return { messages, garbage };
};
const response = (messages: Obj[], id: number): Obj | undefined =>
  messages.find((m) => m.id === id);
const resultOf = <T>(messages: Obj[], id: number): T => (response(messages, id)?.result ?? {}) as T;
const notifications = (messages: Obj[]): string[] =>
  messages.filter((m) => m.id === undefined).map((m) => m.method as string);

describe("fake codex app-server [AC1]", () => {
  it("[AC1] ok: initialize -> initialized -> account/rateLimits/read with notifications interleaved", async () => {
    const { raw, code, log } = await session({ variant: "ok" });
    const { messages, garbage } = parse(raw);
    expect(code).toBe(0);
    expect(garbage).toEqual([]);
    expect(messages.every((m) => m.jsonrpc === undefined)).toBe(true);

    // A notification arrives before the initialize response, and others around the read response.
    const order = messages.map((m) => (m.id === undefined ? `n:${m.method}` : `r:${m.id}`));
    expect(order.indexOf("n:configWarning")).toBeLessThan(order.indexOf("r:1"));
    expect(order.indexOf("n:account/rateLimits/updated")).toBeLessThan(order.indexOf("r:2"));
    expect(order.indexOf("r:2")).toBeLessThan(order.indexOf("n:thread/status/changed"));
    expect(notifications(messages)).toContain("account/updated");

    const result = response(messages, 2)?.result as { rateLimits: Obj; rateLimitsByLimitId: Obj };
    const snap = result.rateLimits as {
      primary: Obj;
      secondary: Obj;
      ordinaryUsageAllowed: boolean;
      rateLimitReachedType: unknown;
      planType: string;
    };
    expect(snap.primary).toMatchObject({ usedPercent: 42, windowDurationMins: 300 });
    expect(snap.secondary).toMatchObject({ usedPercent: 17, windowDurationMins: 10080 });
    expect(typeof snap.primary.resetsAt).toBe("number");
    expect(snap.ordinaryUsageAllowed).toBe(true);
    expect(snap.rateLimitReachedType).toBeNull();
    expect(snap.planType).toBe("plus");
    expect(result.rateLimitsByLimitId.codex).toEqual(snap);

    expect(log?.rpcReceived?.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(log?.exitCode).toBe(0);
  });

  it("[AC1] ok with exhausted usage reports the limit", async () => {
    const { raw } = await session({
      variant: "ok",
      primaryUsed: 100,
      secondaryUsed: 60,
      planType: "pro",
    });
    const snap = resultOf<{ rateLimits: Obj }>(parse(raw).messages, 2).rateLimits;
    expect(snap).toMatchObject({
      ordinaryUsageAllowed: false,
      rateLimitReachedType: "rate_limit_reached",
      planType: "pro",
    });
  });

  it("[AC1] notifications can be disabled and jsonrpc added", async () => {
    const { raw } = await session({ variant: "ok", notifications: false, jsonrpc: true });
    const { messages } = parse(raw);
    expect(notifications(messages)).toEqual([]);
    expect(messages.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(response(messages, 2)?.result).toBeDefined();
  });

  it("[AC1] changed_format returns a result without primary/secondary windows", async () => {
    const { raw } = await session({ variant: "changed_format" });
    const result = response(parse(raw).messages, 2)?.result as Obj;
    expect(result.rateLimits).toBeUndefined();
    expect(result.limits).toBeDefined();
  });

  it("[AC1] always_zero returns well-formed windows that are all zero", async () => {
    const { raw } = await session({ variant: "always_zero", primaryUsed: 80 });
    const snap = resultOf<{ rateLimits: { primary: Obj; secondary: Obj } }>(
      parse(raw).messages,
      2,
    ).rateLimits;
    expect(snap.primary.usedPercent).toBe(0);
    expect(snap.secondary.usedPercent).toBe(0);
    expect(snap.primary.windowDurationMins).toBe(300);
  });

  it("[AC1] garbage emits a non-JSON line and a non-object result", async () => {
    const { raw } = await session({ variant: "garbage" });
    const { messages, garbage } = parse(raw);
    expect(garbage).toEqual(["<<< not json >>>"]);
    expect(response(messages, 2)?.result).toBe("not-an-object");
  });

  it("[AC1] rpc_error answers the read with a JSON-RPC error", async () => {
    const { raw } = await session({
      variant: "rpc_error",
      errorCode: -32001,
      errorMessage: "nope",
    });
    expect(response(parse(raw).messages, 2)).toMatchObject({
      error: { code: -32001, message: "nope" },
    });
    const dflt = await session({ variant: "rpc_error" });
    expect(response(parse(dflt.raw).messages, 2)).toMatchObject({ error: { code: -32603 } });
  });

  it("[AC1] hang answers initialize but never the read, and ignores stdin EOF until killed", async () => {
    const { raw, alive } = await session({ variant: "hang" });
    const { messages } = parse(raw);
    expect(response(messages, 1)?.result).toBeDefined();
    expect(response(messages, 2)).toBeUndefined();
    expect(alive).toBe(true);
  });

  it("[AC1] hang at initialize never answers the handshake", async () => {
    const { raw, alive } = await session({ variant: "hang", hangAt: "initialize" });
    expect(response(parse(raw).messages, 1)).toBeUndefined();
    expect(alive).toBe(true);
  });

  it("[AC1] a read before initialize is rejected; unknown methods and bad JSON get errors", async () => {
    const { raw, log } = await session(
      { variant: "ok" },
      { skipInit: true, extra: [{ id: 3, method: "no/such" }] },
    );
    const { messages } = parse(raw);
    expect(response(messages, 2)).toMatchObject({ error: { code: -32002 } });
    expect(response(messages, 3)).toMatchObject({ error: { code: -32601 } });

    const { child, done } = await withFakes({}, async (ctx) => {
      const started = startFake(ctx, "codex", ["app-server"], { keepStdin: true });
      started.child.stdin?.write("not json\n");
      started.child.stdin?.end();
      const result = await started.done;
      return { child: result, done: ctx.readLog()[0] };
    });
    expect(child.stdout).toContain('"code":-32700');
    expect(done?.rpcReceived).toEqual([{ unparsable: "not json" }]);
    expect(log?.rpcReceived).toHaveLength(2);
  });

  it("[AC1] the server exits when stdin closes and logs a clean exit", async () => {
    await withFakes({}, async (ctx) => {
      const { child, done } = startFake(ctx, "codex", ["app-server"], { keepStdin: true });
      await waitFor(() => ctx.readLog()[0]);
      child.stdin?.end();
      expect((await done).code).toBe(0);
    });
  });
});
