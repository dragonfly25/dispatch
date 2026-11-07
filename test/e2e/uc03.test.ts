/**
 * [UC3] The same from Codex (hard interception, spec §11 UC3 with the plan's amendment: the
 * `deny_redirect` mechanism). Verifica: the native Codex sub-agent does not start; the result
 * arrives as a tool result (`dispatch wait`).
 *
 * Two halves, both through the built CLI against fake CLIs: the launcher side (what the denied
 * spawn tells the model to run: `run --provider claude --detach --json`, an idempotent repeat,
 * `wait` exit 75, the `CODEX_SANDBOX` refusal) and the Codex host module (setup writes the skill,
 * the two hooks.json entries and the rules file; the PreToolUse `deny_redirect` reply; silence
 * outside trusted repos; the heartbeat doctor reads).
 *
 * Lower-level proofs: test/unit/runner-detach.test.ts, runner-multi.test.ts ([UC3] wait),
 * doctor.test.ts, host-assets.test.ts. Real Codex with /hooks approval: docs/manual-tests/UC3.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorld,
  HELP,
  parseJson,
  snapshotTree,
  THREE_PROVIDERS,
  useBundles,
  type World,
} from "./harness.js";

useBundles();

const CODEX_HOST = { CODEX_THREAD_ID: "019e-uc3-thread", CODEX_VERSION: "0.167.0" };
const TASK = ["--task", "add sub to math.js", "--path", "math.js"];

describe("[UC3] hard interception: the launcher side of deny_redirect", () => {
  it("[UC3] from a Codex session the redirected call runs on claude and the result arrives through wait", () => {
    const w = createWorld({
      env: CODEX_HOST,
      scenarios: {
        claude: [{ scenario: "success_edit", file: "math.js", content: "claude edit\n" }],
      },
    });
    const before = snapshotTree(w.repo.dir);
    // What the denied spawn tells the model to run.
    const start = w.dispatch(["run", "--provider", "claude", "--detach", "--json", ...TASK]);
    expect(start.code, start.stderr).toBe(0);
    const { runId } = parseJson<{ runId: string }>(start);
    expect(runId).toMatch(/^[0-9A-Z]{26}$/);

    // The same call repeated (the model or the hook runner may retry): the same run, one agent.
    const again = w.dispatch(["run", "--provider", "claude", "--detach", "--json", ...TASK]);
    expect(parseJson<{ runId: string }>(again).runId).toBe(runId);

    const waited = w.dispatch(["wait", runId, "--timeout", "60", "--json"]);
    expect(waited.code, waited.stderr).toBe(0);
    const result = parseJson<{
      status: string;
      outcome: string;
      externalAgent: { instance: string; marker: string };
      patch: { applies: boolean };
    }>(waited);
    expect(result).toMatchObject({
      status: "completed",
      outcome: "success",
      externalAgent: { instance: "claude", marker: "EXTERNAL_AGENT_OUTPUT" },
      patch: { applies: true },
    });
    // Codex itself (the host) was never started; claude ran exactly once.
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toEqual([]);
    expect(
      w.fakes.readLog({ cli: "claude", kind: "run" }).filter((c) => c.args.includes("-p")),
    ).toHaveLength(1);
    expect(snapshotTree(w.repo.dir, { exclude: [".git/objects", ".dispatch"] })).toEqual(
      Object.fromEntries(Object.entries(before).filter(([p]) => !p.startsWith(".dispatch"))),
    );
    // Text form of wait is what the model sees as the tool result.
    const text = w.dispatch(["wait", runId]);
    expect(text.stdout).toContain(`Run ${runId}: completed (success)`);
    expect(text.stdout).toContain("EXTERNAL AGENT OUTPUT (untrusted");
  });

  it("[UC3] wait exits 75 while the run is still going, then returns the same result", () => {
    const w = createWorld({
      env: CODEX_HOST,
      scenarios: {
        claude: [
          {
            scenario: "slow",
            delayMs: 300,
          },
        ],
      },
    });
    const start = w.dispatch(["run", "--provider", "claude", "--detach", "--json", ...TASK]);
    const { runId } = parseJson<{ runId: string }>(start);
    const first = w.dispatch(["wait", runId, "--timeout", "0", "--json"]);
    expect(first.code).toBe(75);
    expect(parseJson<{ status: string }>(first).status).toBe("running");
    const done = w.dispatch(["wait", runId, "--timeout", "60", "--json"]);
    expect(done.code).toBe(0);
    expect(parseJson<{ runId: string; status: string }>(done)).toMatchObject({
      runId,
      status: "completed",
    });
    // gc keeps recent finished runs and says what it did.
    expect(w.dispatch(["gc"]).code).toBe(0);
  });

  it("[UC3] when the Codex rule did not match (CODEX_SANDBOX set) run and wait refuse with exit 3", () => {
    const w = createWorld({ env: { ...CODEX_HOST, CODEX_SANDBOX: "seatbelt" } });
    for (const args of [
      ["run", "--detach", "--json", ...TASK],
      ["wait", "01M6TQD75GPN5MDEPXZK345NGK"],
    ]) {
      const r = w.dispatch(args);
      expect(r.code, args.join(" ")).toBe(3);
      expect(r.stderr).toMatch(/rule|sandbox/i);
    }
    expect(w.fakes.readLog({ kind: "run" })).toEqual([]);
    // doctor is exempt from the gate: it is how the user finds the cause.
    expect(w.dispatch(["doctor", "--from-host"]).code).not.toBe(3);
  });
});

const CODEX_HOOKS = '{\n  // my own hook\n  "hooks": {}\n}\n';
const CODEX_CONFIG = '# user config\nmodel = "gpt-6-sol"\n';

/** A user with Codex configured, Dispatch set up and a trusted repo (the fake `codex` is on PATH). */
function codexWorld(globalExtra = "") {
  const w = createWorld({ global: `${THREE_PROVIDERS}${globalExtra}` });
  const codex = join(w.home.home, ".codex");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "hooks.json"), CODEX_HOOKS);
  writeFileSync(join(codex, "config.toml"), CODEX_CONFIG);
  const setup = w.dispatch(["setup", "--yes"]);
  expect(setup.code, setup.stderr).toBe(0);
  const install = w.dispatch(["install", "--yes"]);
  expect(install.code, install.stderr).toBe(0);
  const hooks = JSON.parse(
    readFileSync(join(codex, "hooks.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ).hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  return {
    w,
    codex,
    launcher: join(w.home.dispatchHome, "bin", "dispatch"),
    command: (event: "SessionStart" | "PreToolUse") => hooks[event]?.[0]?.hooks[0]?.command ?? "",
    matcher: hooks.PreToolUse?.[0]?.matcher,
  };
}

/** What Codex does: run the hook command under a GUI-like environment, payload on stdin. */
function fire(w: World, command: string, payload: object, env: string[] = []) {
  return w.exec(
    "/usr/bin/env",
    ["-i", "PATH=/usr/bin:/bin", `HOME=${w.home.home}`, ...env, "/bin/sh", "-c", command],
    { input: JSON.stringify(payload) },
  );
}

const spawn = (cwd: string, tool = "spawn_agent") => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { message: "ENCRYPTED" },
  session_id: "s1",
  cwd,
});

const denyReason = (stdout: string): string =>
  JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;

describe("[UC3] hard interception: the Codex host", () => {
  it("[UC3] setup writes the skill, two hooks.json entries and the rules file; config.toml is untouched", () => {
    const { w, codex, launcher, matcher } = codexWorld();
    const skill = join(w.home.home, ".agents", "skills", "dispatch", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain(launcher);
    const hooks = readFileSync(join(codex, "hooks.json"), "utf8");
    expect(hooks).toContain("// my own hook"); // the user's comment survives the edit
    expect(hooks).toContain("codex SessionStart");
    expect(hooks).toContain("codex PreToolUse");
    expect(matcher).toBe("spawn_agent|collaborationspawn_agent|Agent");
    const rules = readFileSync(join(codex, "rules", "dispatch.rules"), "utf8");
    expect(rules).toContain(launcher);
    expect(rules).toMatch(/"run", "wait", "cancel", "status"/);
    // Dispatch never writes the hook trust (the user's /hooks approval) or other Codex config.
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe(CODEX_CONFIG);
    // The repo diff is still only .dispatch/.
    expect(w.repo.git("status", "--porcelain")).toBe("?? .dispatch/");
  });

  it("[UC3] a native spawn in a trusted repo is denied with a reason naming run --detach and wait", () => {
    const { w, command, launcher } = codexWorld();
    for (const tool of ["spawn_agent", "collaborationspawn_agent", "Agent"]) {
      const r = fire(w, command("PreToolUse"), spawn(w.repo.dir, tool));
      expect(r.code, `${tool}: ${r.stderr}`).toBe(0);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      const reason = denyReason(r.stdout);
      expect(reason).toContain("Do not retry spawn_agent");
      expect(reason).toContain(`${launcher} run --detach --json --task '`);
      expect(reason).toContain(`${launcher} wait <runId> --json --timeout 280`);
      expect(reason).toContain("EXTERNAL_AGENT_OUTPUT");
    }
    // Other tools are none of its business.
    expect(fire(w, command("PreToolUse"), spawn(w.repo.dir, "shell")).stdout).toBe("");
  });

  it("[UC3] the denial is silent outside a trusted repo, in a Dispatch child, and when hard mode is off", () => {
    const { w, command } = codexWorld();
    const elsewhere = join(w.home.home, "other-project");
    mkdirSync(elsewhere);
    for (const [label, r] of [
      ["untrusted dir", fire(w, command("PreToolUse"), spawn(elsewhere))],
      ["dispatch child", fire(w, command("PreToolUse"), spawn(w.repo.dir), ["DISPATCH_DEPTH=1"])],
      ["no tool", fire(w, command("PreToolUse"), {})],
    ] as const) {
      expect({ label, code: r.code, out: r.stdout, err: r.stderr }).toEqual({
        label,
        code: 0,
        out: "",
        err: "",
      });
    }
    const soft = codexWorld("hosts:\n  codex: { hard: false }\n");
    const r = fire(soft.w, soft.command("PreToolUse"), spawn(soft.w.repo.dir));
    expect({ code: r.code, out: r.stdout }).toEqual({ code: 0, out: "" });
    // ... but SessionStart still injects the policy there.
    const start = fire(soft.w, soft.command("SessionStart"), {
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: soft.w.repo.dir,
    });
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toContain(
      "Dispatch is active in this repository",
    );
  });

  it("[UC3] the launcher in the deny reason is the one the rules file allows; doctor sees the hooks fire", () => {
    const { w, codex, command, launcher } = codexWorld();
    const reason = denyReason(fire(w, command("PreToolUse"), spawn(w.repo.dir)).stdout);
    const rules = readFileSync(join(codex, "rules", "dispatch.rules"), "utf8");
    // Every launcher path in the reason is exactly the rule's pattern head (absolute, no ~/PATH).
    const named = [...reason.matchAll(/(\/\S*\/bin\/dispatch) (run|wait)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const path of named) expect(path).toBe(launcher);
    expect(rules).toContain(`pattern = ["${launcher}", ["run", "wait", "cancel", "status"]]`);

    type Checks = { checks: { id: string; status: string }[] };
    const doctor = () => parseJson<Checks>(w.dispatch(["doctor", "--json"])).checks;
    // Before any session: the heartbeat is missing and doctor asks for the /hooks approval.
    const before = doctor();
    expect(before.find((c) => c.id === "codex.rules-launcher")?.status).toBe("ok");
    expect(before.find((c) => c.id === "codex.hooks-trusted")?.status).toBe("warn");
    // A SessionStart (what Codex runs once the hooks are approved) leaves the heartbeat.
    fire(w, command("SessionStart"), {
      hook_event_name: "SessionStart",
      cwd: w.repo.dir,
      session_id: "s1",
    });
    const after = doctor();
    expect(after.find((c) => c.id === "codex.hooks-trusted")?.status).toBe("ok");
    expect(after.find((c) => c.id === "codex.files")?.status).toBe("ok");
  });

  it("[UC3] from the denied spawn to the result: the model runs the launcher and gets claude's patch", () => {
    const { w, command, launcher } = codexWorld();
    w.fakes.setScenarios({
      ...HELP,
      claude: [{ scenario: "success_edit", file: "math.js", content: "claude edit\n" }],
    });
    const denied = fire(w, command("PreToolUse"), spawn(w.repo.dir));
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    // What the model then runs (host = Codex; the rule matched, so CODEX_SANDBOX is not set).
    const env = { CODEX_THREAD_ID: "019e-uc3", CODEX_VERSION: "0.167.0" };
    const start = w.exec(launcher, ["run", "--detach", "--json", "--task", "add sub to math.js"], {
      env,
    });
    expect(start.code, start.stderr).toBe(0);
    const { runId } = parseJson<{ runId: string }>(start);
    const done = w.exec(launcher, ["wait", runId, "--json", "--timeout", "60"], { env });
    expect(done.code, done.stderr).toBe(0);
    expect(parseJson<{ status: string; externalAgent: { instance: string } }>(done)).toMatchObject({
      status: "completed",
      externalAgent: { instance: "claude" },
    });
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toEqual([]);
  });
});
