import { describe, expect, it } from "vitest";
import { buildChildEnv, isDeniedEnvName } from "../../src/runner/env.js";

const parentEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
  USER: "u",
  LOGNAME: "u",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_TIME: "de_DE",
  TMPDIR: "/tmp/x",
  SHELL: "/bin/zsh",
  TERM: "xterm-256color",
  CANARY_SECRET: "canary-secret-value",
  ANTHROPIC_API_KEY: "sk-ant-api03-canary",
  OPENAI_API_KEY: "sk-openai-canary",
  GITHUB_TOKEN: "ghp_canarycanary",
  NODE_OPTIONS: "--require /evil.js",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CODEX_THREAD_ID: "thread-123",
  ANTIGRAVITY_SESSION: "ag-1",
  DISPATCH_DEPTH: "0",
  UNSET: undefined,
} as const;

describe("buildChildEnv [SEC-env]", () => {
  it("[SEC-env] forwards only the base allow-list, TERM=dumb and DISPATCH_*", () => {
    const { env } = buildChildEnv({ parentEnv, passthrough: [], extra: {}, depth: 0, runId: "r1" });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      USER: "u",
      LOGNAME: "u",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_TIME: "de_DE",
      TMPDIR: "/tmp/x",
      SHELL: "/bin/zsh",
      TERM: "dumb",
      DISPATCH_DEPTH: "1",
      DISPATCH_RUN_ID: "r1",
    });
  });

  it("[UC13] DISPATCH_DEPTH is depth+1 and cannot be overridden by the parent or by extra", () => {
    const { env } = buildChildEnv({
      parentEnv: { DISPATCH_DEPTH: "0" },
      passthrough: ["DISPATCH_DEPTH"],
      extra: { DISPATCH_DEPTH: "0", DISPATCH_RUN_ID: "from-extra" },
      depth: 3,
      runId: "r2",
    });
    expect(env.DISPATCH_DEPTH).toBe("4");
    expect(env.DISPATCH_RUN_ID).toBe("r2");
  });

  it("omits DISPATCH_RUN_ID when no run id is given", () => {
    const { env } = buildChildEnv({ parentEnv: {}, passthrough: [], extra: {}, depth: 0 });
    expect(env).toEqual({ TERM: "dumb", DISPATCH_DEPTH: "1" });
  });

  it("forwards passthrough and allow names (exact and PREFIX*) when present in the parent", () => {
    const { env } = buildChildEnv({
      parentEnv: { MY_VAR: "a", MY_OTHER: "b", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c", Z: "z" },
      allow: ["XDG_*"],
      passthrough: ["MY_VAR", "ABSENT"],
      extra: {},
      depth: 0,
    });
    expect(env).toMatchObject({ MY_VAR: "a", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" });
    expect(env).not.toHaveProperty("MY_OTHER");
    expect(env).not.toHaveProperty("Z");
    expect(env).not.toHaveProperty("ABSENT");
  });

  it("[SEC-env] never forwards denied names even when listed in passthrough or allow", () => {
    const denied = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CODEX_THREAD_ID",
      "ANTIGRAVITY_SESSION",
    ];
    const { env } = buildChildEnv({
      parentEnv,
      allow: ["CLAUDE_CODE_*", "CODEX_*"],
      passthrough: denied,
      extra: {},
      depth: 0,
    });
    for (const name of denied) expect(env).not.toHaveProperty(name);
  });

  it("[SEC-env] the deny-list is case-insensitive and catches any *TOKEN* / *_API_KEY name", () => {
    for (const name of [
      "my_api_key",
      "Github_Token",
      "AWS_SESSION_TOKEN",
      "TOKEN_FILE",
      "node_options",
      "codex_home",
      "claudecode_x",
    ]) {
      expect(isDeniedEnvName(name)).toBe(true);
    }
    for (const name of ["PATH", "CLAUDE_CONFIG_DIR", "MY_VAR", "API_KEYBOARD", "DISPATCH_DEPTH"]) {
      expect(isDeniedEnvName(name)).toBe(false);
    }
  });

  it("dangerouslyAllow is the only way a denied name gets through", () => {
    const { env } = buildChildEnv({
      parentEnv,
      passthrough: ["OPENAI_API_KEY"],
      dangerouslyAllow: ["ANTHROPIC_API_KEY"],
      extra: {},
      depth: 0,
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-canary");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("extra values are trusted (e.g. a provider config-dir variable) and may be denied-looking names", () => {
    const { env } = buildChildEnv({
      parentEnv: {},
      passthrough: [],
      extra: { CODEX_HOME: "/tmp/codex-home", TERM: "xterm" },
      depth: 0,
    });
    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.TERM).toBe("xterm");
  });

  it("returns the values of every parent variable that was not forwarded as secrets", () => {
    const { secrets } = buildChildEnv({ parentEnv, passthrough: [], extra: {}, depth: 0 });
    expect(secrets).toEqual(
      expect.arrayContaining([
        "canary-secret-value",
        "sk-ant-api03-canary",
        "sk-openai-canary",
        "ghp_canarycanary",
        "--require /evil.js",
        "thread-123",
      ]),
    );
    // Forwarded values and TERM (replaced by "dumb", not forwarded) behave as documented.
    expect(secrets).not.toContain("/usr/bin:/bin");
    expect(secrets).toContain("xterm-256color");
  });

  it("does not list forwarded values, empty values or duplicates as secrets", () => {
    const { secrets, env } = buildChildEnv({
      parentEnv: { A: "dup-value", B: "dup-value", C: "", D: "shared", MY_VAR: "shared" },
      passthrough: ["MY_VAR"],
      extra: {},
      depth: 0,
    });
    expect(env.MY_VAR).toBe("shared");
    expect(secrets).toEqual(["dup-value"]);
  });

  it("does not list a dangerouslyAllow value as a secret", () => {
    const { secrets } = buildChildEnv({
      parentEnv: { GITHUB_TOKEN: "ghp_x1234" },
      passthrough: [],
      dangerouslyAllow: ["GITHUB_TOKEN"],
      extra: {},
      depth: 0,
    });
    expect(secrets).toEqual([]);
  });
});
