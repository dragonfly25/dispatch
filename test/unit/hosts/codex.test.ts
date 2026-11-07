/** WP27: Codex host integration (skill, hooks, rules), setup/uninstall, rules table and doctor. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../../src/cli/program.js";
import { ExitCode, type HostIntegration } from "../../../src/core/contracts.js";
import {
  applySetup,
  planSetup,
  readManifest,
  type SetupContext,
  uninstallGlobal,
} from "../../../src/hosts/_framework/index.js";
import { codexDoctorChecks, rulesLauncher } from "../../../src/hosts/codex/doctor.js";
import { writeHeartbeat } from "../../../src/hosts/codex/hook.js";
import {
  codexHomeDir,
  codexPaths,
  createCodexIntegration,
  HOOKS_GRANT,
  rulesGrant,
} from "../../../src/hosts/codex/integration.js";
import { builtinRegistry } from "../../../src/hosts/index.js";
import { CODEX_SANDBOX_MESSAGE } from "../../../src/platform/host.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

const NONE = { isExecutableFile: () => false, realpath: (p: string) => p };

function host(env: Record<string, string> = {}): HostIntegration {
  return createCodexIntegration({ env: () => ({ HOME: h.home, PATH: "/none", ...env }), fs: NONE });
}

function ctx(hosts: HostIntegration[]): SetupContext {
  return {
    home: h.home,
    dispatchHome: h.dispatchHome,
    install: {
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/d/cli.mjs",
      hookPath: "/opt/d/hook.mjs",
    },
    hosts,
  };
}

const launcher = () => join(h.dispatchHome, "bin", "dispatch");
const paths = () => codexPaths({}, h.home);

/** A temp HOME with `~/.codex` (and a config.toml Dispatch must never touch). */
function codexHome(): string {
  h = tempHome();
  mkdirSync(join(h.home, ".codex"));
  writeFileSync(join(h.home, ".codex", "config.toml"), 'model = "gpt-6-luna"\n');
  return join(h.home, ".codex", "config.toml");
}

describe("codex integration: identity and detection", () => {
  it("deny_redirect, the V2-aware matcher, wait 280; env-only self-detection", () => {
    h = tempHome();
    const c = host();
    expect(c.subagentStrategy).toBe("deny_redirect");
    expect(c.subagentMatcher).toBe("spawn_agent|collaborationspawn_agent|Agent");
    expect(c.waitTimeoutSec).toBe(280);
    expect(c.detectSelf({})).toBeNull();
    expect(c.detectSelf({ CODEX_THREAD_ID: "t" })).toEqual({ host: "codex", version: null });
    expect(c.detectSelf({ CODEX_VERSION: "0.167.0" })).toEqual({
      host: "codex",
      version: "0.167.0",
    });
    expect(c.detectSelf({ CODEX_VERSION: "dev" })?.version).toBeNull();
    expect(Object.keys(c.hookHandlers)).toEqual(["SessionStart", "PreToolUse"]);
    expect(builtinRegistry().getHost("codex")?.id).toBe("codex");
  });

  it("detect: ~/.codex, CODEX_HOME or the binary; codexHomeDir ignores a relative CODEX_HOME", async () => {
    h = tempHome();
    const pc = { home: h.home, launcherPath: launcher(), nodePath: "/n", hookPath: "/h" };
    expect(await host().detect(pc)).toBe(false);
    const alt = join(h.home, "alt-codex");
    mkdirSync(alt);
    expect(await host({ CODEX_HOME: alt }).detect(pc)).toBe(true);
    const withBin = createCodexIntegration({
      env: () => ({ PATH: "/bin" }),
      fs: { isExecutableFile: (p) => p === "/bin/codex", realpath: (p) => p },
    });
    expect(await withBin.detect(pc)).toBe(true);
    expect(codexHomeDir({ CODEX_HOME: "rel" }, "/u")).toBe("/u/.codex");
    expect(codexHomeDir({ CODEX_HOME: "/x" }, "/u")).toBe("/x");
  });
});

describe("codex plan and preview [UC3]", () => {
  it("skill, rules (trust grant) and two hooks.json entries; preview shows grants and /hooks", async () => {
    codexHome();
    const plan = await planSetup(ctx([host()]));
    const p = paths();
    expect(plan.ops.map((o) => [o.kind, o.file])).toEqual([
      ["new-file", launcher()],
      ["new-file", p.skill],
      ["rules-file", p.rules],
      ["json-entry", p.hooks],
      ["json-entry", p.hooks],
    ]);
    const hooks = plan.ops.filter((o) => o.kind === "json-entry");
    expect(hooks.map((o) => o.signature)).toEqual([
      `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x '/opt/node/bin/node' ] && [ -f '/opt/d/hook.mjs' ] || exit 0; exec '/opt/node/bin/node' '/opt/d/hook.mjs' codex SessionStart`,
      `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x '/opt/node/bin/node' ] && [ -f '/opt/d/hook.mjs' ] || exit 0; exec '/opt/node/bin/node' '/opt/d/hook.mjs' codex PreToolUse`,
    ]);
    const pre = JSON.parse(hooks[1]?.content ?? "{}");
    expect(pre.path).toEqual(["hooks", "PreToolUse"]);
    expect(pre.value.matcher).toBe("spawn_agent|collaborationspawn_agent|Agent");
    expect(plan.preview).toContain("Trust grants");
    expect(plan.preview).toContain(`${p.rules}: ${rulesGrant(launcher())}`);
    expect(plan.preview).toContain(`${p.hooks}: ${HOOKS_GRANT}`);
    expect(plan.preview).toContain("open codex, run /hooks, approve the two Dispatch hooks");
    expect(plan.preview).toContain(`lets ONLY \`${launcher()} run|wait|cancel|status\``);
    expect(plan.ops.some((o) => /config\.toml|AGENTS\.md/.test(o.file))).toBe(false);
  });

  it("the rendered skill carries the exact rule-compatible call form and safety text", async () => {
    codexHome();
    const plan = await planSetup(ctx([host()]));
    const skill = plan.ops.find((o) => o.file === paths().skill)?.content ?? "";
    expect(skill).toContain(`${launcher()} run --detach --json --task '<task>'`);
    expect(skill).toContain(`${launcher()} wait <runId> --json --timeout 280`);
    expect(skill).toContain("write_stdin");
    expect(skill).toContain("EXTERNAL_AGENT_OUTPUT");
    expect(skill).toContain("returned_to_host");
    expect(skill).toMatch(/No `cd \.\.\. &&`, pipes/);
    expect(skill).not.toMatch(/\{\{/);
  });
});

/** The JSON-compatible lists of the rendered Starlark rule. */
function ruleParts(rules: string) {
  const list = (name: string) => {
    const m =
      new RegExp(`^    ${name} = (\\[.+\\]),$`, "m").exec(rules) ??
      new RegExp(`\\n    ${name} = (\\[[\\s\\S]*?\\n    \\]),`).exec(rules);
    return JSON.parse((m?.[1] ?? "null").replace(/,(\s*\])/g, "$1")) as unknown;
  };
  return {
    pattern: list("pattern") as [string, string[]],
    match: list("match") as string[][],
    notMatch: list("not_match") as string[][],
  };
}

/**
 * Model of Codex's matching (docs/spikes/codex.md Q2, codex-rs 0.167.0): a `zsh -lc` script is
 * split on `&& || ; |` only when every token is a plain word or a quoted string without
 * expansions; otherwise it is one unmatched command. The sandbox is bypassed only when EVERY
 * piece matches the prefix rule. Matching itself is Codex's; this test pins our rule text.
 */
function bypassesSandbox(script: string, pattern: [string, string[]]): boolean {
  const tokens: (string | { op: string })[] = [];
  const re =
    /\s*(?:(&&|\|\||;|\|)|'([^']*)'|"([^"$`\\]*)"|([A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*))/y;
  let i = 0;
  while (i < script.trimEnd().length) {
    re.lastIndex = i;
    const m = re.exec(script);
    if (m === null) return false; // unparsable: whole script unmatched
    tokens.push(m[1] !== undefined ? { op: m[1] } : (m[2] ?? m[3] ?? m[4] ?? ""));
    i = re.lastIndex;
  }
  const pieces: string[][] = [[]];
  for (const t of tokens) {
    if (typeof t === "string") pieces[pieces.length - 1]?.push(t);
    else pieces.push([]);
  }
  const [bin, subs] = pattern;
  return pieces.every((argv) => argv[0] === bin && subs.includes(argv[1] ?? ""));
}

describe("[SEC-rules] the rendered dispatch.rules", () => {
  it("allows only <abs launcher> run|wait|cancel|status; its own examples are consistent", async () => {
    codexHome();
    const plan = await planSetup(ctx([host()]));
    const op = plan.ops.find((o) => o.kind === "rules-file");
    const parts = ruleParts(op?.content ?? "");
    expect(parts.pattern).toEqual([launcher(), ["run", "wait", "cancel", "status"]]);
    expect(op?.content).toContain('decision = "allow"');
    expect(op?.content.match(/prefix_rule\(/g)).toHaveLength(1);
    expect(rulesLauncher(op?.content ?? "")).toBe(launcher());
    // Codex validates match/not_match at load time; a wrong example breaks the whole file.
    const hit = (argv: string[]) =>
      argv[0] === parts.pattern[0] && parts.pattern[1].includes(argv[1] ?? "");
    expect(parts.match.every(hit)).toBe(true);
    expect(parts.notMatch.some(hit)).toBe(false);
    expect(parts.match).toContainEqual([
      launcher(),
      "wait",
      "run_abc",
      "--json",
      "--timeout",
      "280",
    ]);
  });

  it("compound, redirect, expansion and other-binary forms never bypass the sandbox", async () => {
    codexHome();
    const plan = await planSetup(ctx([host()]));
    const { pattern } = ruleParts(plan.ops.find((o) => o.kind === "rules-file")?.content ?? "");
    const L = launcher();
    const table: [string, boolean][] = [
      [`${L} run --detach --json --task 'fix the bug'`, true],
      [`${L} run --detach --json --task "it's fine"`, true],
      [`${L} wait run_1 --timeout 280`, true],
      [`${L} cancel run_1`, true],
      [`${L} status`, true],
      [`${L} status && ${L} wait run_1`, true], // every piece allowed
      [`${L} run x && rm -rf ~`, false],
      [`${L} run x && rm -rf /tmp/y`, false],
      [`${L} run x; sh`, false],
      [`${L} run x || sh`, false],
      [`${L} status && /usr/bin/true`, false],
      [`${L} run "$(cat f)"`, false],
      [`${L} run \`cat f\``, false],
      [`${L} run "$HOME"`, false],
      [`${L} run x > /tmp/out`, false],
      [`${L} run x <<EOF`, false],
      [`(${L} run x)`, false],
      [`cd /tmp && ${L} run x`, false],
      [`printf x | ${L} run`, false],
      [`bash -lc "${L} run x"`, false],
      ["dispatch run x", false],
      ["~/.dispatch/bin/dispatch run x", false],
      ["/tmp/evil/dispatch run x", false],
      [`${L} install`, false],
      [`${L} setup`, false],
      [`${L} uninstall --global`, false],
      [`${L}`, false],
    ];
    for (const [script, expected] of table) {
      expect([script, bypassesSandbox(script, pattern)]).toEqual([script, expected]);
    }
  });

  it("when the rule does not match, the launcher fails fast on CODEX_SANDBOX (exit 3)", async () => {
    let err = "";
    const io = {
      out: () => {},
      err: (t: string) => {
        err += t;
      },
    };
    const env = { CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" };
    for (const args of [
      ["run", "--task", "x"],
      ["wait", "run_1"],
    ]) {
      err = "";
      const code = await runCli(args, io, undefined, { platform: process.platform, env });
      expect(code).toBe(ExitCode.REJECTED);
      expect(err).toContain(CODEX_SANDBOX_MESSAGE);
    }
  });
});

const JSONC = `{
  // my own hooks
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo mine" }] }, // keep me
    ],
    "Stop": [{ "hooks": [] }],
  },
}
`;

describe("codex setup + uninstall --global [UC14]", () => {
  it.each([
    ["pre-existing JSONC with user hooks and comments", JSONC],
    ["no hooks.json", null],
  ])(
    "leaves hooks.json byte-identical (%s); rules and skill removed; config.toml untouched",
    async (_n, original) => {
      const configToml = codexHome();
      const tomlBefore = readFileSync(configToml, "utf8");
      const p = paths();
      if (original !== null) writeFileSync(p.hooks, original);
      const plan = await planSetup(ctx([host()]));
      const summary = await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true });
      expect(summary.applied).toHaveLength(plan.ops.length);

      const during = readFileSync(p.hooks, "utf8");
      if (original !== null) {
        expect(during).toContain("// keep me");
        expect(during).toContain("echo mine");
      }
      expect(during).toContain("codex SessionStart");
      expect(during).toContain('"matcher": "spawn_agent|collaborationspawn_agent|Agent"');
      expect(readFileSync(p.rules, "utf8")).toContain(`"${launcher()}"`);
      expect(existsSync(p.skill)).toBe(true);
      // Idempotent: a second setup changes nothing.
      const again = await applySetup(await planSetup(ctx([host()])), {
        dispatchHome: h.dispatchHome,
        confirm: true,
      });
      expect(again.applied).toEqual([]);
      expect(readFileSync(p.hooks, "utf8")).toBe(during);

      await uninstallGlobal({ dispatchHome: h.dispatchHome });
      if (original === null) expect(existsSync(p.hooks)).toBe(false);
      else expect(readFileSync(p.hooks, "utf8")).toBe(original);
      expect(existsSync(p.rules)).toBe(false);
      expect(existsSync(join(h.home, ".codex", "rules"))).toBe(false);
      expect(existsSync(p.skill)).toBe(false);
      expect(existsSync(join(h.home, ".agents"))).toBe(false);
      expect(readFileSync(configToml, "utf8")).toBe(tomlBefore);
      expect(existsSync(join(h.home, ".codex", "AGENTS.md"))).toBe(false);
    },
  );
});

describe("codex doctor checks", () => {
  const NOW = new Date("2026-11-07T12:00:00.000Z");

  async function run(env: Record<string, string> = {}, now = NOW) {
    const out: Record<string, { status: string; message: string; fix?: string }> = {};
    for (const c of codexDoctorChecks({ fs: NONE, now: () => now })) {
      out[c.id] = await c.run({
        home: h.home,
        dispatchHome: h.dispatchHome,
        env: { PATH: "/none", ...env },
      });
    }
    return out;
  }

  async function installed() {
    codexHome();
    await applySetup(await planSetup(ctx([host()])), {
      dispatchHome: h.dispatchHome,
      confirm: true,
    });
  }

  it("Codex absent: every check is ok and says so", async () => {
    h = tempHome();
    const r = await run();
    expect(Object.keys(r)).toEqual(["codex.files", "codex.rules-launcher", "codex.hooks-trusted"]);
    for (const v of Object.values(r))
      expect(v).toMatchObject({ status: "ok", message: /not found/ });
  });

  it("not set up: warns with `dispatch setup`", async () => {
    codexHome();
    const r = await run();
    expect(r["codex.files"]).toMatchObject({ status: "warn", fix: "dispatch setup" });
    expect(r["codex.rules-launcher"]).toMatchObject({ status: "warn", fix: "dispatch setup" });
    expect(r["codex.hooks-trusted"]).toMatchObject({ status: "warn", fix: "dispatch setup" });
  });

  it("installed and approved: all ok, heartbeat model reported", async () => {
    await installed();
    // Anchor on the real setup time (setup stamps the wall clock), not on a fixed date.
    const setupAt = Date.parse(readManifest(h.dispatchHome).updatedAt);
    writeHeartbeat(
      h.dispatchHome,
      { hook_event_name: "SessionStart", session_id: "s", cwd: "/", model: "gpt-6-luna" },
      new Date(setupAt + 1000),
    );
    const r = await run({}, new Date(setupAt + 3_600_000));
    expect(r["codex.files"]?.status).toBe("ok");
    expect(r["codex.rules-launcher"]).toMatchObject({ status: "ok" });
    expect(r["codex.hooks-trusted"]).toMatchObject({ status: "ok", message: /gpt-6-luna/ });
  });

  it("hooks never fired, fired before the last setup, or long ago: approve in /hooks", async () => {
    await installed();
    const fix = "open codex, run /hooks, approve the two Dispatch hooks";
    expect((await run())["codex.hooks-trusted"]).toMatchObject({ status: "warn", fix });
    const beat = (at: Date) =>
      writeHeartbeat(h.dispatchHome, { hook_event_name: "x", session_id: "s", cwd: "/" }, at);
    beat(new Date("2000-01-01T00:00:00.000Z"));
    expect((await run())["codex.hooks-trusted"]).toMatchObject({
      status: "warn",
      message: /since the last setup/,
      fix,
    });
    const setupAt = Date.parse(readManifest(h.dispatchHome).updatedAt);
    beat(new Date(setupAt + 1000));
    const later = new Date(setupAt + 30 * 86_400_000);
    expect((await run({}, later))["codex.hooks-trusted"]).toMatchObject({
      status: "warn",
      message: /last fired 29 days ago/,
      fix,
    });
  });

  it("edited skill, removed hook entry, stale or foreign launcher → warn with --refresh", async () => {
    await installed();
    const p = paths();
    writeFileSync(p.skill, "edited");
    writeFileSync(p.hooks, "{}\n");
    const r = await run();
    expect(r["codex.files"]).toMatchObject({ status: "warn", fix: "dispatch setup --refresh" });
    expect(r["codex.files"]?.message).toContain(p.skill);
    expect(r["codex.files"]?.message).toContain(`${p.hooks} (hook entry)`);
    // The launcher the rule names is gone.
    chmodSync(launcher(), 0o600);
    expect((await run())["codex.rules-launcher"]).toMatchObject({
      status: "warn",
      message: /no longer exists or is not executable/,
    });
    chmodSync(launcher(), 0o755);
    // A rule written for another Dispatch home.
    const other = join(h.home, "other", "dispatch");
    mkdirSync(join(h.home, "other"));
    writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(p.rules, `prefix_rule(\n    pattern = [${JSON.stringify(other)}, ["run"]],\n)\n`);
    expect((await run())["codex.rules-launcher"]).toMatchObject({
      status: "warn",
      message: /but the launcher is/,
    });
    writeFileSync(p.rules, "# nothing\n");
    expect((await run())["codex.rules-launcher"]).toMatchObject({ message: /names no launcher/ });
    expect(rulesLauncher('pattern = ["\\x"]')).toBeNull();
  });
});
