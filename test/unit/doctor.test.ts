/** WP26: `dispatch doctor` with fake CLIs, a temp HOME and temp repos. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromHostLines } from "../../src/doctor/host.js";
import { patchFiles } from "../../src/doctor/live.js";
import { loadFixtureVersions } from "../../src/doctor/provider.js";
import { launcherLine, platformLine } from "../../src/doctor/system.js";
import { HostRegistry } from "../../src/hosts/_framework/registry.js";
import { builtinRegistry } from "../../src/hosts/index.js";
import { type TempRepo, tempRepo } from "../support/index.js";
import {
  agyReply,
  type DoctorHarness,
  doctorHarness,
  ENABLE_AGY,
  helpScenario,
  lineOf,
} from "./doctor.helpers.js";

let h: DoctorHarness;
let repo: TempRepo | undefined;
afterEach(() => {
  h?.cleanup();
  repo?.cleanup();
  repo = undefined;
});

const ranTasks = (cli: "claude" | "codex" | "agy") => h.fakes.readLog({ cli, kind: "run" });

describe("doctor: checks", () => {
  it("[UC1] an all-green matrix: every enabled provider passes, nothing fails, exit 0", async () => {
    h = doctorHarness();
    h.config(ENABLE_AGY);
    const { code, report } = await h.report();
    expect(code).toBe(0);
    expect(report).toMatchObject({ schemaVersion: 1, ok: true, exitCode: 0, live: false });
    expect(report.summary.fail).toBe(0);

    expect(lineOf(report, "launcher").status).toBe("ok");
    expect(lineOf(report, "config.global").status).toBe("ok");
    for (const id of ["claude", "codex", "antigravity"]) {
      const bin = lineOf(report, `${id}.binary`);
      expect(bin).toMatchObject({ status: "ok", section: id });
      expect(bin.data).toMatchObject({ source: "path" });
      expect(lineOf(report, `${id}.version`).status).toBe("ok");
      expect(lineOf(report, `${id}.flags`).status).toBe("ok");
      expect(lineOf(report, `${id}.fixtures`).status).toBe("ok");
      expect(lineOf(report, `${id}.quota`).status).toBe("ok");
    }
    expect(lineOf(report, "codex.login").status).toBe("ok");
    expect(lineOf(report, "antigravity.login").status).toBe("ok");
    expect(lineOf(report, "codex.models").status).toBe("ok");
    // Claude has no quota-free login check: the line says how to verify.
    expect(lineOf(report, "claude.login")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "claude.login").message).toContain("`claude` interactively");
    expect(lineOf(report, "claude.pool").message).toContain("automated use");
    expect(lineOf(report, "claude.isolation").status).toBe("ok");
    // Antigravity: isolation and ToS disclosures.
    expect(lineOf(report, "antigravity.isolation")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "antigravity.isolation").message).toContain("user hooks");
    expect(lineOf(report, "antigravity.isolation").message).toContain("cannot be disabled");
    expect(lineOf(report, "antigravity.pool").message).toContain(
      "not supported under consumer plans",
    );
    // Quota-free probes only: no task was run on any provider.
    for (const cli of ["claude", "codex", "agy"] as const) {
      expect(ranTasks(cli).filter((r) => r.args[0] !== "--help" && r.args[1] !== "--help")).toEqual(
        [],
      );
    }
  });

  it("text output groups lines by section, shows fixes and a summary", async () => {
    h = doctorHarness();
    const { code, out } = await h.run(["doctor"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^dispatch doctor\n\nsystem\n/);
    expect(out).toContain("\nclaude\n");
    expect(out).toMatch(/warn\s+claude\.login: .*\n\s+fix: run `claude` once interactively/);
    expect(out).toMatch(/Doctor OK: \d+ ok, \d+ warning\(s\), 0 failure\(s\)/);
  });

  it("a missing binary fails that instance only, with a fix, and exits 4", async () => {
    h = doctorHarness();
    h.config("version: 1\nproviders:\n  codex: { binary: /nonexistent/codex }\n");
    const { code, report } = await h.report();
    expect(code).toBe(4);
    expect(report).toMatchObject({ ok: false, exitCode: 4 });
    expect(lineOf(report, "codex.binary")).toMatchObject({ status: "fail" });
    expect(lineOf(report, "codex.binary").message).toContain("/nonexistent/codex");
    expect(lineOf(report, "codex.binary").fix).toContain("providers.codex.binary");
    expect(report.checks.some((c) => c.id === "codex.version")).toBe(false);
    expect(lineOf(report, "claude.binary").status).toBe("ok");
    expect(h.fakes.readLog({ cli: "codex" })).toEqual([]);
  });

  it("a binary that is on no search path is a failure with install advice", async () => {
    h = doctorHarness();
    const none = { isExecutableFile: () => false, realpath: (p: string) => p };
    const { code, report } = await h.report([], { doctor: { resolveFs: none } });
    expect(code).toBe(4);
    for (const id of ["claude", "codex"]) {
      expect(lineOf(report, `${id}.binary`).message).toContain("was not found");
    }
  });

  it("[UC1] codex logged out: fail with `codex login`", async () => {
    h = doctorHarness({ "codex:login": { loggedIn: false } });
    const { code, report } = await h.report();
    expect(code).toBe(4);
    expect(lineOf(report, "codex.login")).toMatchObject({ status: "fail", fix: "codex login" });
  });

  it("an unreadable login state is a warning", async () => {
    h = doctorHarness({ "codex:login": { exitCode: 7 } });
    const { report } = await h.report();
    expect(lineOf(report, "codex.login").status).toBe("warn");
  });

  it("a CLI outside the tested range is a warning (and has no fixtures)", async () => {
    h = doctorHarness({ "codex:version": { stdout: "codex-cli 0.200.0\n" } });
    const { code, report } = await h.report();
    expect(code).toBe(0);
    expect(lineOf(report, "codex.version")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "codex.version").message).toContain("outside the tested range");
    expect(lineOf(report, "codex.fixtures").status).toBe("warn");
    expect(lineOf(report, "codex.fixtures").message).toContain("no recorded fixtures for 0.200.0");
  });

  it("an unreadable version is a warning; missing required flags are a failure", async () => {
    h = doctorHarness({
      "codex:version": { exitCode: 1 },
      claude: [{ scenario: "fail", stdout: "Usage: claude\n  --print\n", stderr: "", exitCode: 0 }],
    });
    const { report } = await h.report();
    expect(lineOf(report, "codex.version").status).toBe("warn");
    expect(lineOf(report, "claude.flags")).toMatchObject({ status: "fail" });
    expect(lineOf(report, "claude.flags").message).toContain("--safe-mode");
  });

  it("an empty --help is a failure for claude and a warning for codex", async () => {
    h = doctorHarness({
      claude: [{ scenario: "fail", stdout: "", stderr: "", exitCode: 0 }],
      codex: [{ scenario: "fail", stdout: "", stderr: "", exitCode: 0 }],
    });
    const { report } = await h.report();
    expect(lineOf(report, "claude.flags").status).toBe("fail");
    expect(lineOf(report, "codex.flags").status).toBe("warn");
  });

  it("[UC11] a quota reader with a changed format fails that channel and says routing continues", async () => {
    h = doctorHarness({ "codex:app-server": { variant: "changed_format" } });
    const { code, report } = await h.report();
    expect(code).toBe(4);
    const q = lineOf(report, "codex.quota");
    expect(q.status).toBe("fail");
    expect(q.message).toContain("format changed");
    expect(q.message).toContain("Routing continues on estimates");
    expect(q.fix).toContain("quota.readers.codex.enabled");
    // The other channels and the other checks still ran.
    expect(lineOf(report, "claude.quota").status).toBe("ok");
    expect(lineOf(report, "codex.login").status).toBe("ok");
  });

  it("[UC11] a reader switched off in the config is not a failure", async () => {
    h = doctorHarness({ "codex:app-server": { variant: "changed_format" } });
    h.config("version: 1\nquota:\n  readers:\n    codex: { enabled: false }\n");
    const { code, report } = await h.report();
    expect(code).toBe(0);
    expect(lineOf(report, "codex.quota").message).toContain("disabled");
  });

  it("[UC11] a fresh read is forced even when a recent reading is cached", async () => {
    h = doctorHarness();
    expect((await h.report()).report.checks.find((c) => c.id === "codex.quota")?.status).toBe("ok");
    h.fakes.setScenarios({ codex: [], "codex:app-server": { variant: "changed_format" } });
    const again = await h.report();
    expect(lineOf(again.report, "codex.quota").status).toBe("fail");
  });

  it("a disabled Antigravity is listed as disabled and never started", async () => {
    h = doctorHarness();
    const { report } = await h.report();
    expect(lineOf(report, "antigravity.enabled")).toMatchObject({
      status: "ok",
      section: "antigravity",
    });
    expect(lineOf(report, "antigravity.enabled").message).toContain("disabled");
    expect(
      report.checks.some((c) => c.id.startsWith("antigravity.") && c.id !== "antigravity.enabled"),
    ).toBe(false);
    expect(h.fakes.readLog({ cli: "agy" })).toEqual([]);
    expect(h.fakes.readLog().some((i) => i.cli === "agy")).toBe(false);
  });

  it("tier models the installed CLI does not offer are a warning", async () => {
    h = doctorHarness({
      "codex:models": { stdout: JSON.stringify({ models: [{ slug: "other" }] }) },
    });
    const { report } = await h.report();
    expect(lineOf(report, "codex.models")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "codex.models").message).toContain("fast=gpt-6-luna");
  });

  it("an unlistable model catalog is a warning", async () => {
    h = doctorHarness({ "codex:models": { exitCode: 1 } });
    const { report } = await h.report();
    expect(lineOf(report, "codex.models").status).toBe("warn");
    h.cleanup();
    h = doctorHarness({ "codex:models": { stdout: "not json" } });
    expect(lineOf((await h.report()).report, "codex.models").status).toBe("warn");
  });

  it("agy model ids are compared with the tier table", async () => {
    h = doctorHarness();
    h.config(ENABLE_AGY);
    const { report } = await h.report();
    // The fake lists gemini-3.8-flash-low but not -medium/-high.
    expect(lineOf(report, "antigravity.models")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "antigravity.models").message).toContain(
      "balanced=gemini-3.8-flash-medium",
    );
  });

  it("an adapter Dispatch does not ship is a warning, and nothing is started", async () => {
    h = doctorHarness();
    h.config("version: 1\nproviders:\n  mystery: { adapter: nope }\n");
    const { report } = await h.report();
    expect(lineOf(report, "mystery.adapter").status).toBe("warn");
  });

  it("an invalid global config fails, the system and host checks still run", async () => {
    h = doctorHarness();
    h.config("version: 1\nnonsense: true\n");
    const custom = new HostRegistry();
    custom.registerDoctorCheck({ id: "x.check", run: () => ({ status: "ok", message: "fine" }) });
    const { code, report } = await h.report([], { doctor: { registry: custom } });
    expect(code).toBe(4);
    expect(lineOf(report, "config.global")).toMatchObject({ status: "fail" });
    expect(lineOf(report, "platform").status).toBe("ok");
    expect(lineOf(report, "x.check")).toMatchObject({ status: "ok", section: "host" });
    expect(report.checks.some((c) => c.id === "claude.binary")).toBe(false);
  });

  it("a missing global config is a warning pointing at setup", async () => {
    h = doctorHarness();
    const { report } = await h.report();
    expect(lineOf(report, "config.global")).toMatchObject({
      status: "warn",
      fix: "dispatch setup",
    });
  });

  it("loader warnings and errors become lines (the trust note is left to repo.trust)", async () => {
    h = doctorHarness();
    h.config("version: 1\nproviders:\n  antigravity: { enabled: true }\n");
    const { report } = await h.report();
    const issue = report.checks.find((c) => c.id === "config.issues");
    expect(issue?.status).toBe("warn");
    expect(issue?.message).toContain("tos_acknowledged");
  });

  it("registered host checks run, and a crashing one is a failure that does not stop the rest", async () => {
    h = doctorHarness();
    const custom = new HostRegistry();
    custom.registerDoctorCheck({ id: "a.boom", run: () => Promise.reject(new Error("boom")) });
    custom.registerDoctorCheck({
      id: "b.warn",
      run: () => ({ status: "warn", message: "careful", fix: "do x" }),
    });
    const { code, report } = await h.report([], { doctor: { registry: custom } });
    expect(code).toBe(4);
    expect(lineOf(report, "a.boom")).toMatchObject({ status: "fail", section: "host" });
    expect(lineOf(report, "a.boom").message).toContain("boom");
    expect(lineOf(report, "b.warn")).toMatchObject({ status: "warn", fix: "do x" });
  });

  it("the built-in registry contributes the claude-code and setup checks", async () => {
    h = doctorHarness();
    const { report } = await h.report([], { doctor: { registry: builtinRegistry() } });
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["setup.manifest", "claude-code.plugin", "claude-code.files"]),
    );
  });
});

describe("doctor: system lines", () => {
  it("[UC1] the launcher: missing is a warning, stale is a failure naming the paths", async () => {
    h = doctorHarness({}, { launcher: false });
    expect(lineOf((await h.report()).report, "launcher")).toMatchObject({
      status: "warn",
      fix: "dispatch setup",
    });
    const launcher = join(h.home.dispatchHome, "bin");
    const write = (text: string) => {
      require("node:fs").mkdirSync(launcher, { recursive: true });
      writeFileSync(join(launcher, "dispatch"), text);
    };
    write("#!/bin/sh\necho hi\n");
    expect(launcherLine(h.home.dispatchHome)).toMatchObject({
      status: "warn",
      fix: "dispatch setup --refresh",
    });
    write(
      `#!/bin/sh\nexec "/gone/node" --disable-warning=ExperimentalWarning "/gone/cli.mjs" "$@"\n`,
    );
    const stale = launcherLine(h.home.dispatchHome);
    expect(stale).toMatchObject({ status: "fail", fix: "dispatch setup --refresh" });
    expect(stale.message).toContain("/gone/node");
    expect(stale.message).toContain("/gone/cli.mjs");
    expect(stale.message).toContain("/gone/hook.mjs");
    const { code } = await h.run(["doctor"]);
    expect(code).toBe(4);
  });

  it("the platform line rejects Windows and an old Node", () => {
    expect(platformLine("darwin", "v22.13.0").status).toBe("ok");
    expect(platformLine("linux", "v24.1.0").status).toBe("ok");
    expect(platformLine("win32", "v22.13.0")).toMatchObject({ status: "fail" });
    expect(platformLine("darwin", "v22.12.0")).toMatchObject({ status: "fail" });
    expect(platformLine("darwin", "v20.1.0").message).toContain(">= 22.13");
  });

  it("[UC1] repo trust: untrusted, trusted by `dispatch trust`, then changed", async () => {
    h = doctorHarness();
    repo = tempRepo({ files: { ".dispatch/config.yaml": "version: 1\n" } });
    const trust = async () =>
      lineOf((await h.report([], { cwd: repo?.dir ?? "" })).report, "repo.trust");
    expect(await trust()).toMatchObject({
      status: "warn",
      section: "repo",
      fix: expect.stringContaining("dispatch trust"),
    });
    expect((await h.run(["trust"], { cwd: repo.dir })).code).toBe(0);
    expect((await trust()).status).toBe("ok");
    writeFileSync(join(repo.dir, ".dispatch", "config.yaml"), "version: 1\nprofile: preserve\n");
    const changed = await trust();
    expect(changed.status).toBe("warn");
    expect(changed.message).toContain("changed since it was trusted");
  });

  it("repo trust: no policy, no repo", async () => {
    h = doctorHarness();
    repo = tempRepo();
    expect(lineOf((await h.report([], { cwd: repo.dir })).report, "repo.trust").message).toContain(
      "no .dispatch/ policy",
    );
    expect(lineOf((await h.report()).report, "repo.trust").message).toContain(
      "not inside a git repository",
    );
  });

  it("repo trust: a symlink in .dispatch is flagged", async () => {
    h = doctorHarness();
    repo = tempRepo({ files: { ".dispatch/config.yaml": "version: 1\n", "other.yaml": "x: 1\n" } });
    require("node:fs").symlinkSync(
      join(repo.dir, "other.yaml"),
      join(repo.dir, ".dispatch", "profiles.yaml"),
    );
    const l = lineOf((await h.report([], { cwd: repo.dir })).report, "repo.trust");
    expect(l.status).toBe("warn");
    expect(l.message).toContain("symlink");
  });
});

describe("doctor --from-host", () => {
  it("[UC1] outside any host it warns that there is nothing to verify", async () => {
    h = doctorHarness();
    const { report } = await h.report(["--from-host"]);
    expect(lineOf(report, "host.detected")).toMatchObject({ status: "warn", section: "host" });
  });

  it("inside Claude Code the state dir is checked as writable", async () => {
    h = doctorHarness();
    const { report } = await h.report(["--from-host"], { env: { CLAUDECODE: "1" } });
    expect(lineOf(report, "host.detected").message).toContain("claude-code");
    expect(lineOf(report, "host.state-writable").status).toBe("ok");
    expect(report.checks.some((c) => c.id === "host.codex-rule")).toBe(false);
  });

  it("[UC3] inside Codex with the rule matched: ok", async () => {
    h = doctorHarness();
    const { report } = await h.report(["--from-host"], { env: { CODEX_THREAD_ID: "t1" } });
    expect(lineOf(report, "host.codex-rule").status).toBe("ok");
  });

  it("[UC3] CODEX_SANDBOX set: doctor still runs (not gated) and says how to fix the rule", async () => {
    h = doctorHarness();
    const r = await h.report(["--from-host"], {
      env: { CODEX_THREAD_ID: "t1", CODEX_SANDBOX: "seatbelt" },
    });
    expect(r.code).toBe(4);
    const l = lineOf(r.report, "host.codex-rule");
    expect(l.status).toBe("fail");
    expect(l.message).toContain("rules file did not match");
    expect(l.fix).toContain("/hooks");
    expect(l.fix).toContain("dispatch.rules");
    // Other commands stay gated.
    expect((await h.run(["providers"], { env: { CODEX_SANDBOX: "seatbelt" } })).code).toBe(3);
  });

  it("an unwritable state dir fails with advice", () => {
    h = doctorHarness();
    writeFileSync(join(h.home.dispatchHome, "state"), "a file, not a directory");
    const lines = fromHostLines({ CODEX_THREAD_ID: "t" }, h.home.dispatchHome);
    const w = lines.find((l) => l.id === "host.state-writable");
    expect(w?.status).toBe("fail");
    expect(w?.fix).toContain("Codex sandbox");
    const claude = fromHostLines({ CLAUDECODE: "1" }, h.home.dispatchHome).find(
      (l) => l.id === "host.state-writable",
    );
    expect(claude?.fix).toContain("write access");
  });
});

describe("doctor --live", () => {
  const edit = (file: string, content = "ok\n") => ({
    scenario: "success_edit" as const,
    file,
    content,
  });

  it("[UC1] one real task per enabled provider passes when it adds exactly DISPATCH_OK", async () => {
    h = doctorHarness({
      claude: [
        { scenario: "fail", stdout: "Usage: claude\n  --safe-mode\n", stderr: "", exitCode: 0 },
        edit("DISPATCH_OK"),
      ],
      codex: [
        { scenario: "fail", stdout: "Usage\n", stderr: "", exitCode: 0 },
        edit("DISPATCH_OK"),
      ],
    });
    const { code, report, err } = await h.report(["--live", "--yes"]);
    expect(code).toBe(0);
    expect(report.live).toBe(true);
    expect(lineOf(report, "live.claude")).toMatchObject({ status: "ok", section: "live" });
    expect(lineOf(report, "live.codex").status).toBe("ok");
    expect(lineOf(report, "live.claude").data).toMatchObject({
      status: "completed",
      outcome: "success",
    });
    expect(report.checks.some((c) => c.id === "live.antigravity")).toBe(false);
    // JSON mode keeps stdout clean: the plan went to stderr.
    expect(err).toContain("consumes a small amount of quota");
    expect(err).toContain('"Create a file named DISPATCH_OK containing the word ok"');
    // The tasks really ran, once each, with the live prompt.
    const claudeRun = ranTasks("claude").find((r) => r.stdin?.includes("DISPATCH_OK"));
    expect(claudeRun).toBeDefined();
    expect(ranTasks("codex").some((r) => r.stdin?.includes("DISPATCH_OK"))).toBe(true);
  }, 60_000);

  it("fails when the agent edits another file", async () => {
    h = doctorHarness({
      claude: [
        { scenario: "fail", stdout: "Usage: claude\n  --safe-mode\n", stderr: "", exitCode: 0 },
        edit("OTHER.txt"),
      ],
    });
    const { code, report } = await h.report(["--live", "--yes", "--provider", "claude"]);
    expect(code).toBe(4);
    const l = lineOf(report, "live.claude");
    expect(l.status).toBe("fail");
    expect(l.message).toContain("expected a patch adding only DISPATCH_OK, got: OTHER.txt");
    expect(l.fix).toContain("run log");
    expect(report.checks.some((c) => c.id === "live.codex")).toBe(false);
  }, 60_000);

  it("fails when DISPATCH_OK does not say ok, or the run is not a success", async () => {
    h = doctorHarness({
      claude: [
        { scenario: "fail", stdout: "Usage: claude\n  --safe-mode\n", stderr: "", exitCode: 0 },
        edit("DISPATCH_OK", "nope\n"),
      ],
      codex: [
        { scenario: "fail", stdout: "Usage\n", stderr: "", exitCode: 0 },
        { scenario: "quota_exhausted" },
      ],
    });
    const { report } = await h.report(["--live", "--yes"]);
    expect(lineOf(report, "live.claude").message).toContain('does not contain "ok"');
    const codex = lineOf(report, "live.codex");
    expect(codex.status).toBe("fail");
    expect(codex.message).toMatch(/returned_to_host|quota/);
  }, 60_000);

  it("[UC1] Antigravity is tested read-only: pass when the reply says ok", async () => {
    h = doctorHarness({
      agy: [{ scenario: "fail", stdout: "Usage\n", stderr: "", exitCode: 0 }, agyReply("ok")],
    });
    h.config(ENABLE_AGY);
    const { code, report } = await h.report(["--live", "--yes", "--provider", "antigravity"]);
    expect(code).toBe(0);
    expect(lineOf(report, "live.antigravity")).toMatchObject({ status: "ok" });
    expect(lineOf(report, "live.antigravity").message).toContain("replied ok");
    const runs = ranTasks("agy").filter((r) =>
      r.argv.some((a) => a.startsWith("-p=Reply") || a.includes("Reply with the word ok")),
    );
    expect(runs.length).toBe(1);
  }, 60_000);

  it("Antigravity fails the live test when the reply lacks ok", async () => {
    h = doctorHarness({
      agy: [{ scenario: "fail", stdout: "Usage\n", stderr: "", exitCode: 0 }, agyReply("nothing")],
    });
    h.config(ENABLE_AGY);
    const { report } = await h.report(["--live", "--yes", "--provider", "antigravity"]);
    expect(lineOf(report, "live.antigravity").message).toContain('does not contain "ok"');
  }, 60_000);

  it("a disabled provider named with --provider is skipped without starting anything", async () => {
    h = doctorHarness();
    const { code, report } = await h.report(["--live", "--yes", "--provider", "antigravity"]);
    expect(code).toBe(0);
    expect(lineOf(report, "live.antigravity")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "live.antigravity").message).toContain("disabled");
    expect(lineOf(report, "live").message).toContain("no provider to test");
    expect(report.live).toBe(false);
    expect(h.fakes.readLog().some((i) => i.cli === "agy")).toBe(false);
  });

  it("never tests the host itself", async () => {
    h = doctorHarness({
      codex: [
        { scenario: "fail", stdout: "Usage\n", stderr: "", exitCode: 0 },
        edit("DISPATCH_OK"),
      ],
    });
    const { report } = await h.report(["--live", "--yes"], { env: { CLAUDECODE: "1" } });
    expect(lineOf(report, "live.claude")).toMatchObject({ status: "warn" });
    expect(lineOf(report, "live.claude").message).toContain("host itself");
    expect(lineOf(report, "live.codex").status).toBe("ok");
    expect(ranTasks("claude").every((r) => !r.stdin?.includes("DISPATCH_OK"))).toBe(true);
  }, 60_000);

  it("skips an instance whose binary is unavailable", async () => {
    h = doctorHarness();
    h.config("version: 1\nproviders:\n  codex: { binary: /nonexistent/codex }\n");
    const { report } = await h.report(["--live", "--yes", "--provider", "codex"]);
    expect(lineOf(report, "live.codex").message).toContain("binary or adapter is unavailable");
  });

  it("non-interactive without --yes is a usage error before anything runs", async () => {
    h = doctorHarness();
    const r = await h.run(["doctor", "--live"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--yes");
    expect(h.fakes.readLog()).toEqual([]);
  });

  it("--provider needs --live; an unknown provider is a usage error", async () => {
    h = doctorHarness();
    expect((await h.run(["doctor", "--provider", "claude"])).code).toBe(2);
    const r = await h.run(["doctor", "--live", "--yes", "--provider", "ghost"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown provider(s) ghost");
  });

  it("interactive: the plan is printed, `n` cancels, `y` runs", async () => {
    h = doctorHarness({
      // Each doctor run probes once (`exec --help`), so the edit is the third call.
      codex: [helpScenario("codex"), helpScenario("codex"), edit("DISPATCH_OK")],
    });
    const questions: string[] = [];
    const answer = (a: string) => async (q: string) => {
      questions.push(q);
      return a;
    };
    const no = await h.run(["doctor", "--live", "--provider", "codex"], {
      doctor: { interactive: true, ask: answer("n") },
    });
    expect(no.code).toBe(0);
    expect(no.out).toContain("consumes a small amount of quota");
    expect(no.out).toContain("cancelled: nothing was run");
    expect(ranTasks("codex").some((r) => r.stdin?.includes("DISPATCH_OK"))).toBe(false);

    const yes = await h.run(["doctor", "--live", "--provider", "codex"], {
      doctor: { interactive: true, ask: answer("y") },
    });
    expect(yes.code).toBe(0);
    expect(yes.out).toMatch(/ok\s+live\.codex: codex: produced a patch adding only DISPATCH_OK/);
    expect(questions).toEqual(["Run it? [y/N] ", "Run it? [y/N] "]);
  }, 60_000);

  it("a configuration that cannot load skips the live step with a failure", async () => {
    h = doctorHarness();
    h.config("version: 1\nnonsense: true\n");
    const { code, report } = await h.report(["--live", "--yes"]);
    expect(code).toBe(4);
    expect(lineOf(report, "live").message).toContain("could not be loaded");
  });

  it("patchFiles lists the files of a diff", () => {
    const diff = "diff --git a/A b/A\nnew file\n+x\ndiff --git a/dir/B b/dir/B\n+y\n";
    expect(patchFiles(diff)).toEqual(["A", "dir/B"]);
    expect(patchFiles("")).toEqual([]);
  });
});

describe("doctor: fixture manifest", () => {
  it("assets/fixture-versions.json lists exactly the fixture directories under test/fixtures", () => {
    const root = join(__dirname, "..", "fixtures");
    const dirs = (cli: string) => readdirSync(join(root, cli)).sort();
    const manifest = loadFixtureVersions(join(__dirname, "..", "..", "assets"));
    expect(manifest).toEqual({
      claude: dirs("claude"),
      codex: dirs("codex"),
      antigravity: dirs("agy"),
    });
  });

  it("an unreadable or malformed manifest is null", () => {
    h = doctorHarness();
    expect(loadFixtureVersions(h.home.home)).toBeNull();
    writeFileSync(join(h.home.home, "fixture-versions.json"), "[1]");
    expect(loadFixtureVersions(h.home.home)).toBeNull();
    writeFileSync(join(h.home.home, "fixture-versions.json"), '{"claude":[1]}');
    expect(loadFixtureVersions(h.home.home)).toBeNull();
    writeFileSync(join(h.home.home, "fixture-versions.json"), "null");
    expect(loadFixtureVersions(h.home.home)).toBeNull();
    expect(
      JSON.parse(
        readFileSync(join(__dirname, "..", "..", "assets", "fixture-versions.json"), "utf8"),
      ),
    ).toHaveProperty("codex");
  });
});

describe("doctor: JSON shape", () => {
  it("has the documented top-level keys and line shape", async () => {
    h = doctorHarness();
    const { report } = await h.report();
    expect(Object.keys(report).sort()).toEqual([
      "checks",
      "exitCode",
      "live",
      "ok",
      "schemaVersion",
      "summary",
    ]);
    expect(Object.keys(report.summary).sort()).toEqual(["fail", "ok", "warn"]);
    for (const c of report.checks) {
      expect(["ok", "warn", "fail"]).toContain(c.status);
      expect(typeof c.id).toBe("string");
      expect(typeof c.section).toBe("string");
      expect(typeof c.message).toBe("string");
    }
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
      report.checks.length,
    );
  });
});
