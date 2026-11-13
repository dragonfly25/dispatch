/**
 * Windows (win32) branches of setup and the host integrations, exercised on any OS by injecting
 * `platform: "win32"`: launcher name and format, exec-form Claude hooks, PowerShell Codex hooks,
 * no Codex rules file, node+cli invocation in the agent and skill text, doctor parsing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostIntegration } from "../../../src/core/contracts.js";
import { fromHostLines } from "../../../src/doctor/host.js";
import { launcherLine } from "../../../src/doctor/system.js";
import { renameRetrying } from "../../../src/hosts/_framework/fsutil.js";
import {
  applySetup,
  launcherPath,
  planSetup,
  type SetupContext,
} from "../../../src/hosts/_framework/index.js";
import {
  claudeDoctorChecks,
  hookPaths,
  subagentLauncher,
} from "../../../src/hosts/claude-code/doctor.js";
import { policyText } from "../../../src/hosts/claude-code/hook.js";
import {
  claudeConfigDir,
  createClaudeCodeIntegration,
} from "../../../src/hosts/claude-code/integration.js";
import { codexDoctorChecks } from "../../../src/hosts/codex/doctor.js";
import { codexPolicyText, redirectReason } from "../../../src/hosts/codex/hook.js";
import {
  CODEX_WINDOWS_NO_RULES,
  codexHomeDir,
  codexPaths,
  codexRulesSupported,
  createCodexIntegration,
} from "../../../src/hosts/codex/integration.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DIST = "C:\\Users\\o'neil\\AppData\\Roaming\\npm\\node_modules\\dispatch\\dist";
const HOOK = `${DIST}\\hook.mjs`;
const CLI = `${DIST}\\cli.mjs`;
const CLAUDE = "C:\\tools\\claude.exe";

/** Resolves only `claude.exe` in `C:\tools`. */
const FS = { isExecutableFile: (p: string) => p === CLAUDE, realpath: (p: string) => p };

function hosts(): HostIntegration[] {
  const env = () => ({ USERPROFILE: h.home, PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" });
  return [
    createClaudeCodeIntegration({ env, fs: FS, platform: "win32" }),
    createCodexIntegration({ env, fs: FS, platform: "win32" }),
  ];
}

function ctx(): SetupContext {
  return {
    home: h.home,
    dispatchHome: h.dispatchHome,
    install: { nodePath: NODE, cliPath: CLI, hookPath: HOOK },
    hosts: hosts(),
    platform: "win32",
  };
}

/** A temp home where both hosts are present (config dirs exist). */
function bothHosts(): void {
  h = tempHome();
  mkdirSync(join(h.home, ".claude"));
  mkdirSync(join(h.home, ".codex"));
}

const read = (file: string) => readFileSync(file, "utf8");

describe("setup on Windows", () => {
  it("installs dispatch.cmd (CRLF) and names it in the plan", async () => {
    bothHosts();
    const plan = await planSetup(ctx());
    const launcher = launcherPath(h.dispatchHome, "win32");
    expect(launcher.endsWith("dispatch.cmd")).toBe(true);
    expect(plan.ops[0]).toMatchObject({ file: launcher, signature: "dispatch-launcher" });
    expect(plan.ops[0]?.content).toBe(
      `@echo off\r\n"${NODE}" --disable-warning=ExperimentalWarning "${CLI}" %*\r\n`,
    );
    expect(plan.detected).toEqual(["claude-code", "codex"]);
  });

  it("Claude Code: exec-form hooks (no shell) and a node+cli invocation in the agent", async () => {
    bothHosts();
    const plan = await planSetup(ctx());
    await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner: undefined,
    }).catch(() => undefined); // the cli-command ops need a runner; the files are written first
    const plugin = join(h.dispatchHome, "hosts", "claude-code", "plugins", "dispatch");
    const hooks = JSON.parse(read(join(plugin, "hooks", "hooks.json")));
    expect(hooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: "command",
      command: NODE,
      args: [HOOK, "claude-code", "SessionStart"],
      timeout: 5,
    });
    expect(hooks.hooks.PreToolUse[0].hooks[0].args).toEqual([HOOK, "claude-code", "PreToolUse"]);
    expect(hookPaths(hooks.hooks.SessionStart[0].hooks[0])).toEqual({ node: NODE, hook: HOOK });
    const agent = read(join(plugin, "agents", "dispatch.md"));
    const call = `'${NODE}' '${DIST.replace("'", "'\\''")}\\cli.mjs'`;
    expect(agent).toContain(`${call} run --detach --json --handoff <id>`);
    expect(agent).not.toContain("dispatch.cmd");
  });

  it("Codex: PowerShell hooks, a PowerShell skill and no rules file", async () => {
    bothHosts();
    const plan = await planSetup(ctx());
    const p = codexPaths({ USERPROFILE: h.home }, h.home, "win32");
    expect(plan.ops.some((o) => o.kind === "rules-file")).toBe(false);
    expect(plan.ops.some((o) => o.file === p.rules)).toBe(false);
    const skill = plan.ops.find((o) => o.file === p.skill)?.content ?? "";
    const call = `& '${NODE}' '${DIST.replace("'", "''")}\\cli.mjs'`;
    expect(skill).toContain(`${call} run --detach --json --task-file .dispatch/inbox/<name>.md`);
    expect(skill).toContain("No rule lets it leave the Codex sandbox on Windows");
    const hookOps = plan.ops.filter((o) => o.file === p.hooks);
    expect(hookOps).toHaveLength(2);
    const start = JSON.parse(hookOps[0]?.content ?? "{}").value.hooks[0].command as string;
    expect(start).toMatch(/^if \(\$env:DISPATCH_DEPTH\) \{ exit 0 \}; /);
    expect(start).toContain(`& '${NODE}' '${HOOK.replace("'", "''")}' codex SessionStart`);
  });

  it("Codex rules are never supported on win32 and stay on POSIX", () => {
    expect(codexRulesSupported("win32")).toBe(false);
    expect(codexRulesSupported("linux")).toBe(true);
    expect(codexRulesSupported("darwin")).toBe(true);
  });
});

describe("host config dirs on Windows", () => {
  it("CLAUDE_CONFIG_DIR / CODEX_HOME are read case-insensitively and must be absolute", () => {
    expect(claudeConfigDir({ claude_config_dir: "D:\\alt" }, "C:\\Users\\u", "win32")).toBe(
      "D:\\alt",
    );
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "rel" }, "C:\\Users\\u", "win32")).toBe(
      join("C:\\Users\\u", ".claude"),
    );
    expect(codexHomeDir({ Codex_Home: "D:\\cx" }, "C:\\Users\\u", "win32")).toBe("D:\\cx");
    expect(codexHomeDir({ CODEX_HOME: "/posix" }, "/home/u", "linux")).toBe("/posix");
  });
});

describe("hook texts on Windows", () => {
  const cache = {
    policy: {
      profile: "p",
      summary: "S",
      claudeHard: false,
      hardMode: true,
      hardInterception: true,
    },
  } as unknown as Parameters<typeof policyText>[0];

  it("Claude: the prefix is used as given (already quoted for bash)", () => {
    const text = policyText(cache, `'${NODE}' '${CLI}'`, "win32");
    expect(text).toContain(`\`'${NODE}' '${CLI}' run --detach --json --task '<task>'`);
  });

  it("Codex: the task goes in a file and the sandbox caveat is stated", () => {
    const l = `& '${NODE}' '${CLI}'`;
    const text = codexPolicyText(cache as never, l, "win32");
    expect(text).toContain(`\`${l} run --detach --json --task-file .dispatch/inbox/<name>.md`);
    expect(text).toContain("ask to run the same command outside the sandbox");
    expect(redirectReason(l, "win32")).toContain(`\`${l} run --detach --json --task-file`);
    expect(redirectReason("/h/bin/dispatch", "linux")).toContain(
      "`/h/bin/dispatch run --detach --json --task '<the sub-agent task, in your own words>'`",
    );
  });
});

describe("doctor on Windows", () => {
  function installed(): void {
    h = tempHome();
    mkdirSync(join(h.dispatchHome, "bin"), { recursive: true });
    writeFileSync(
      join(h.dispatchHome, "bin", "dispatch.cmd"),
      `@echo off\r\n"${NODE}" --disable-warning=ExperimentalWarning "${CLI}" %*\r\n`,
    );
  }

  it("launcherLine reads dispatch.cmd and reports the stale paths it names", () => {
    installed();
    const line = launcherLine(h.dispatchHome, "win32");
    expect(line.status).toBe("fail");
    expect(line.message).toContain("dispatch.cmd points at paths that no longer exist");
    expect(line.data).toMatchObject({ node: NODE, cli: CLI });
  });

  it("launcherLine warns when dispatch.cmd is missing", () => {
    h = tempHome();
    expect(launcherLine(h.dispatchHome, "win32")).toMatchObject({ status: "warn" });
  });

  it("the Claude permission rules name node and cli, not the batch launcher", async () => {
    installed();
    const quotedCli = `'${CLI.replace("'", "'\\''")}'`;
    expect(subagentLauncher(h.dispatchHome, "win32")).toBe(`'${NODE}' ${quotedCli}`);
    expect(subagentLauncher(h.dispatchHome, "linux")).toBe(join(h.dispatchHome, "bin", "dispatch"));
    mkdirSync(join(h.home, ".claude"));
    const check = claudeDoctorChecks({ fs: FS, platform: "win32" }).find(
      (c) => c.id === "claude-code.permission-rule",
    );
    const r = await check?.run({ home: h.home, dispatchHome: h.dispatchHome, env: {} });
    expect(r?.message).toContain(`Bash('${NODE}' ${quotedCli} run:*)`);
  });

  it("subagentLauncher falls back to the launcher path when dispatch.cmd is unreadable", () => {
    h = tempHome();
    expect(subagentLauncher(h.dispatchHome, "win32")).toBe(
      join(h.dispatchHome, "bin", "dispatch.cmd"),
    );
    mkdirSync(join(h.dispatchHome, "bin"), { recursive: true });
    writeFileSync(join(h.dispatchHome, "bin", "dispatch.cmd"), "garbage");
    expect(subagentLauncher(h.dispatchHome, "win32")).toBe(
      join(h.dispatchHome, "bin", "dispatch.cmd"),
    );
  });

  it("codex.rules-launcher explains that Windows has no rule", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    const check = codexDoctorChecks({ fs: FS, platform: "win32" }).find(
      (c) => c.id === "codex.rules-launcher",
    );
    const r = await check?.run({ home: h.home, dispatchHome: h.dispatchHome, env: {} });
    expect(r).toEqual({ status: "warn", message: CODEX_WINDOWS_NO_RULES });
  });

  it("--from-host inside a sandboxed Codex on Windows asks for per-call approval", () => {
    h = tempHome();
    const lines = fromHostLines(
      { CODEX_THREAD_ID: "t", CODEX_SANDBOX: "seatbelt" },
      h.dispatchHome,
      "win32",
    );
    const rule = lines.find((l) => l.id === "host.codex-rule");
    expect(rule?.status).toBe("fail");
    expect(rule?.message).toContain("no Codex rule is installed on Windows");
  });
});

describe("renameRetrying", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it("retries EPERM/EBUSY/EACCES on Windows, then succeeds", () => {
    const codes = ["EPERM", "EBUSY", "EACCES"];
    const slept: number[] = [];
    let calls = 0;
    renameRetrying("a", "b", {
      platform: "win32",
      rename: () => {
        const c = codes[calls++];
        if (c) throw busy(c);
      },
      sleep: (ms) => slept.push(ms),
    });
    expect(calls).toBe(4);
    expect(slept).toEqual([10, 30, 60]);
  });

  it("gives up after the last delay and rethrows; other errors are not retried", () => {
    let calls = 0;
    const rename = () => {
      calls++;
      throw busy("EBUSY");
    };
    expect(() => renameRetrying("a", "b", { platform: "win32", rename, sleep: () => {} })).toThrow(
      "EBUSY",
    );
    expect(calls).toBe(6);
    calls = 0;
    const enoent = () => {
      calls++;
      throw busy("ENOENT");
    };
    expect(() =>
      renameRetrying("a", "b", { platform: "win32", rename: enoent, sleep: () => {} }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("is a single plain rename on POSIX", () => {
    let calls = 0;
    const rename = () => {
      calls++;
      throw busy("EBUSY");
    };
    expect(() => renameRetrying("a", "b", { platform: "linux", rename })).toThrow("EBUSY");
    expect(calls).toBe(1);
  });
});
