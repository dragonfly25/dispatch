import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostIntegration } from "../../../src/core/contracts.js";
import {
  applySetup,
  assetOps,
  HostRegistry,
  hostPresent,
  manifestCheck,
  planSetup,
  readManifest,
  renderTemplate,
  type SetupContext,
  uninstallGlobal,
  writeManifest,
} from "../../../src/hosts/_framework/index.js";
import { manifestPath } from "../../../src/hosts/_framework/manifest.js";
import { launcherFileName } from "../../../src/platform/os.js";
import {
  CODEX_RULES_GRANT,
  fakeClaudeHost,
  fakeClaudeRunner,
  fakeCodexHost,
} from "../../support/fake-host.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

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

const JSONC = '{\n  // mine\n  "hooks": {\n    "Stop": [{ "hooks": [] }],\n  },\n}\n';

describe("planSetup / applySetup / uninstallGlobal", () => {
  it("absent hosts get no ops and no directories [UC1]", async () => {
    h = tempHome();
    const plan = await planSetup(
      ctx([fakeCodexHost({ present: false }), fakeClaudeHost({ present: false })]),
    );
    expect(plan.ops.map((o) => o.signature)).toEqual(["dispatch-launcher"]);
    expect(plan.absent).toEqual(["codex", "claude-code"]);
    expect(plan.preview).toMatch(/Hosts not found .*codex, claude-code/);
    await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true });
    expect(readdirSync(h.home).sort()).toEqual([".dispatch"]);
    const launcher = join(h.dispatchHome, "bin", launcherFileName());
    // Windows: mode bits do not reflect ACLs.
    if (process.platform !== "win32") {
      expect(statSync(launcher).mode & 0o777).toBe(0o755);
    }
    expect(readFileSync(launcher, "utf8")).toContain('exec "/opt/node/bin/node"');
  });

  it("the preview lists every file and trust grant before anything is written", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    const plan = await planSetup(ctx([fakeCodexHost(), fakeClaudeHost()]));
    expect(plan.preview).toContain("Trust grants");
    expect(plan.preview).toContain(
      `${join(h.home, ".codex", "rules", "dispatch.rules")}: ${CODEX_RULES_GRANT}`,
    );
    expect(plan.preview).toContain("installs the Dispatch plugin");
    expect(plan.preview).toContain(
      `add an entry to "hooks.SessionStart" in ${join(h.home, ".codex", "hooks.json")}`,
    );
    expect(plan.preview).toContain("run claude plugin install dispatch@dispatch-local -s user");
    expect(plan.preview).toContain(
      join(h.dispatchHome, "hosts", "claude-code", "plugins", "dispatch", "agents", "dispatch.md"),
    );
    expect(plan.preview).toMatch(/Hosts detected: codex, claude-code/);
    // Nothing written yet.
    expect(readdirSync(h.home)).toEqual([".codex"]);
    const declined = await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: async () => false,
    });
    expect(declined.confirmed).toBe(false);
    expect(readdirSync(h.home)).toEqual([".codex"]);
  });

  it("setup then uninstall --global leaves host files byte-identical [UC14][AC2]", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    mkdirSync(join(h.home, ".claude"));
    const hooks = join(h.home, ".codex", "hooks.json");
    const settings = join(h.home, ".claude", "settings.json");
    writeFileSync(hooks, JSONC);
    writeFileSync(settings, '{\n  "model": "opus"\n}\n');
    const runner = fakeClaudeRunner(h.home);
    const hosts = [fakeCodexHost(), fakeClaudeHost()];

    let seen = "";
    const plan = await planSetup(ctx(hosts));
    const summary = await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      runner,
      confirm: async (preview) => {
        seen = preview;
        return true;
      },
    });
    expect(seen).toBe(plan.preview);
    expect(summary.applied).toHaveLength(plan.ops.length);
    const rendered = readFileSync(hooks, "utf8");
    expect(rendered).toContain("// mine");
    expect(
      JSON.parse(
        readFileSync(
          join(
            h.dispatchHome,
            "hosts",
            "claude-code",
            "plugins",
            "dispatch",
            "hooks",
            "hooks.json",
          ),
          "utf8",
        ),
      ).hooks.SessionStart[0].hooks[0].command,
    ).toContain("'/opt/d/hook.mjs' claude-code SessionStart");
    expect(
      readFileSync(join(h.home, ".agents", "skills", "dispatch", "SKILL.md"), "utf8"),
    ).toContain(
      `${join(h.dispatchHome, "bin", launcherFileName())} wait <runId> --json --timeout 280`,
    );
    const manifest = readManifest(h.dispatchHome);
    expect(manifest.entries).toHaveLength(plan.ops.length);
    expect(manifest.entries.find((e) => e.kind === "rules-file")?.trustGrant).toBe(
      CODEX_RULES_GRANT,
    );
    // Windows: mode bits do not reflect ACLs.
    if (process.platform !== "win32") {
      expect(statSync(manifestPath(h.dispatchHome)).mode & 0o777).toBe(0o600);
    }

    // Idempotent re-run.
    const again = await applySetup(await planSetup(ctx(hosts)), {
      dispatchHome: h.dispatchHome,
      runner,
      confirm: true,
    });
    expect(again.applied).toEqual([]);
    expect(readFileSync(hooks, "utf8")).toBe(rendered);
    expect(runner.calls).toHaveLength(2);

    const un = await uninstallGlobal({ dispatchHome: h.dispatchHome, runner });
    expect(un.warnings).toEqual([]);
    expect(un.homeRemoved).toBe(true);
    expect(readFileSync(hooks, "utf8")).toBe(JSONC);
    expect(readFileSync(settings, "utf8")).toBe('{\n  "model": "opus"\n}\n');
    expect(existsSync(h.dispatchHome)).toBe(false);
    expect(existsSync(join(h.home, ".agents"))).toBe(false);
    expect(readdirSync(join(h.home, ".codex"))).toEqual(["hooks.json"]);
    expect(readdirSync(join(h.home, ".claude"))).toEqual(["settings.json"]);
  });

  it("--keep-home keeps ~/.dispatch but removes the launcher and manifest", async () => {
    h = tempHome();
    mkdirSync(h.dispatchHome);
    writeFileSync(join(h.dispatchHome, "config.yaml"), "version: 1\n");
    await applySetup(await planSetup(ctx([])), { dispatchHome: h.dispatchHome, confirm: true });
    const un = await uninstallGlobal({ dispatchHome: h.dispatchHome, keepDispatchHome: true });
    expect(un.homeRemoved).toBe(false);
    expect(readdirSync(h.dispatchHome)).toEqual(["config.yaml"]);
  });

  it("user-edited entries are kept with a warning; failures keep the home for a retry", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    await applySetup(await planSetup(ctx([fakeCodexHost()])), {
      dispatchHome: h.dispatchHome,
      confirm: true,
    });
    const rules = join(h.home, ".codex", "rules", "dispatch.rules");
    writeFileSync(rules, "# my own tweak\n");
    const hooks = join(h.home, ".codex", "hooks.json");
    writeFileSync(hooks, `${readFileSync(hooks, "utf8")}garbage`);
    const un = await uninstallGlobal({ dispatchHome: h.dispatchHome });
    expect(un.warnings.some((w) => w.includes(rules) && /by hand/.test(w))).toBe(true);
    expect(un.warnings.some((w) => w.includes(hooks) && /could not undo/.test(w))).toBe(true);
    expect(un.homeRemoved).toBe(false);
    expect(readFileSync(rules, "utf8")).toBe("# my own tweak\n");
    expect(readManifest(h.dispatchHome).entries.map((e) => e.kind)).toEqual([
      "json-entry",
      "json-entry",
    ]);
  });

  it("--refresh removes edits that are no longer planned", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    await applySetup(await planSetup(ctx([fakeCodexHost()])), {
      dispatchHome: h.dispatchHome,
      confirm: true,
    });
    const plan = await planSetup(ctx([]));
    expect(plan.stale).toHaveLength(4);
    expect(plan.preview).toContain("remove the earlier Dispatch edit");
    const kept = await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true });
    expect(kept.removed).toEqual([]);
    const r = await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      refresh: true,
    });
    expect(r.removed).toHaveLength(4);
    expect(readdirSync(join(h.home, ".codex"))).toEqual([]);
    expect(readManifest(h.dispatchHome).entries.map((e) => e.signature)).toEqual([
      "dispatch-launcher",
    ]);
  });

  it("a corrupt manifest is a clear error", async () => {
    h = tempHome();
    mkdirSync(h.dispatchHome);
    writeFileSync(manifestPath(h.dispatchHome), "{nope");
    expect(() => readManifest(h.dispatchHome)).toThrow(/setup manifest .* unreadable/);
    writeManifest(h.dispatchHome, { version: 1, updatedAt: "", entries: [] });
    expect(readManifest(h.dispatchHome).entries).toEqual([]);
  });
});

describe("render helpers", () => {
  it("renderTemplate escapes for JSON and rejects unknown placeholders", () => {
    expect(renderTemplate('{"c": "{{A}}"}', { A: 'say "hi"' }, true)).toBe('{"c": "say \\"hi\\""}');
    expect(renderTemplate("run {{A}}", { A: 'say "hi"' }, false)).toBe('run say "hi"');
    expect(() => renderTemplate("{{NOPE}}", {}, false)).toThrow(/NOPE/);
  });

  it("assetOps defaults to new-file 0644 with a matching sha256", () => {
    h = tempHome();
    mkdirSync(join(h.home, "t"));
    writeFileSync(join(h.home, "t", "a.md"), "L={{LAUNCHER}}");
    const values = {
      LAUNCHER: "/x/dispatch",
      WAIT_TIMEOUT: "1",
      VERSION: "0",
      HOOK_COMMAND_SESSION_START: "",
      HOOK_COMMAND_PRE_TOOL_USE: "",
      NODE_PATH: "/n/node",
      HOOK_PATH: "/n/hook.mjs",
    };
    const [op] = assetOps(values, [{ template: "a.md", dest: "/d/a.md" }], join(h.home, "t"));
    expect(op).toMatchObject({
      kind: "new-file",
      mode: "0644",
      content: "L=/x/dispatch",
      trustGrant: null,
    });
  });

  it("hostPresent: config dir or resolvable binary [UC1]", () => {
    h = tempHome();
    const none = { isExecutableFile: () => false, realpath: (p: string) => p };
    const all = { isExecutableFile: () => true, realpath: (p: string) => p };
    const base = { home: h.home, binary: "codex", dir: ".codex", env: { PATH: "/bin" } };
    expect(hostPresent({ ...base, fs: none })).toBe(false);
    expect(hostPresent({ ...base, fs: all })).toBe(true);
    mkdirSync(join(h.home, ".codex"));
    expect(hostPresent({ ...base, fs: none })).toBe(true);
    expect(typeof hostPresent({ ...base, dir: ".nope-x", env: {} })).toBe("boolean");
  });
});

describe("registry and doctor checks", () => {
  it("registers hosts and runs checks, turning crashes into fail", async () => {
    h = tempHome();
    const reg = new HostRegistry();
    const codex = fakeCodexHost();
    reg.registerHost(codex);
    reg.registerHost(codex);
    expect(reg.hosts()).toEqual([codex]);
    expect(reg.getHost("codex")).toBe(codex);
    reg.registerDoctorCheck(manifestCheck);
    reg.registerDoctorCheck({
      id: "boom",
      run: () => {
        throw new Error("x");
      },
    });
    expect(() => reg.registerDoctorCheck(manifestCheck)).toThrow(/already registered/);
    expect(reg.doctorChecks().map((c) => c.id)).toEqual(["setup.manifest", "boom"]);
    const dctx = { home: h.home, dispatchHome: h.dispatchHome, env: {} };
    expect(await reg.runDoctorChecks(dctx)).toEqual([
      { id: "setup.manifest", status: "warn", message: "setup has not run", fix: "dispatch setup" },
      { id: "boom", status: "fail", message: "check crashed: x" },
    ]);
    await applySetup(await planSetup(ctx([])), { dispatchHome: h.dispatchHome, confirm: true });
    expect((await manifestCheck.run(dctx)).status).toBe("ok");
    writeFileSync(join(h.dispatchHome, "bin", launcherFileName()), "tampered");
    expect(await manifestCheck.run(dctx)).toMatchObject({
      status: "warn",
      fix: "dispatch setup --refresh",
    });
  });
});
