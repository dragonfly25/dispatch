/**
 * `dispatch setup` writes the global config (spec §10, UC1): non-interactive from flags or an
 * answers file, the interactive wizard with injected prompts, `--reconfigure`, the Antigravity
 * opt-in, and `install` triggering it. Fake CLIs only; nothing outside a temp HOME is touched.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type { RepoCommandDeps } from "../../src/cli/repo-commands.js";
import type { SetupCommandDeps } from "../../src/cli/setup.js";
import { loadEffectiveConfig, validate } from "../../src/config/index.js";
import { writeGlobalConfig } from "../../src/setup/global-config.js";
import { fakeCodexHost } from "../support/fake-host.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";

let h: TempHome;
let fakes: FakesContext | undefined;
let repo: TempRepo | undefined;
afterEach(() => {
  h?.cleanup();
  fakes?.dispose();
  repo?.cleanup();
  fakes = undefined;
  repo = undefined;
});

/** The only invocations the wizard may make: version, help and login probes. */
const QUOTA_FREE = new Set(["--version", "--help", "exec --help", "features list", "login status"]);

/** Answers handed out one per question; asking more than scripted fails the test. */
function script(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question: string): Promise<string> => {
      asked.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected question: ${question}`);
      return next;
    },
  };
}

function harness(
  deps: Partial<SetupCommandDeps> = {},
  scenarios: FakeScenarioMap = {},
  repoDeps: Partial<RepoCommandDeps> = {},
  reuse = false,
) {
  if (!reuse || !fakes) {
    h = tempHome();
    fakes = createFakes(scenarios);
  }
  const env = { ...fakes.env, ...h.env };
  const io = { stdout: "", stderr: "" };
  const sink = {
    out(t: string) {
      io.stdout += t;
    },
    err(t: string) {
      io.stderr += t;
    },
  };
  const full: Partial<SetupCommandDeps> = {
    env,
    install: () => ({ nodePath: "/n/node", cliPath: "/d/cli.mjs", hookPath: "/d/hook.mjs" }),
    hosts: () => [],
    runner: () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    interactive: false,
    ...deps,
  };
  const run = (...args: string[]) =>
    runCli(args, sink, buildProgram(sink, full, repoDeps), { platform: "darwin", env: {} });
  const configPath = join(h.dispatchHome, "config.yaml");
  const config = () => readFileSync(configPath, "utf8");
  const effective = () => loadEffectiveConfig({ cwd: h.home, env });
  const instance = (id: string) => effective().execution.instances.find((i) => i.id === id);
  const fakeCalls = (cli?: "claude" | "codex" | "agy") => fakes?.readLog(cli ? { cli } : {}) ?? [];
  return { io, run, env, configPath, config, effective, instance, fakeCalls };
}

describe("setup --non-interactive writes the global config [UC1]", () => {
  it("takes plans, profile, autonomy and host from flags; the result loads and validates clean", async () => {
    const k = harness();
    const code = await k.run(
      ...["setup", "--non-interactive", "--yes"],
      ...["--plan", "claude=max5x", "--plan", "codex=plus", "--plan", "agy=pro"],
      ...["--profile", "preserve", "--autonomy", "read-only", "--host", "claude-code"],
    );
    expect(k.io.stderr).toBe("");
    expect(code).toBe(0);
    expect(k.io.stdout).toContain("Global config: create");
    expect(k.io.stdout).toContain(`Wrote ${k.configPath}`);

    const eff = k.effective();
    expect(eff.routing.activeProfile).toBe("preserve");
    expect(eff.execution.autonomy).toBe("read-only");
    expect(k.instance("claude")?.plan).toBe("max5x");
    expect(k.instance("codex")?.plan).toBe("plus");
    expect(k.instance("antigravity")).toMatchObject({ plan: "pro", enabled: false });
    expect(validate(eff).filter((i) => i.level === "error")).toEqual([]);
    expect(eff.issues).toEqual([]);

    expect(k.config()).toMatch(/^main_host: claude-code$/m);
    expect(statSync(k.configPath).mode & 0o777).toBe(0o600);
    // Non-interactive never starts a CLI.
    expect(k.fakeCalls()).toEqual([]);
  });

  it("without any answer it uses the defaults and prints a summary", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes")).toBe(0);
    expect(k.io.stdout).toContain("strategy (profile): balance");
    expect(k.io.stdout).toContain("autonomy of delegated agents: worktree");
    expect(k.io.stdout).toContain("plans: none declared (unknown)");
    expect(k.io.stdout).toContain("antigravity: disabled");
    const eff = k.effective();
    expect(eff.routing.activeProfile).toBe("balance");
    expect(eff.execution.autonomy).toBe("worktree");
    expect(k.instance("antigravity")?.enabled).toBe(false);
    expect(k.config()).not.toMatch(/^main_host:/m);
    expect(k.config()).not.toMatch(/^providers:/m);
  });

  it("is a dry run without --yes: it prints the plan and changes nothing (exit 2)", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--plan", "claude=pro")).toBe(2);
    expect(k.io.stdout).toContain("Global config: create");
    expect(k.io.stdout).toContain("claude=pro");
    expect(k.io.stderr).toMatch(/re-run with --yes/);
    expect(existsSync(h.dispatchHome)).toBe(false);
  });

  it("reads an answers file; flags win over it", async () => {
    const k = harness();
    mkdirSync(h.home, { recursive: true });
    const file = join(h.home, "answers.yaml");
    writeFileSync(
      file,
      [
        "main_host: codex",
        "profile: specialize",
        "autonomy: worktree",
        "plans: { claude: max20x, codex: business }",
        "antigravity: { enable: false }",
      ].join("\n"),
    );
    expect(
      await k.run("setup", "--non-interactive", "--yes", "--answers", file, "--profile", "balance"),
    ).toBe(0);
    expect(k.instance("claude")?.plan).toBe("max20x");
    expect(k.instance("codex")?.plan).toBe("business");
    expect(k.effective().routing.activeProfile).toBe("balance");
    expect(k.config()).toMatch(/^main_host: codex$/m);
  });

  it("rejects bad answers with a usage error that lists the choices", async () => {
    const k = harness();
    const bad: [string[], RegExp][] = [
      [
        ["--plan", "claude=gold"],
        /unknown plan "gold" for claude \(choose: pro, max5x, max20x, unknown\)/,
      ],
      [["--plan", "gemini=pro"], /unknown provider "gemini"/],
      [["--plan", "claude"], /--plan expects <provider>=<plan>/],
      [["--host", "vim"], /unknown host "vim" \(choose: claude-code, codex, none\)/],
      [["--profile", "yolo"], /unknown profile "yolo"/],
      [["--autonomy", "root"], /unknown autonomy "root"/],
      [["--answers", join(h.home, "missing.yaml")], /cannot read the answers file/],
    ];
    for (const [flags, message] of bad) {
      k.io.stderr = "";
      expect(await k.run("setup", "--non-interactive", "--yes", ...flags)).toBe(2);
      expect(k.io.stderr).toMatch(message);
    }
    expect(existsSync(k.configPath)).toBe(false);
    const file = join(h.home, "answers.yaml");
    writeFileSync(file, "colour: blue\n");
    k.io.stderr = "";
    expect(await k.run("setup", "--non-interactive", "--yes", "--answers", file)).toBe(2);
    expect(k.io.stderr).toMatch(/answers\.yaml: .*colour/);
  });
});

describe("an existing config is never overwritten", () => {
  const original = "# mine\nversion: 1\nprofile: preserve\n";

  it("setup keeps it byte for byte, and says how to change it", async () => {
    const k = harness();
    mkdirSync(h.dispatchHome, { recursive: true });
    writeFileSync(k.configPath, original);
    expect(await k.run("setup", "--non-interactive", "--yes")).toBe(0);
    expect(k.io.stdout).toContain("Keeping");
    expect(k.config()).toBe(original);
  });

  it("answer flags are ignored with a warning pointing at --reconfigure", async () => {
    const k = harness();
    mkdirSync(h.dispatchHome, { recursive: true });
    writeFileSync(k.configPath, original);
    expect(await k.run("setup", "--non-interactive", "--yes", "--profile", "balance")).toBe(0);
    expect(k.io.stderr).toMatch(/answer flags were ignored; add --reconfigure/);
    expect(k.config()).toBe(original);
  });
});

describe("setup --reconfigure", () => {
  const existing = [
    "# my notes: keep me",
    "version: 1",
    "",
    "# which strategy",
    "profile: balance   # inline note",
    "x_custom: 1        # a key Dispatch does not know",
    "providers:",
    "  claude:",
    "    plan: pro      # old plan",
    "  codex:",
    "    plan: plus",
    "trusted_repos: {}",
    "",
  ].join("\n");

  it("changes only what was answered and keeps comments and unknown keys", async () => {
    const k = harness();
    mkdirSync(h.dispatchHome, { recursive: true });
    writeFileSync(k.configPath, existing);
    const code = await k.run(
      ...["setup", "--non-interactive", "--yes", "--reconfigure"],
      ...["--profile", "specialize", "--plan", "claude=max20x", "--plan", "codex=unknown"],
      ...["--host", "codex", "--autonomy", "read-only"],
    );
    expect(code).toBe(0);
    expect(k.io.stdout).toContain("Global config: update");
    const text = k.config();
    expect(text).toContain("# my notes: keep me");
    expect(text).toContain("# which strategy");
    expect(text).toContain("# inline note");
    expect(text).toContain("# old plan");
    expect(text).toContain("x_custom: 1");
    expect(text).toMatch(/^profile: specialize/m);
    expect(text).toMatch(/plan: max20x/);
    expect(text).not.toMatch(/plan: plus/);
    expect(text).toMatch(/^main_host: codex$/m);
    expect(text).toMatch(/^autonomy: read-only$/m);
    expect(statSync(k.configPath).mode & 0o777).toBe(0o600);
  });

  it("round-trips a generated config without losing its documentation", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes", "--plan", "claude=pro")).toBe(0);
    const before = k.config();
    expect(
      await k.run("setup", "--non-interactive", "--yes", "--reconfigure", "--plan", "codex=plus"),
    ).toBe(0);
    const after = k.config();
    // Every explanation survives; the new plan is an active key.
    for (const line of before.split("\n").filter((l) => l.startsWith("# "))) {
      expect(after).toContain(line);
    }
    expect(k.instance("codex")?.plan).toBe("plus");
    expect(k.instance("claude")?.plan).toBe("pro");
    expect(k.effective().issues).toEqual([]);
  });

  it("creates the config when there is none, and fills an empty providers key", async () => {
    const k = harness();
    expect(
      await k.run("setup", "--non-interactive", "--yes", "--reconfigure", "--host", "none"),
    ).toBe(0);
    expect(k.config()).not.toMatch(/^main_host:/m);
    writeFileSync(k.configPath, "version: 1\nmain_host: codex\nproviders:\n");
    expect(
      await k.run(
        "setup",
        "--non-interactive",
        "--yes",
        "--reconfigure",
        "--host",
        "none",
        "--plan",
        "codex=pro",
      ),
    ).toBe(0);
    expect(k.config()).not.toMatch(/^main_host:/m);
    expect(k.instance("codex")?.plan).toBe("pro");
  });

  it("refuses a config that is not YAML or not a mapping", async () => {
    const k = harness();
    mkdirSync(h.dispatchHome, { recursive: true });
    for (const bad of ["a: [unclosed\n", "- just\n- a list\n"]) {
      writeFileSync(k.configPath, bad);
      k.io.stderr = "";
      expect(
        await k.run("setup", "--non-interactive", "--yes", "--reconfigure", "--profile", "balance"),
      ).toBe(2);
      expect(k.io.stderr).toContain("config.yaml");
      expect(k.config()).toBe(bad);
    }
  });
});

describe("the interactive wizard", () => {
  const scenarios: FakeScenarioMap = { "codex:login": { loggedIn: false } };

  it("detects the CLIs, asks four questions and writes what was answered", async () => {
    const s = script(["1", "max5x", "plus", "n", "preserve", "read-only", "2", "2", "y"]);
    const k = harness({ interactive: true, ask: s.ask }, scenarios);
    expect(await k.run("setup")).toBe(0);
    expect(k.io.stdout).toMatch(/Detected: claude .*login unknown.*; codex .*NOT logged in/);
    expect(k.io.stdout).toContain("codex is installed but not logged in");
    expect(s.asked).toHaveLength(9);
    expect(s.asked.at(-1)).toBe("Apply these changes? [y/N] ");
    expect(k.config()).toMatch(/^main_host: claude-code$/m);
    const eff = k.effective();
    expect(eff.routing.activeProfile).toBe("preserve");
    expect(eff.execution.autonomy).toBe("read-only");
    expect(k.instance("claude")?.plan).toBe("max5x");
    expect(eff.execution.forwardMcp).toBe(false);
    expect(k.instance("codex")?.plan).toBe("plus");
    expect(k.instance("antigravity")?.enabled).toBe(false);
    // Only the quota-free probes ran, and agy was never started.
    expect(k.fakeCalls().every((c) => QUOTA_FREE.has(c.args.join(" ")))).toBe(true);
    expect(k.fakeCalls("agy")).toEqual([]);
  });

  it("Enter takes the defaults (host guessed from what is installed)", async () => {
    const s = script(["", "", "", "n", "", "", "", "", "yes"]);
    const k = harness({ interactive: true, ask: s.ask });
    expect(await k.run("setup")).toBe(0);
    expect(k.config()).toMatch(/^main_host: claude-code$/m);
    expect(k.config()).toMatch(/^profile: balance$/m);
    expect(k.config()).toMatch(/^autonomy: worktree$/m);
    expect(k.config()).not.toMatch(/^providers:/m);
    // The MCP forwarding trust grant defaults to yes in the wizard (owner decision).
    expect(k.io.stdout).toContain("Trust grant · Forward the MCP servers");
    expect(k.config()).toMatch(/^ {4}forward_mcp: true$/m);
    expect(k.effective().execution.forwardMcp).toBe(true);
  });

  it("declining the final confirmation writes nothing", async () => {
    const s = script(["", "", "", "n", "", "", "", "", "n"]);
    const k = harness({ interactive: true, ask: s.ask });
    expect(await k.run("setup")).toBe(0);
    expect(k.io.stdout).toContain("Nothing was changed.");
    expect(existsSync(h.dispatchHome)).toBe(false);
  });

  it("re-asks on an invalid answer, and gives up after three", async () => {
    const ok = script(["9", "claude-code", "", "", "n", "", "", "", "", "y"]);
    const k = harness({ interactive: true, ask: ok.ask });
    expect(await k.run("setup")).toBe(0);
    expect(k.io.stdout).toContain("Please answer with a number from 1 to 3 or a name.");

    const bad = script(["x", "y", "z"]);
    const k2 = harness({ interactive: true, ask: bad.ask });
    expect(await k2.run("setup")).toBe(2);
    expect(k2.io.stderr).toMatch(/no valid answer to "Which client/);
    expect(existsSync(k2.configPath)).toBe(false);
  });

  it("answers given as flags are not asked again", async () => {
    const s = script(["max20x", "n", "y"]);
    const k = harness({
      interactive: true,
      ask: s.ask,
      detect: async (ids) =>
        ids.map((id) => ({ id, installed: id === "claude", version: "1.0.0", loggedIn: null })),
    });
    expect(
      await k.run(
        "setup",
        "--host",
        "codex",
        "--profile",
        "specialize",
        "--autonomy",
        "worktree",
        "--plan",
        "codex=plus",
        "--no-forward-mcp",
        "--no-browser",
      ),
    ).toBe(0);
    expect(s.asked).toEqual([
      "Choice [4]: ",
      "Do you want to enable Antigravity anyway? [y/N] ",
      "Apply these changes? [y/N] ",
    ]);
    expect(k.config()).toMatch(/^main_host: codex$/m);
    expect(k.instance("claude")?.plan).toBe("max20x");
    expect(k.instance("codex")?.plan).toBe("plus");
    expect(k.config()).toMatch(/^ {4}forward_mcp: false$/m);
  });

  it("direct autonomy needs a typed confirmation; anything else falls back to worktree", async () => {
    const no = script(["", "", "", "n", "", "direct", "sure", "", "", "y"]);
    const a = harness({ interactive: true, ask: no.ask });
    expect(await a.run("setup")).toBe(0);
    expect(a.io.stdout).toContain("Not confirmed: using worktree.");
    expect(a.config()).toMatch(/^autonomy: worktree$/m);

    const yes = script(["", "", "", "n", "", "3", "direct", "", "", "y"]);
    const b = harness({ interactive: true, ask: yes.ask });
    expect(await b.run("setup")).toBe(0);
    expect(b.config()).toMatch(/^autonomy: direct$/m);
  });

  it("--reconfigure offers the current values as defaults", async () => {
    const first = harness({}, scenarios);
    expect(
      await first.run(
        ...["setup", "--non-interactive", "--yes", "--plan", "claude=max20x"],
        ...["--profile", "specialize", "--host", "codex", "--autonomy", "read-only"],
      ),
    ).toBe(0);
    const s = script(["", "", "", "n", "", "", "", "", "y"]);
    const k = harness({ interactive: true, ask: s.ask }, scenarios, {}, true);
    expect(await k.run("setup", "--reconfigure")).toBe(0);
    expect(k.io.stdout).toContain("Global config: update");
    expect(k.config()).toMatch(/^main_host: codex$/m);
    expect(k.config()).toMatch(/^profile: specialize$/m);
    expect(k.config()).toMatch(/^autonomy: read-only$/m);
    expect(k.instance("claude")?.plan).toBe("max20x");
    // Non-interactive setup never assumes the MCP grant; reconfigure offers the current "no".
    expect(k.config()).toMatch(/^ {4}forward_mcp: false$/m);
  });

  it("[SEC-mcp] the MCP grant comes from flags or answers; --refresh and --reconfigure keep it", async () => {
    const k = harness({}, scenarios);
    expect(await k.run("setup", "--non-interactive", "--yes", "--forward-mcp")).toBe(0);
    expect(k.io.stdout).toContain("Trust grants");
    expect(k.io.stdout).toContain("Forward the MCP servers an agent needs");
    expect(k.effective().execution.forwardMcp).toBe(true);
    const before = k.config();
    expect(await k.run("setup", "--refresh", "--yes", "--non-interactive")).toBe(0);
    expect(k.config()).toBe(before);
    const s = script(["", "", "", "n", "", "", "", "", "y"]);
    const again = harness({ interactive: true, ask: s.ask }, scenarios, {}, true);
    expect(await again.run("setup", "--reconfigure")).toBe(0);
    expect(again.effective().execution.forwardMcp).toBe(true);
  });
});

describe("Antigravity is opt-in and never touched otherwise", () => {
  it("needs both --enable-antigravity and --accept-agy-terms; records tos_acknowledged", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes", "--enable-antigravity")).toBe(2);
    expect(k.io.stderr).toMatch(/--enable-antigravity together with --accept-agy-terms/);
    expect(existsSync(k.configPath)).toBe(false);

    expect(
      await k.run(
        "setup",
        "--non-interactive",
        "--yes",
        "--enable-antigravity",
        "--accept-agy-terms",
        "--plan",
        "agy=ultra",
      ),
    ).toBe(0);
    const text = k.config();
    expect(text).toMatch(
      /antigravity:\n {4}enabled: true\n {4}tos_acknowledged: true\n {4}plan: ultra/,
    );
    expect(k.instance("antigravity")).toMatchObject({
      enabled: true,
      plan: "ultra",
      maxAutonomy: "read-only",
    });
    expect(k.effective().issues).toEqual([]);
    expect(k.fakeCalls("agy")).toEqual([]);
  });

  it("--accept-agy-terms alone enables nothing", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes", "--accept-agy-terms")).toBe(0);
    expect(k.instance("antigravity")?.enabled).toBe(false);
    expect(k.config()).not.toMatch(/tos_acknowledged: true/);
  });

  it("interactively: the warning, a typed yes, then agy is probed and its plan asked", async () => {
    const s = script(["", "", "", "y", "yes", "pro", "", "", "", "", "y"]);
    const k = harness({ interactive: true, ask: s.ask });
    expect(await k.run("setup")).toBe(0);
    expect(k.io.stdout).toContain("not supported under consumer plans");
    expect(s.asked).toContain('Type "yes" to confirm you accept the risk and Google\'s terms: ');
    expect(k.config()).toMatch(/tos_acknowledged: true/);
    expect(k.instance("antigravity")).toMatchObject({ enabled: true, plan: "pro" });
    expect(k.fakeCalls("agy").length).toBeGreaterThan(0);
    expect(
      k.fakeCalls("agy").every((c) => c.kind === "subcommand" || c.args.includes("--help")),
    ).toBe(true);
  });

  it("interactively: saying no, or not typing yes, keeps agy off and unprobed", async () => {
    const no = harness({
      interactive: true,
      ask: script(["", "", "", "n", "", "", "", "", "y"]).ask,
    });
    expect(await no.run("setup")).toBe(0);
    expect(no.fakeCalls("agy")).toEqual([]);

    const maybe = harness({
      interactive: true,
      ask: script(["", "", "", "y", "y", "", "", "", "", "y"]).ask,
    });
    expect(await maybe.run("setup")).toBe(0);
    expect(maybe.io.stdout).toContain("Terms not accepted: Antigravity stays off.");
    expect(maybe.instance("antigravity")?.enabled).toBe(false);
    expect(maybe.fakeCalls("agy")).toEqual([]);
  });

  it("interactively: --enable-antigravity without the terms still asks for them", async () => {
    const s = script(["", "", "", "yes", "unknown", "", "", "", "", "y"]);
    const k = harness({ interactive: true, ask: s.ask });
    expect(await k.run("setup", "--enable-antigravity")).toBe(0);
    expect(k.instance("antigravity")?.enabled).toBe(true);
  });

  it("an agy that is not installed stays off, with an explanation", async () => {
    const s = script(["", "", "", "y", "yes", "", "", "", "", "y"]);
    const k = harness({
      interactive: true,
      ask: s.ask,
      detect: async (ids) =>
        ids.map((id) => ({ id, installed: id !== "antigravity", version: null, loggedIn: null })),
    });
    expect(await k.run("setup")).toBe(0);
    expect(k.io.stdout).toContain("agy was not found on PATH");
    expect(k.instance("antigravity")?.enabled).toBe(false);
  });

  it("--reconfigure on a config that already enables agy does not ask about it again", async () => {
    const first = harness();
    expect(
      await first.run(
        "setup",
        "--non-interactive",
        "--yes",
        "--enable-antigravity",
        "--accept-agy-terms",
      ),
    ).toBe(0);
    const s = script(["", "", "", "", "", "", "", "", "", "y"]);
    const k = harness({ interactive: true, ask: s.ask }, {}, {}, true);
    expect(await k.run("setup", "--reconfigure")).toBe(0);
    expect(s.asked.some((q) => q.includes("enable Antigravity") || q.includes('Type "yes"'))).toBe(
      false,
    );
    expect(k.config()).toMatch(/tos_acknowledged: true/);
    expect(k.fakeCalls("agy")).toEqual([]);
  });
});

describe("install on a fresh HOME runs setup first [UC1]", () => {
  it("passes the answer flags through and ends with a usable, trusted config", async () => {
    const r = tempRepo();
    repo = r;
    const k = harness(
      { hosts: () => [fakeCodexHost()] },
      {},
      { cwd: () => r.dir, now: () => new Date("2026-11-07T10:00:00Z"), isInteractive: () => false },
    );
    mkdirSync(join(h.home, ".codex"));
    const code = await k.run(
      ...["install", "--non-interactive", "--yes"],
      ...[
        "--plan",
        "codex=plus",
        "--autonomy",
        "read-only",
        "--host",
        "codex",
        "--profile",
        "preserve",
      ],
    );
    expect(k.io.stderr).toBe("");
    expect(code).toBe(0);
    expect(k.io.stdout).toContain("running `dispatch setup` first");
    const eff = loadEffectiveConfig({ cwd: r.dir, env: k.env });
    expect(eff.trusted).toBe(true);
    expect(eff.execution.autonomy).toBe("read-only");
    expect(eff.routing.activeProfile).toBe("preserve");
    expect(eff.execution.instances.find((i) => i.id === "codex")?.plan).toBe("plus");
    expect(validate(eff).filter((i) => i.level === "error")).toEqual([]);
    expect(k.config()).toMatch(/^main_host: codex$/m);
    // The trust grant landed in the same file, below the documented options.
    expect(k.config()).toContain("trusted_repos:");
    expect(k.config()).toContain("# Dispatch global configuration");
  });
});

describe("global config file", () => {
  it("is written atomically with mode 0600; 'create' refuses a file that appeared", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes")).toBe(0);
    expect(() => writeGlobalConfig(k.configPath, "version: 1\n", "create")).toThrow(
      /already exists/,
    );
    chmodSync(k.configPath, 0o644);
    writeGlobalConfig(k.configPath, "version: 1\n", "update");
    expect(statSync(k.configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.dispatchHome).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
