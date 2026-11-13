import { describe, expect, it } from "vitest";
import {
  buildClaudeInvocation,
  CLAUDE_CAPABILITIES,
  CLAUDE_MAX_TURNS,
  createClaudeAdapter,
} from "../../../src/adapters/claude/index.js";
import {
  AdapterCapabilitiesSchema,
  type BuildInvocationArgs,
  InvocationSchema,
  type ProbeResult,
} from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import { task } from "../../fixtures/contracts.js";

/** Builds on POSIX on any host: native Windows refuses claude (adapterPlatformBlocker). */
const build = (a: Parameters<typeof buildClaudeInvocation>[0]) => buildClaudeInvocation(a, "linux");

const HOME = "/home/u";
const probe: ProbeResult = {
  binaryPath: "/opt/claude/bin/claude",
  realpath: "/opt/claude/versions/2.1.301/claude",
  version: "2.1.301",
  flags: ["--effort", "--safe-mode", "--settings", "--tools"],
  features: [],
  loggedIn: null,
  outsideCliRange: false,
};

function args(over: Partial<BuildInvocationArgs> = {}): BuildInvocationArgs {
  return {
    task: { ...task, prompt: "Fix the flaky test" },
    target: { instance: "claude", tier: "balanced", model: "claude-sonnet-5", effort: "medium" },
    autonomy: "worktree",
    worktree: "/wt/run-1",
    repoRoot: "/repo",
    runDir: "/home/u/.dispatch/runs/run-1",
    instance: { id: "claude", adapter: "claude", pool: "subscription" },
    probe,
    baseEnv: { PATH: "/usr/bin:/bin", HOME, LANG: "C.UTF-8", DISPATCH_DEPTH: "1" },
    ...over,
  };
}

const homeDirs = [".claude", ".codex", ".gemini", ".dispatch", ".ssh", ".aws", ".config/gh"].map(
  (d) => `${HOME}/${d}`,
);

function expectedSettings(extraDirs: string[] = []) {
  const dirs = [...homeDirs, ...extraDirs];
  return {
    permissions: {
      deny: [
        ...dirs.flatMap((d) => [`Read(/${d})`, `Read(/${d}/**)`]),
        `Read(/${HOME}/.claude.json)`,
        "Read(./.env*)",
        "Read(./**/.env*)",
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...dirs, `${HOME}/.claude.json`] },
    },
  };
}

const COMMON = [
  "-p",
  "--safe-mode",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--model",
  "claude-sonnet-5",
  "--effort",
  "medium",
  "--max-turns",
  String(CLAUDE_MAX_TURNS),
];

function settingsOf(argv: readonly string[]): unknown {
  const i = argv.indexOf("--settings");
  expect(i).toBe(argv.length - 2);
  return JSON.parse(argv[i + 1] ?? "");
}

describe("claude adapter: golden argv [SEC-claude-cred]", () => {
  it("[SEC-claude-cred] worktree: acceptEdits, edit tools, no Agent, credential deny + fail-closed sandbox", () => {
    const inv = build(args());
    expect(InvocationSchema.parse(inv)).toEqual(inv);
    expect(inv.argv.slice(0, -2)).toEqual([
      ...COMMON,
      "--permission-mode",
      "acceptEdits",
      "--tools",
      "Read,Grep,Glob,Edit,Write,Bash",
      "--disallowedTools",
      "Agent",
    ]);
    expect(settingsOf(inv.argv)).toEqual(expectedSettings());
    expect(inv.binary).toBe("/opt/claude/bin/claude");
    expect(inv.cwd).toBe("/wt/run-1");
    expect(inv.redactArgvIndexes).toEqual([]);
    expect(inv.sideEffectGuards).toEqual([
      "claude-safe-mode",
      "claude-no-session-persistence",
      "claude-credential-deny",
      "claude-sandbox-fail-closed",
      "claude-no-agent-tool",
    ]);
    // Every guard is backed by the argv/settings it names.
    expect(inv.argv).toContain("--safe-mode");
    expect(inv.argv).toContain("--no-session-persistence");
    expect(inv.argv.join(" ")).not.toMatch(/dangerously|bypassPermissions|--plugin-dir|--mcp/);
  });

  it("[SEC-claude-cred] read-only: dontAsk with Read,Grep,Glob only", () => {
    const inv = build(args({ autonomy: "read-only" }));
    expect(inv.argv.slice(0, -2)).toEqual([
      ...COMMON,
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob",
    ]);
    expect(settingsOf(inv.argv)).toEqual(expectedSettings());
    expect(inv.sideEffectGuards).toEqual([
      "claude-safe-mode",
      "claude-no-session-persistence",
      "claude-credential-deny",
      "claude-sandbox-fail-closed",
    ]);
  });

  it("[SEC-claude-cred] prompt goes on stdin under the task-data header, never in argv", () => {
    const inv = build(args());
    expect(inv.stdin).toMatch(/^You are running as a delegated agent under Dispatch/);
    expect(inv.stdin).toContain("Do not run `dispatch`");
    expect(inv.stdin).toContain("current directory");
    expect(inv.stdin).toContain("summary");
    expect(inv.stdin?.endsWith("--- TASK ---\nFix the flaky test")).toBe(true);
    expect(inv.argv.some((a) => a.includes("Fix the flaky test"))).toBe(false);
  });

  it("[UC12] instance configDir becomes CLAUDE_CONFIG_DIR and is denied too", () => {
    const inv = build(
      args({
        instance: {
          id: "claude-alt",
          adapter: "claude",
          pool: "subscription",
          configDir: "~/.claude-alt",
        },
      }),
    );
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe(`${HOME}/.claude-alt`);
    expect(settingsOf(inv.argv)).toEqual(expectedSettings([`${HOME}/.claude-alt`]));
    expect(inv.env).toMatchObject({ PATH: "/usr/bin:/bin", HOME, DISPATCH_DEPTH: "1" });
  });

  it("[UC12] an instance without configDir never inherits another instance's CLAUDE_CONFIG_DIR", () => {
    const inv = build(
      args({ baseEnv: { PATH: "/usr/bin", HOME, CLAUDE_CONFIG_DIR: "/home/u/.claude-alt" } }),
    );
    expect(inv.env).toEqual({ PATH: "/usr/bin", HOME });
  });

  it("does not duplicate a configDir that is already a denied HOME dir", () => {
    const inv = build(
      args({
        instance: {
          id: "c",
          adapter: "claude",
          pool: "subscription",
          configDir: "/home/u/.claude",
        },
      }),
    );
    expect(settingsOf(inv.argv)).toEqual(expectedSettings());
  });

  it.each([
    ["direct autonomy", { autonomy: "direct" as const }, "adapter.autonomy_unsupported"],
    ["missing binary", { probe: { ...probe, binaryPath: null } }, "adapter.no_binary"],
    [
      "CLI without --safe-mode",
      { probe: { ...probe, flags: ["--settings"] } },
      "adapter.claude.unsupported_cli",
    ],
    [
      "unknown version without --safe-mode",
      { probe: { ...probe, version: null, flags: [] } },
      "adapter.claude.unsupported_cli",
    ],
    ["no HOME", { baseEnv: { PATH: "/usr/bin" } }, "adapter.claude.no_home"],
    ["relative HOME", { baseEnv: { HOME: "home" } }, "adapter.claude.no_home"],
    [
      "relative configDir",
      { instance: { id: "c", adapter: "claude", pool: "subscription" as const, configDir: "cfg" } },
      "adapter.claude.config_dir",
    ],
  ])("refuses to build: %s", (_name, over, code) => {
    let err: unknown;
    try {
      build(args(over));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe(code);
  });
});

describe("claude adapter: capabilities", () => {
  it("declares the spike-verified isolation, passive quota and stdin prompt", () => {
    expect(AdapterCapabilitiesSchema.parse(CLAUDE_CAPABILITIES)).toEqual(CLAUDE_CAPABILITIES);
    expect(CLAUDE_CAPABILITIES).toMatchObject({
      id: "claude",
      cliRange: ">=2.1.301 <2.2",
      quotaChannel: "passive+reader",
      promptChannel: "stdin",
      sandbox: "os",
      autonomy: ["read-only", "worktree"],
      experimental: false,
      isolation: {
        userHooks: "disabled",
        userPlugins: "builtin_only",
        userMcp: "disabled",
        projectConfig: "disabled",
      },
    });
  });

  it("takes the pool from the instance", () => {
    expect(createClaudeAdapter().caps.pool).toBe("subscription");
    expect(createClaudeAdapter({ pool: "api_credit" }).caps.pool).toBe("api_credit");
  });
});
