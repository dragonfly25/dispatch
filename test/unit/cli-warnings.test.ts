import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  installWarningFilter,
  isSqliteExperimentalWarning,
  type WarningTarget,
} from "../../src/cli/warnings.js";
import { sandbox } from "./config/helpers.js";

class Fake {
  pid = 42;
  env: Record<string, string | undefined> = {};
  execArgv: string[] = [];
  written = "";
  listeners: ((w: Error & { code?: string }) => void)[] = [];
  removed = 0;
  stderr = {
    write: (t: string) => {
      this.written += t;
    },
  };
  removeAllListeners(): void {
    this.removed++;
  }
  on(_e: "warning", l: (w: Error & { code?: string }) => void): void {
    this.listeners.push(l);
  }
  emit(name: string, message: string, code?: string): void {
    const w: Error & { code?: string } = Object.assign(new Error(message), { name });
    if (code) w.code = code;
    for (const l of this.listeners) l(w);
  }
}
const asTarget = (f: Fake) => f as unknown as WarningTarget;

describe("installWarningFilter", () => {
  it("drops only the SQLite ExperimentalWarning; everything else prints once with the hint", () => {
    const f = new Fake();
    installWarningFilter(asTarget(f));
    expect(f.removed).toBe(1);

    f.emit("ExperimentalWarning", "SQLite is an experimental feature and might change at any time");
    expect(f.written).toBe("");

    f.emit("ExperimentalWarning", "Something else is experimental");
    f.emit("DeprecationWarning", "old api", "DEP0001");
    expect(f.written).toBe(
      "(node:42) ExperimentalWarning: Something else is experimental\n" +
        "(Use `node --trace-warnings ...` to show where the warning was created)\n" +
        "(node:42) [DEP0001] DeprecationWarning: old api\n",
    );
  });

  it("leaves Node's own listener alone when warnings are disabled", () => {
    for (const mutate of [
      (f: Fake) => {
        f.env.NODE_NO_WARNINGS = "1";
      },
      (f: Fake) => {
        f.execArgv = ["--no-warnings"];
      },
    ]) {
      const f = new Fake();
      mutate(f);
      installWarningFilter(asTarget(f));
      expect(f.removed).toBe(0);
      expect(f.listeners).toEqual([]);
    }
  });

  it("recognizes the warning by name and message", () => {
    const w = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(isSqliteExperimentalWarning(w("ExperimentalWarning", "SQLite is experimental"))).toBe(
      true,
    );
    expect(isSqliteExperimentalWarning(w("Warning", "SQLite is experimental"))).toBe(false);
    expect(isSqliteExperimentalWarning(w("ExperimentalWarning", "fetch"))).toBe(false);
  });
});

describe("the built CLI", () => {
  beforeAll(() => {
    // Rebuild so the test never judges a stale bundle (tsup does not clean dist/).
    execFileSync("pnpm", ["exec", "tsup"], { cwd: process.cwd(), stdio: "ignore" });
  }, 60_000);

  it("explain prints no ExperimentalWarning on stderr, although it opens the SQLite store", () => {
    const sb = sandbox();
    const r = spawnSync(
      process.execPath,
      [join(process.cwd(), "dist", "cli.mjs"), "explain", "--task", "hello"],
      {
        cwd: sb.root,
        encoding: "utf8",
        // An empty PATH: the default quota readers must not find any real CLI.
        env: { PATH: sb.root, HOME: sb.home, DISPATCH_HOME: sb.dispatchHome },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Dispatch explain");
    expect(r.stderr).not.toMatch(/ExperimentalWarning/);
    expect(r.stderr).toBe("");
  });
});
