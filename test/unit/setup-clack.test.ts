/**
 * The terminal (clack) prompter of `dispatch setup` [UC1]: it is chosen only when stdin and
 * stdout are TTYs, cancelling writes nothing, and the full flow (intro, detected CLIs, steps,
 * plan, trust grants, confirm, spinner, next steps) ends with the same config as the line flow.
 * A fake clack answers; fake CLIs only; nothing outside a temp HOME is touched.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import { CANCELLED, type ClackApi, clackPrompter, loadClack } from "../../src/cli/prompter.js";
import { choosePrompter, type SetupCommandDeps } from "../../src/cli/setup.js";
import { fakeCodexHost } from "../support/fake-host.js";
import { createFakes, type FakesContext, type TempHome, tempHome } from "../support/index.js";

let h: TempHome | undefined;
let fakes: FakesContext | undefined;
afterEach(() => {
  h?.cleanup();
  fakes?.dispose();
  h = undefined;
  fakes = undefined;
});

const CANCEL = Symbol("clack:cancel");

/**
 * A fake clack. Prompts answer from `answers` in order (a function gets the prompt options;
 * `undefined` takes the prompt's initial value); prompt number `cancelAt` is cancelled.
 */
function fakeClack(answers: unknown[] = [], cancelAt = -1) {
  const calls: string[] = [];
  let n = 0;
  const prompt = (kind: string, o: { message: string; initialValue?: unknown }) => {
    calls.push(`${kind} ${o.message}`);
    if (n++ === cancelAt) return CANCEL;
    const next = answers.shift();
    return next === undefined ? (o.initialValue ?? "") : next;
  };
  const api = {
    intro: (t?: string) => calls.push(`intro ${t}`),
    outro: (t?: string) => calls.push(`outro ${t}`),
    cancel: (t?: string) => calls.push(`cancel ${t}`),
    note: (m?: string, t?: string) => calls.push(`note ${t}\n${m}`),
    select: async (o: { message: string; initialValue?: unknown }) => prompt("select", o),
    confirm: async (o: { message: string; initialValue?: unknown }) => prompt("confirm", o),
    text: async (o: { message: string }) => prompt("text", o),
    spinner: () => ({
      start: (m?: string) => calls.push(`spin ${m}`),
      stop: (m?: string) => calls.push(`spun ${m}`),
    }),
    isCancel: (v: unknown) => v === CANCEL,
    log: {
      info: (m: string) => calls.push(`info ${m}`),
      warn: (m: string) => calls.push(`warn ${m}`),
    },
  };
  return { calls, api: api as unknown as ClackApi };
}

function harness(deps: Partial<SetupCommandDeps>) {
  h = tempHome();
  fakes = createFakes({});
  const env = { ...fakes.env, ...h.env };
  const io = { stdout: "", stderr: "" };
  const sink = {
    out: (t: string) => {
      io.stdout += t;
    },
    err: (t: string) => {
      io.stderr += t;
    },
  };
  const full: Partial<SetupCommandDeps> = {
    env,
    install: () => ({ nodePath: "/n/node", cliPath: "/d/cli.mjs", hookPath: "/d/hook.mjs" }),
    hosts: () => [],
    runner: () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    interactive: true,
    ask: async (q) => {
      throw new Error(`the line prompter must not be used: ${q}`);
    },
    ...deps,
  };
  const run = (...args: string[]) =>
    runCli(args, sink, buildProgram(sink, full), { platform: "darwin", env: {} });
  const dHome = h.dispatchHome;
  return { io, run, dHome, configPath: join(dHome, "config.yaml") };
}

describe("choosePrompter [UC1]", () => {
  const io = { out: () => {}, err: () => {} };
  const base = { ask: async () => "" } as unknown as SetupCommandDeps;

  it("clack only when stdin and stdout are TTYs; the line prompter otherwise; none without a person", async () => {
    let loaded = 0;
    const clack = async () => {
      loaded++;
      return fakeClack().api;
    };
    expect((await choosePrompter(io, { ...base, tty: true, clack }, true))?.rich).toBe(true);
    expect(loaded).toBe(1);
    expect((await choosePrompter(io, { ...base, tty: false, clack }, true))?.rich).toBe(false);
    expect((await choosePrompter(io, { ...base, clack }, true))?.rich).toBe(false);
    expect(await choosePrompter(io, { ...base, tty: true, clack }, false)).toBeNull();
    expect(loaded).toBe(1);
  });

  it("the real @clack/prompts module provides every function the prompter uses", async () => {
    const real = await loadClack();
    for (const f of ["intro", "outro", "cancel", "note", "select", "confirm", "text", "spinner"]) {
      expect(typeof (real as unknown as Record<string, unknown>)[f], f).toBe("function");
    }
    expect(typeof real.log.warn).toBe("function");
  });
});

describe("setup with the clack prompter [UC1]", () => {
  it("cancelling a question exits 2 with 'nothing was changed' and writes no file", async () => {
    const fake = fakeClack([], 0);
    const k = harness({ tty: true, clack: async () => fake.api });
    expect(await k.run("setup")).toBe(2);
    expect(fake.calls).toContain(`cancel ${CANCELLED}`);
    expect(CANCELLED).toMatch(/nothing was changed/);
    expect(existsSync(k.configPath)).toBe(false);
    expect(existsSync(join(k.dHome, "bin"))).toBe(false);
  });

  it("cancelling the final confirmation writes no file either", async () => {
    // Questions: host, claude plan, codex plan, agy (confirm), strategy, autonomy, then Apply.
    const fake = fakeClack([], 6);
    const k = harness({ tty: true, clack: async () => fake.api });
    expect(await k.run("setup")).toBe(2);
    expect(fake.calls.at(-2)).toBe("confirm Apply these changes?");
    expect(existsSync(k.dHome)).toBe(false);
  });

  it("declining the confirmation ends with 'Nothing was changed.' and exit 0", async () => {
    const fake = fakeClack([undefined, undefined, undefined, false, undefined, undefined, false]);
    const k = harness({ tty: true, clack: async () => fake.api });
    expect(await k.run("setup")).toBe(0);
    expect(fake.calls.at(-1)).toBe("outro Nothing was changed.");
    expect(existsSync(k.dHome)).toBe(false);
  });

  it("the full flow: banner, detected CLIs, numbered steps, plan, grants, spinner, next steps", async () => {
    const fake = fakeClack(["codex", "max5x", "plus", false, "preserve", "read-only", true]);
    const k = harness({ tty: true, clack: async () => fake.api, hosts: () => [fakeCodexHost()] });
    expect(await k.run("setup")).toBe(0);
    const calls = fake.calls.join("\n");
    expect(fake.calls[0]).toMatch(/^intro .*Dispatch setup · v\d+\.\d+\.\d+/);
    expect(calls).toMatch(/note Detected CLIs\n✔ claude .*\n✔ codex /);
    expect(calls).toContain("select Step 1/4 · Which client do you mainly work in?");
    expect(calls).toContain("select Step 2/4 · Which claude plan do you pay for?");
    expect(calls).toContain("select Step 3/4 · Which strategy should Dispatch start with?");
    expect(calls).toContain("select Step 4/4 · How much may delegated agents do on their own?");
    // The Antigravity warning stays prominent and the opt-in defaults to no.
    expect(calls).toMatch(/warn Antigravity \(agy\) is EXPERIMENTAL/);
    expect(calls).toContain("confirm Do you want to enable Antigravity anyway?");
    expect(calls).toMatch(/note Plan\n.*Dispatch setup will make these changes:/);
    expect(calls).toMatch(/Global config: create ~\/\.dispatch\/config\.yaml/);
    expect(calls).toMatch(/note Trust grants\n/);
    expect(calls).toMatch(/spun .*Setup done: \d+ applied/);
    expect(calls).toMatch(/note Next steps\n.*\/hooks/);
    expect(fake.calls.at(-1)).toMatch(/^outro .*Dispatch is set up\./);
    const config = readFileSync(k.configPath, "utf8");
    expect(config).toMatch(/^main_host: codex$/m);
    expect(config).toMatch(/^profile: preserve$/m);
    expect(config).toMatch(/^autonomy: read-only$/m);
    expect(k.io.stdout).toBe("");
  });

  it("the Antigravity opt-in still needs the typed 'yes': anything else keeps it off", async () => {
    // host, claude plan, codex plan, agy opt-in (yes), terms text ("ok"), strategy, autonomy, apply.
    const fake = fakeClack([
      undefined,
      undefined,
      undefined,
      true,
      "ok",
      undefined,
      undefined,
      true,
    ]);
    const k = harness({ tty: true, clack: async () => fake.api });
    expect(await k.run("setup")).toBe(0);
    expect(fake.calls).toContain(
      'text Type "yes" to confirm you accept the risk and Google\'s terms',
    );
    expect(fake.calls).toContain("info Terms not accepted: Antigravity stays off.");
    expect(readFileSync(k.configPath, "utf8")).not.toMatch(/tos_acknowledged: true/);
  });

  it("clackPrompter.select maps labels to hints and returns the picked value", async () => {
    const fake = fakeClack(["b"]);
    const p = clackPrompter(fake.api);
    const opts = [
      { value: "a", label: "first" },
      { value: "b", label: "" },
    ] as const;
    expect(await p.select("Pick", opts, "a")).toBe("b");
    expect(fake.calls).toEqual(["select Pick"]);
  });
});
