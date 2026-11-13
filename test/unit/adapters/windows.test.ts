/**
 * Native Windows branches of the child adapters, exercised on any host by injecting
 * `platform: "win32"`. POSIX goldens live in the per-adapter tests and stay unchanged.
 */
import { describe, expect, it } from "vitest";
import { buildAgyInvocation } from "../../../src/adapters/agy/invocation.js";
import { agyProbeEnv } from "../../../src/adapters/agy/probe.js";
import {
  buildClaudeInvocation,
  childSettings,
  deniedPaths,
  expandConfigDir,
  rulePath,
} from "../../../src/adapters/claude/invocation.js";
import { claudeProbeEnv, probeClaude } from "../../../src/adapters/claude/probe.js";
import {
  browserOverrides,
  buildCodexInvocation,
  CODEX_WINDOWS_SANDBOX,
  tomlString,
  untrustedProjectsOverride,
  windowsSandboxOverride,
} from "../../../src/adapters/codex/invocation.js";
import { probeCodex } from "../../../src/adapters/codex/probe.js";
import {
  adapterPlatformBlocker,
  excludePlatformBlocked,
  probeEnv,
} from "../../../src/adapters/platform.js";
import type {
  AdapterDeps,
  BuildInvocationArgs,
  ProbeResult,
  ProviderInstance,
  SpawnRequest,
} from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import type { RoutingConfig } from "../../../src/core/routing.js";
import { probeResult, task } from "../../fixtures/contracts.js";
import { FakeClock } from "../../stubs/index.js";

const PROFILE = "C:\\Users\\Ada";
const APPDATA = `${PROFILE}\\AppData\\Roaming`;
const WIN_ENV = {
  Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
  SystemRoot: "C:\\Windows",
  USERPROFILE: PROFILE,
  APPDATA,
  LOCALAPPDATA: `${PROFILE}\\AppData\\Local`,
  TEMP: `${PROFILE}\\AppData\\Local\\Temp`,
  OPENAI_API_KEY: "sk-secret",
  GITHUB_TOKEN: "ghp_secret",
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DispatchError);
    return (e as DispatchError).code;
  }
  return undefined;
}

/** Records spawn requests and answers every probe command with `stdout` and exit 0. */
function recordingDeps(
  binary: string,
  stdout = "1.0.0",
): { deps: AdapterDeps; reqs: SpawnRequest[] } {
  const reqs: SpawnRequest[] = [];
  return {
    reqs,
    deps: {
      clock: new FakeClock(),
      resolveBinary: async () => binary,
      spawner: {
        spawn: async (req) => {
          reqs.push(req);
          req.onLine?.("stdout", stdout);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      },
    },
  };
}

describe("adapterPlatformBlocker", () => {
  it("blocks nothing on POSIX", () => {
    for (const id of ["claude", "codex", "antigravity"]) {
      expect(adapterPlatformBlocker(id, "darwin")).toBeNull();
      expect(adapterPlatformBlocker(id, "linux")).toBeNull();
    }
  });

  it("blocks claude (no OS sandbox) and antigravity (unverified) on win32, not codex", () => {
    expect(adapterPlatformBlocker("claude", "win32")).toMatch(/sandbox is not available.*WSL2/);
    expect(adapterPlatformBlocker("antigravity", "win32")).toMatch(
      /not verified on native Windows/,
    );
    expect(adapterPlatformBlocker("codex", "win32")).toBeNull();
  });
});

describe("excludePlatformBlocked", () => {
  const routing = {
    instances: [
      { id: "claude", adapter: "claude", enabled: true },
      { id: "codex", adapter: "codex", enabled: true },
      { id: "agy", adapter: "antigravity", enabled: false },
    ],
  } as unknown as RoutingConfig;

  it("is a no-op on POSIX", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const r = excludePlatformBlocked(routing, platform);
      expect(r.excluded).toEqual([]);
      expect(r.routing).toBe(routing);
    }
  });

  it("disables enabled blocked instances on win32, with the blocker as reason", () => {
    const r = excludePlatformBlocked(routing, "win32");
    expect(r.excluded).toEqual([
      { id: "claude", reason: adapterPlatformBlocker("claude", "win32") },
    ]);
    expect(r.routing.instances.map((i) => i.enabled)).toEqual([false, true, false]);
  });
});

describe("probeEnv", () => {
  it("POSIX: exact keys only, empty values kept, no Windows base vars", () => {
    expect(
      probeEnv({ PATH: "/bin", HOME: "", Path: "x", USERPROFILE: "y" }, ["PATH", "HOME"], "linux"),
    ).toEqual({
      PATH: "/bin",
      HOME: "",
    });
  });

  it("win32: case-insensitive lookup, canonical names, Windows base vars, never secrets", () => {
    const env = probeEnv(WIN_ENV, ["PATH", "HOME"], "win32");
    expect(env).toMatchObject({
      PATH: WIN_ENV.Path,
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: PROFILE,
      APPDATA,
      TEMP: WIN_ENV.TEMP,
    });
    expect(env.Path).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(Object.keys(env).join(",")).not.toMatch(/OPENAI|GITHUB|TOKEN|KEY/);
  });
});

describe("claude on win32", () => {
  const probe: ProbeResult = {
    binaryPath: "C:\\Users\\Ada\\.local\\bin\\claude.exe",
    realpath: null,
    version: "2.1.301",
    flags: ["--safe-mode"],
    features: [],
    loggedIn: null,
    outsideCliRange: false,
  };
  const args: BuildInvocationArgs = {
    task: { ...task, prompt: "x" },
    target: { instance: "claude", tier: "balanced", model: "claude-sonnet-5", effort: "medium" },
    autonomy: "worktree",
    worktree: "C:\\wt\\run-1",
    repoRoot: "C:\\repo",
    runDir: "C:\\Users\\Ada\\.dispatch\\runs\\run-1",
    instance: { id: "claude", adapter: "claude", pool: "subscription" },
    probe,
    baseEnv: { PATH: "C:\\Windows\\System32", USERPROFILE: PROFILE, APPDATA },
  };

  it("refuses to build: the OS sandbox the settings require does not exist", () => {
    expect(codeOf(() => buildClaudeInvocation(args, "win32"))).toBe("adapter.platform_unsupported");
    expect(codeOf(() => buildClaudeInvocation({ ...args, autonomy: "read-only" }, "win32"))).toBe(
      "adapter.platform_unsupported",
    );
  });

  it("rule paths follow Claude Code's POSIX normalization (C:\\x → /c/x)", () => {
    expect(rulePath("C:\\Users\\Ada\\.claude", "win32")).toBe("/c/Users/Ada/.claude");
    expect(rulePath("d:/data//x/", "win32")).toBe("/d/data/x");
    expect(rulePath("C:\\", "win32")).toBe("/c");
    expect(rulePath("C:\\Users\\Ada\\.claude/**", "win32")).toBe("/c/Users/Ada/.claude/**");
    expect(rulePath("/home/u/.claude", "linux")).toBe("/home/u/.claude");
    for (const bad of ["\\\\server\\share\\x", "\\Users\\Ada", "relative"]) {
      expect(codeOf(() => rulePath(bad, "win32"))).toBe("adapter.claude.rule_path");
    }
  });

  it("denies the profile's credential dirs plus %APPDATA% Anthropic and GitHub CLI", () => {
    const d = deniedPaths(PROFILE, `${PROFILE}\\.claude-alt`, "win32", APPDATA);
    expect(d.dirs).toEqual([
      `${PROFILE}\\.claude`,
      `${PROFILE}\\.codex`,
      `${PROFILE}\\.gemini`,
      `${PROFILE}\\.dispatch`,
      `${PROFILE}\\.ssh`,
      `${PROFILE}\\.aws`,
      `${PROFILE}\\.config\\gh`,
      `${APPDATA}\\Anthropic`,
      `${APPDATA}\\GitHub CLI`,
      `${PROFILE}\\.claude-alt`,
    ]);
    expect(d.files).toEqual([`${PROFILE}\\.claude.json`]);
    // A missing or relative APPDATA adds nothing; POSIX never adds APPDATA dirs.
    expect(deniedPaths(PROFILE, null, "win32").dirs).toHaveLength(7);
    expect(deniedPaths(PROFILE, null, "win32", "AppData").dirs).toHaveLength(7);
    expect(deniedPaths("/home/u", null, "linux", "/x").dirs).toHaveLength(7);
  });

  it("golden settings: //c/... permission rules, native paths in denyRead, fail-closed sandbox", () => {
    const s = childSettings(deniedPaths(PROFILE, null, "win32", APPDATA), undefined, "win32");
    const rules = (abs: string) => [`Read(//c/${abs})`, `Read(//c/${abs}/**)`];
    expect(s).toEqual({
      permissions: {
        deny: [
          ...rules("Users/Ada/.claude"),
          ...rules("Users/Ada/.codex"),
          ...rules("Users/Ada/.gemini"),
          ...rules("Users/Ada/.dispatch"),
          ...rules("Users/Ada/.ssh"),
          ...rules("Users/Ada/.aws"),
          ...rules("Users/Ada/.config/gh"),
          ...rules("Users/Ada/AppData/Roaming/Anthropic"),
          ...rules("Users/Ada/AppData/Roaming/GitHub CLI"),
          "Read(//c/Users/Ada/.claude.json)",
          "Read(./.env*)",
          "Read(./**/.env*)",
        ],
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          denyRead: [
            `${PROFILE}\\.claude`,
            `${PROFILE}\\.codex`,
            `${PROFILE}\\.gemini`,
            `${PROFILE}\\.dispatch`,
            `${PROFILE}\\.ssh`,
            `${PROFILE}\\.aws`,
            `${PROFILE}\\.config\\gh`,
            `${APPDATA}\\Anthropic`,
            `${APPDATA}\\GitHub CLI`,
            `${PROFILE}\\.claude.json`,
          ],
        },
      },
    });
  });

  it("configDir: ~\\ and ~/ expand against the profile; only drive-letter paths are absolute", () => {
    expect(expandConfigDir("~\\.claude-alt", PROFILE, "win32")).toBe(`${PROFILE}\\.claude-alt`);
    expect(expandConfigDir("~/.claude-alt", PROFILE, "win32")).toBe(`${PROFILE}\\.claude-alt`);
    expect(expandConfigDir("D:/cfg/claude", PROFILE, "win32")).toBe("D:\\cfg\\claude");
    for (const bad of ["cfg", "\\cfg", "/cfg"]) {
      expect(codeOf(() => expandConfigDir(bad, PROFILE, "win32"))).toBe(
        "adapter.claude.config_dir",
      );
    }
    // POSIX keeps `~\` literal (a relative name) and refuses it.
    expect(codeOf(() => expandConfigDir("~\\x", "/home/u", "linux"))).toBe(
      "adapter.claude.config_dir",
    );
  });

  it("probe env: binary dir + System32 on PATH, Windows base vars, no secrets", () => {
    const env = claudeProbeEnv(probe.binaryPath ?? "", "C:\\cfg", WIN_ENV, "win32");
    expect(env.PATH).toBe("C:\\Users\\Ada\\.local\\bin;C:\\Windows\\System32;C:\\Windows");
    expect(env).toMatchObject({ USERPROFILE: PROFILE, CLAUDE_CONFIG_DIR: "C:\\cfg" });
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(claudeProbeEnv("C:\\b\\claude.exe", undefined, {}, "win32").PATH).toBe(
      "C:\\b;C:\\Windows\\System32;C:\\Windows",
    );
    expect(claudeProbeEnv("/opt/c/claude", undefined, WIN_ENV, "linux")).toEqual({
      PATH: "/opt/c:/usr/bin:/bin",
    });
  });

  it("probeClaude passes the Windows env to the spawner", async () => {
    const { deps, reqs } = recordingDeps("C:\\b\\claude.exe", "2.1.301 (Claude Code)");
    const inst: ProviderInstance = { id: "claude", adapter: "claude", pool: "subscription" };
    const p = await probeClaude(inst, deps, ">=2.1.301 <2.2", WIN_ENV, "win32");
    expect(p.version).toBe("2.1.301");
    expect(reqs.map((r) => r.argv)).toEqual([["--version"], ["--help"]]);
    expect(reqs[0]?.env).toMatchObject({ USERPROFILE: PROFILE, SYSTEMROOT: "C:\\Windows" });
    expect(reqs[0]?.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("codex on win32", () => {
  const WT = "C:\\work\\repo\\.dispatch\\wt\\run1";
  const ROOT = "C:\\work\\repo";
  const RUN_DIR = `${PROFILE}\\.dispatch\\runs\\run1`;
  const args: BuildInvocationArgs = {
    task,
    target: { instance: "codex", tier: "fast", model: "gpt-6-luna", effort: "low" },
    autonomy: "worktree",
    worktree: WT,
    repoRoot: ROOT,
    runDir: RUN_DIR,
    instance: { id: "codex", adapter: "codex", pool: "subscription" },
    probe: { ...probeResult, binaryPath: "C:\\Program Files\\nodejs\\codex.cmd" },
    baseEnv: { PATH: "C:\\Windows\\System32", USERPROFILE: PROFILE, DISPATCH_DEPTH: "1" },
  };

  it("tomlString escapes Windows backslashes so the -c value decodes to the same path", () => {
    expect(tomlString(WT)).toBe('"C:\\\\work\\\\repo\\\\.dispatch\\\\wt\\\\run1"');
    expect(JSON.parse(tomlString(WT))).toBe(WT);
    expect(untrustedProjectsOverride([WT, ROOT])).toBe(
      'projects={"C:\\\\work\\\\repo\\\\.dispatch\\\\wt\\\\run1"={trust_level="untrusted"},' +
        '"C:\\\\work\\\\repo"={trust_level="untrusted"}}',
    );
  });

  it.each([
    ["worktree", "workspace-write"],
    ["read-only", "read-only"],
  ] as const)(
    "golden argv for %s: always selects the elevated Windows sandbox",
    (autonomy, sandbox) => {
      const inv = buildCodexInvocation({ ...args, autonomy }, "win32");
      expect(inv.argv).toEqual([
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--disable",
        "hooks",
        "--disable",
        "plugins",
        "--disable",
        "apps",
        "--disable",
        "memories",
        "-c",
        "agents.enabled=false",
        "-c",
        'windows.sandbox="elevated"',
        "-c",
        untrustedProjectsOverride([WT, ROOT]),
        "-C",
        WT,
        "-m",
        "gpt-6-luna",
        "-c",
        "model_reasoning_effort=low",
        "-o",
        `${RUN_DIR}\\last.txt`,
        "-s",
        sandbox,
        "-",
      ]);
      expect(inv.outputFile).toBe(`${RUN_DIR}\\last.txt`);
      expect(inv.binary).toBe("C:\\Program Files\\nodejs\\codex.cmd");
      expect(inv.sideEffectGuards).toEqual([
        "codex-project-trust-untrusted",
        "codex-agents-disabled",
        "codex-user-config-ignored",
        "codex-windows-sandbox-elevated",
      ]);
    },
  );

  it("the Windows sandbox override exists only on win32", () => {
    expect(windowsSandboxOverride("win32")).toEqual(["-c", CODEX_WINDOWS_SANDBOX]);
    expect(windowsSandboxOverride("darwin")).toEqual([]);
    expect(windowsSandboxOverride("linux")).toEqual([]);
    const posix = buildCodexInvocation(
      { ...args, worktree: "/wt", repoRoot: "/r", runDir: "/run" },
      "linux",
    );
    expect(posix.argv.join(" ")).not.toContain("windows.sandbox");
  });

  it("browser server: USERPROFILE joins HOME on win32 (both the attempt's browser home)", () => {
    const browser = {
      nodePath: "C:\\node\\node.exe",
      cliPath: "C:\\pw\\cli.js",
      origins: ["http://localhost:3000"],
    };
    const win = browserOverrides(browser, "worktree", RUN_DIR, "win32");
    const home = tomlString(`${RUN_DIR}\\browser-home`);
    expect(win).toContain(`mcp_servers.dispatch_browser.env={HOME=${home},USERPROFILE=${home}}`);
    expect(win).toContain(`mcp_servers.dispatch_browser.cwd=${tomlString(`${RUN_DIR}\\browser`)}`);
    const posix = browserOverrides(browser, "worktree", "/run", "linux");
    expect(posix).toContain('mcp_servers.dispatch_browser.env={HOME="/run/browser-home"}');
  });

  it("probeCodex: case-insensitive env with Windows base vars, never secrets", async () => {
    const { deps, reqs } = recordingDeps("C:\\b\\codex.cmd", "codex-cli 0.167.0");
    const inst: ProviderInstance = {
      id: "codex",
      adapter: "codex",
      pool: "subscription",
      configDir: "C:\\cx",
    };
    const p = await probeCodex(inst, deps, WIN_ENV, "win32");
    expect(p.version).toBe("0.167.0");
    const env = reqs[0]?.env ?? {};
    expect(env).toMatchObject({ PATH: WIN_ENV.Path, USERPROFILE: PROFILE, CODEX_HOME: "C:\\cx" });
    expect(Object.keys(env)).not.toContain("Path");
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });
});

describe("antigravity on win32", () => {
  const probe: ProbeResult = {
    binaryPath: "C:\\Users\\Ada\\AppData\\Local\\agy\\bin\\agy.exe",
    realpath: null,
    version: "1.5.2",
    flags: [],
    features: [],
    loggedIn: true,
    outsideCliRange: false,
  };

  it("refuses to build (experimental adapter, unverified on Windows)", () => {
    const args: BuildInvocationArgs = {
      task: { ...task, autonomy: "read-only" },
      target: { instance: "agy", tier: "fast", model: "gemini-3.8-flash-low", effort: "low" },
      autonomy: "read-only",
      worktree: "C:\\wt",
      repoRoot: "C:\\repo",
      runDir: "C:\\run",
      instance: { id: "agy", adapter: "antigravity", pool: "subscription" },
      probe,
      baseEnv: { USERPROFILE: PROFILE },
    };
    expect(codeOf(() => buildAgyInvocation(args, "win32"))).toBe("adapter.platform_unsupported");
    expect(buildAgyInvocation({ ...args, worktree: "/wt" }, "linux").argv[1]).toBe(
      "--output-format",
    );
  });

  it("probe env adds the Windows base vars case-insensitively, keeps TERM=dumb, drops secrets", () => {
    const env = agyProbeEnv({ ...WIN_ENV, ANTIGRAVITY_TOKEN: "t", LC_ALL: "C" }, "win32");
    expect(env).toMatchObject({
      TERM: "dumb",
      PATH: WIN_ENV.Path,
      USERPROFILE: PROFILE,
      LC_ALL: "C",
    });
    expect(Object.keys(env).join(",")).not.toMatch(/ANTIGRAVITY|OPENAI|GITHUB/);
    expect(agyProbeEnv({ Path: "x", PATH: "/bin", USERPROFILE: "u" }, "linux")).toEqual({
      TERM: "dumb",
      PATH: "/bin",
    });
  });
});
