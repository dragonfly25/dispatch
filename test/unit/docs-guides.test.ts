import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACME_CAPABILITIES, createAcmeAdapter } from "../../docs/guides/examples/acme-adapter.js";
import { acmeHooksCheck, acmeHost } from "../../docs/guides/examples/acme-host/index.js";
import {
  AdapterCapabilitiesSchema,
  AdapterOutcomeSchema,
  type BuildInvocationArgs,
  EditOpSchema,
  InvocationSchema,
  NormalizedEventSchema,
} from "../../src/core/contracts.js";
import { writeHookCache } from "../../src/hook/cache.js";
import { runHook } from "../../src/hook/run.js";
import {
  applySetup,
  planSetup,
  type SetupContext,
  uninstallGlobal,
} from "../../src/hosts/_framework/index.js";
import { probeResult, task } from "../fixtures/contracts.js";
import { snapshotTree, type TempHome, tempHome } from "../support/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The guide shows the examples as if they lived at their real location in `src/`. */
function asInSrc(code: string): string {
  return code
    .replaceAll('"../../../../src/hosts/', '"../')
    .replaceAll('"../../../../src/', '"../../')
    .replaceAll('"../../../src/adapters/', '"../')
    .replaceAll('"../../../src/', '"../../');
}

describe("docs/guides [AC6]", () => {
  it("the adapter guide embeds the compiled example verbatim", () => {
    const guide = read("docs/guides/writing-an-adapter.md");
    const example = asInSrc(read("docs/guides/examples/acme-adapter.ts")).trimEnd();
    expect(guide).toContain(example);
  });

  it("the host guide embeds the compiled examples verbatim", () => {
    const guide = read("docs/guides/writing-a-host-integration.md");
    for (const file of ["acme-host/index.ts", "acme-host/hook.ts"]) {
      const example = asInSrc(read(`docs/guides/examples/${file}`)).trimEnd();
      expect(guide, file).toContain(example);
    }
  });

  const buildArgs = (autonomy: BuildInvocationArgs["autonomy"]): BuildInvocationArgs => ({
    task,
    target: { instance: "acme", tier: "fast", model: "m1", effort: "low" },
    autonomy,
    worktree: "/w",
    repoRoot: "/r",
    runDir: "/run",
    instance: { id: "acme", adapter: "acme", pool: "subscription" },
    probe: { ...probeResult, binaryPath: "/usr/bin/acme" },
    baseEnv: { PATH: "/usr/bin" },
  });

  it("the example adapter honours the adapter contracts", () => {
    const a = createAcmeAdapter();
    AdapterCapabilitiesSchema.parse(ACME_CAPABILITIES);
    const inv = a.buildInvocation(buildArgs("worktree"));
    InvocationSchema.parse(inv);
    expect(inv.argv).not.toContain("--dangerously-skip-permissions");
    const ctx = { runId: "r", worktree: "/w", scratch: {} };
    const events = [
      ...a.parseLine("stdout", '{"type":"edit","path":"a.ts"}', ctx),
      ...a.parseLine("stdout", '{"type":"final","text":"done"}', ctx),
      ...a.parseLine("stdout", "not json", ctx),
    ];
    for (const e of events) NormalizedEventSchema.parse(e);
    const ok = a.finalize({ exitCode: 0, signal: null, timedOut: false, durationMs: 5 }, ctx);
    expect(AdapterOutcomeSchema.parse(ok).outcome).toBe("success");

    const quota = { runId: "r", worktree: "/w", scratch: {} };
    a.parseLine("stdout", '{"type":"error","error":"You hit your usage limit"}', quota);
    const out = a.finalize({ exitCode: 1, signal: null, timedOut: false, durationMs: 5 }, quota);
    expect(out.outcome).toBe("quota_exhausted");
    expect(() => a.buildInvocation(buildArgs("direct"))).toThrow(/direct/);
  });
});

describe("example host integration [UC14][AC2][UC9]", () => {
  let h: TempHome;
  afterEach(() => h?.cleanup());

  const WIN = process.platform === "win32";
  /** A fixture absolute path in the running platform's form (`/a/b` or `C:\\a\\b`). */
  const abs = (p: string): string => (WIN ? `C:${p.replaceAll("/", "\\")}` : p);
  /** `s` as it appears inside a JSON string. */
  const inJson = (s: string): string => JSON.stringify(s).slice(1, -1);

  const ctx = (): SetupContext => ({
    home: h.home,
    dispatchHome: h.dispatchHome,
    install: {
      nodePath: abs("/opt/node/bin/node"),
      cliPath: abs("/opt/d/cli.mjs"),
      hookPath: abs("/opt/d/hook.mjs"),
    },
    hosts: [acmeHost],
  });

  it("plans valid ops; setup then uninstall --global restores the host files byte for byte", async () => {
    h = tempHome();
    const dir = join(h.home, ".acme");
    mkdirSync(dir);
    const hooks = join(dir, "hooks.json");
    writeFileSync(hooks, '{\n  // mine\n  "hooks": { "Stop": [] }\n}\n');
    const before = snapshotTree(h.home);

    const plan = await planSetup(ctx());
    for (const op of plan.ops) EditOpSchema.parse(op);
    expect(plan.detected).toEqual(["acme"]);
    await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true });
    const text = readFileSync(hooks, "utf8");
    expect(text).toContain("// mine");
    expect(text).toContain(inJson(`'${abs("/opt/d/hook.mjs")}' acme SessionStart`));
    // The silent guard for a Dispatch child (sh on POSIX, PowerShell on Windows).
    expect(text).toContain(
      inJson(WIN ? "if ($env:DISPATCH_DEPTH) { exit 0 };" : '[ -n "$DISPATCH_DEPTH" ] && exit 0;'),
    );

    await uninstallGlobal({ dispatchHome: h.dispatchHome });
    expect(snapshotTree(h.home)).toEqual(before);
  });

  it("an absent host contributes no ops and creates nothing", async () => {
    h = tempHome();
    const plan = await planSetup(ctx());
    expect(plan.detected).toEqual([]);
    expect(plan.ops.map((o) => o.signature)).toEqual(["dispatch-launcher"]);
  });

  it("the hook handler is silent without a cache and injects context with one", async () => {
    h = tempHome();
    const table = { acme: async () => acmeHost.hookHandlers };
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: "/r" });
    const env = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = h.dispatchHome;
    try {
      expect(await runHook(["acme", "SessionStart"], input, table)).toEqual({ exitCode: 0 });
      writeHookCache(h.dispatchHome, {
        version: 1,
        writtenAt: "2026-11-07T00:00:00.000Z",
        trustedRepos: [{ root: "/r", policyHash: null }],
        policy: { profile: "balance", hardMode: false, summary: "Delegate with Dispatch." },
      });
      const res = await runHook(["acme", "SessionStart"], input, table);
      expect(JSON.parse(res.stdout ?? "{}").hookSpecificOutput.additionalContext).toBe(
        "Delegate with Dispatch. (repo policy active)",
      );
      expect(await runHook(["acme", "SessionStart"], "{broken", table)).toEqual({ exitCode: 0 });
    } finally {
      if (env === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = env;
    }
  });

  it("the example doctor check is read-only and reports a missing file as a warning", () => {
    h = tempHome();
    const ctx = { home: h.home, dispatchHome: h.dispatchHome, env: {} };
    expect(acmeHooksCheck.run(ctx)).toMatchObject({ status: "warn", fix: "dispatch setup" });
  });
});
