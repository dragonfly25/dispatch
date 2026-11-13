import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetsDir,
  dispatchHome,
  globalConfigPath,
  packageRoot,
  repoPaths,
} from "../../../src/config/paths.js";
import {
  GlobalConfigFileSchema,
  migrate,
  RepoConfigFileSchema,
} from "../../../src/config/schema.js";

describe("paths", () => {
  it("DISPATCH_HOME wins over HOME; neither is a usage error", () => {
    // Native separators: `\h\.dispatch` on Windows.
    expect(dispatchHome({ HOME: "/h" })).toBe(join("/h", ".dispatch"));
    expect(dispatchHome({ HOME: "/h", DISPATCH_HOME: "/d" })).toBe("/d");
    expect(globalConfigPath({ DISPATCH_HOME: "/d" })).toBe(join("/d", "config.yaml"));
    expect(() => dispatchHome({})).toThrow(/HOME/);
  });

  it("repo paths live under .dispatch/", () => {
    expect(repoPaths("/r")).toEqual({
      dir: join("/r", ".dispatch"),
      config: join("/r", ".dispatch", "config.yaml"),
      profiles: join("/r", ".dispatch", "profiles"),
      mappings: join("/r", ".dispatch", "mappings"),
    });
  });

  it("finds the package root from src/ and from dist/, and fails outside it", () => {
    const root = packageRoot();
    expect(packageRoot(join(root, "dist"))).toBe(root);
    expect(assetsDir()).toBe(join(root, "assets"));
    expect(() => packageRoot("/")).toThrow(/package root/);
  });
});

describe("versions and migrations", () => {
  it("an empty file is version 1", () => {
    expect(migrate(null, "f")).toEqual({ version: 1 });
  });

  it.each([
    [{}, /missing "version:"/],
    [{ version: "1" }, /unknown config version "1"/],
    [{ version: 0 }, /unknown config version 0/],
    [{ version: 2 }, /version 2 is newer than this Dispatch supports \(1\)/],
    [[1], /expected a YAML mapping/],
    ["text", /expected a YAML mapping/],
  ])("%j → clear error", (raw, re) => {
    expect(() => migrate(raw, "f.yaml")).toThrow(re);
  });

  it("runs the migration chain up to the current version", () => {
    const up = migrate({ version: 1, a: 1 }, "f", { 1: (d) => ({ ...d, b: 2 }) }, 2);
    expect(up).toEqual({ version: 2, a: 1, b: 2 });
    expect(() => migrate({ version: 1 }, "f", {}, 2)).toThrow(/no migration from version 1/);
  });
});

describe("file schemas", () => {
  it("are strict and documented", () => {
    expect(() => GlobalConfigFileSchema.parse({ version: 1, colour: "red" })).toThrow();
    // Repo config may not redefine an instance's identity (adapter, pool, config dir).
    expect(() =>
      RepoConfigFileSchema.parse({ version: 1, providers: { codex: { pool: "api_credit" } } }),
    ).toThrow();
    expect(GlobalConfigFileSchema.shape.autonomy.description).toMatch(/^SECURITY/);
    expect(GlobalConfigFileSchema.shape.trusted_repos.description).toMatch(/dispatch trust/);
  });
});
