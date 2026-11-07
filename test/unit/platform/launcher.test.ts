import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchError } from "../../../src/core/errors.js";
import {
  currentInstallPaths,
  renderHookCommand,
  renderLauncherScript,
} from "../../../src/platform/launcher.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-launcher-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("renderLauncherScript [UC1]", () => {
  it("renders the exact exec line", () => {
    expect(
      renderLauncherScript({ nodePath: "/opt/node/bin/node", cliPath: "/x/dist/cli.mjs" }),
    ).toBe(
      '#!/bin/sh\nexec "/opt/node/bin/node" --disable-warning=ExperimentalWarning "/x/dist/cli.mjs" "$@"\n',
    );
  });

  it("keeps spaces and single quotes intact (safe inside double quotes)", () => {
    const script = renderLauncherScript({
      nodePath: "/Users/o'neil/my node/bin/node",
      cliPath: "/Users/o'neil/cli.mjs",
    });
    expect(script).toContain('exec "/Users/o\'neil/my node/bin/node" ');
  });

  it.each(['a"b', "a$b", "a`b", "a\nb", "a\\b", "a\0b", "a\rb"])(
    "[SEC-hookpath] rejects shell-special path %j",
    (bad) => {
      expect(() => renderLauncherScript({ nodePath: `/n/${bad}`, cliPath: "/c/cli.mjs" })).toThrow(
        DispatchError,
      );
      expect(() => renderLauncherScript({ nodePath: "/n/node", cliPath: `/c/${bad}` })).toThrow(
        DispatchError,
      );
    },
  );

  it("rejects relative paths", () => {
    expect(() => renderLauncherScript({ nodePath: "node", cliPath: "/c/cli.mjs" })).toThrow(
      /absolute/,
    );
  });

  it("the rendered launcher actually runs node with the cli and forwards args", () => {
    const cli = join(root, "cli.mjs");
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = join(root, "dispatch");
    writeFileSync(launcher, renderLauncherScript({ nodePath: process.execPath, cliPath: cli }));
    chmodSync(launcher, 0o755);
    const r = spawnSync(launcher, ["run", "a b", "$HOME"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["run", "a b", "$HOME"]);
  });
});

describe("renderHookCommand [UC9][AC5]", () => {
  const args = {
    nodePath: "/abs/node",
    hookPath: "/abs/hook.mjs",
    host: "claude",
    event: "SessionStart",
  };

  it("renders exactly the planned command", () => {
    expect(renderHookCommand(args)).toBe(
      `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x '/abs/node' ] && [ -f '/abs/hook.mjs' ] || exit 0; exec '/abs/node' '/abs/hook.mjs' claude SessionStart`,
    );
  });

  it("[SEC-hookpath] single-quotes paths, escaping embedded quotes", () => {
    const cmd = renderHookCommand({ ...args, hookPath: "/a b/it's/hook.mjs" });
    expect(cmd).toContain(`'/a b/it'\\''s/hook.mjs'`);
  });

  it.each(["x;touch pwned", "x$(touch pwned)", "x`touch pwned`", 'x"; touch pwned; "'])(
    "[SEC-hookpath] metacharacters in path %s cannot escape the quotes",
    (name) => {
      const dir = join(root, "inj");
      mkdirSync(dir);
      const cmd = renderHookCommand({
        ...args,
        nodePath: process.execPath,
        hookPath: join(dir, name),
      });
      const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
    },
  );

  it("rejects relative paths, newlines and unsafe host/event tokens", () => {
    expect(() => renderHookCommand({ ...args, nodePath: "node" })).toThrow(/absolute/);
    expect(() => renderHookCommand({ ...args, hookPath: "hook.mjs" })).toThrow(/absolute/);
    expect(() => renderHookCommand({ ...args, hookPath: "/a\nb" })).toThrow(/newline/);
    for (const bad of ["", "a b", "a;b", "$x", "-x", "a'b"]) {
      expect(() => renderHookCommand({ ...args, host: bad })).toThrow(DispatchError);
      expect(() => renderHookCommand({ ...args, event: bad })).toThrow(DispatchError);
    }
  });

  describe("behaviour under `env -i PATH=/usr/bin:/bin` (GUI host)", () => {
    const run = (cmd: string, extra: string[] = []) =>
      spawnSync("/usr/bin/env", ["-i", "PATH=/usr/bin:/bin", ...extra, "sh", "-c", cmd], {
        encoding: "utf8",
      });

    function fakeHook(dir: string): { hook: string; marker: string } {
      mkdirSync(dir, { recursive: true });
      const hook = join(dir, "hook.mjs");
      const marker = join(dir, "marker.json");
      writeFileSync(
        hook,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
      );
      return { hook, marker };
    }

    it("[UC9][AC5] is silent with exit 0 when node and the hook are missing", () => {
      const cmd = renderHookCommand({
        ...args,
        nodePath: join(root, "no-node"),
        hookPath: join(root, "no-hook.mjs"),
      });
      expect(run(cmd)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    });

    it("[UC9][AC5] is silent when only the hook is missing, or only node is missing", () => {
      const { hook } = fakeHook(join(root, "h"));
      const missingHook = renderHookCommand({
        ...args,
        nodePath: process.execPath,
        hookPath: join(root, "h", "other.mjs"),
      });
      const missingNode = renderHookCommand({
        ...args,
        nodePath: join(root, "no-node"),
        hookPath: hook,
      });
      for (const cmd of [missingHook, missingNode]) {
        expect(run(cmd)).toMatchObject({ status: 0, stdout: "", stderr: "" });
      }
    });

    it("[UC9] executes node with the hook, host and event when present (paths with quotes)", () => {
      const { hook, marker } = fakeHook(join(root, "it's here"));
      const cmd = renderHookCommand({ ...args, nodePath: process.execPath, hookPath: hook });
      expect(run(cmd).status).toBe(0);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["claude", "SessionStart"]);
    });

    it("[UC9] does nothing when DISPATCH_DEPTH is set (Dispatch child)", () => {
      const { hook, marker } = fakeHook(join(root, "d"));
      const cmd = renderHookCommand({ ...args, nodePath: process.execPath, hookPath: hook });
      expect(run(cmd, ["DISPATCH_DEPTH=1"])).toMatchObject({ status: 0, stdout: "", stderr: "" });
      expect(existsSync(marker)).toBe(false);
    });

    it("propagates the hook's exit code (exec)", () => {
      mkdirSync(join(root, "e"));
      const hook = join(root, "e", "hook.mjs");
      writeFileSync(hook, "process.exit(7);\n");
      const cmd = renderHookCommand({ ...args, nodePath: process.execPath, hookPath: hook });
      expect(run(cmd).status).toBe(7);
    });
  });
});

describe("currentInstallPaths", () => {
  it("derives cli and hook paths next to the given module and uses execPath for node", () => {
    const url = pathToFileURL("/opt/dispatch/dist/cli.mjs").href;
    expect(currentInstallPaths({ moduleUrl: url, execPath: "/n/node" })).toEqual({
      nodePath: "/n/node",
      cliPath: "/opt/dispatch/dist/cli.mjs",
      hookPath: "/opt/dispatch/dist/hook.mjs",
    });
  });

  it("defaults to the running node and this module's directory", () => {
    const p = currentInstallPaths();
    expect(p.nodePath).toBe(process.execPath);
    expect(p.cliPath.endsWith("/cli.mjs")).toBe(true);
    expect(p.hookPath.endsWith("/hook.mjs")).toBe(true);
  });
});
