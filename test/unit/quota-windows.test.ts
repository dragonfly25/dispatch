/** Windows rules of the quota readers' child env (injected platform). */
import { describe, expect, it } from "vitest";
import type { ProviderInstance, SpawnRequest } from "../../src/core/contracts.js";
import { ClaudeUsageReader } from "../../src/quota/readers/claude-usage.js";
import { buildReaderEnv, readerEnvAllowed } from "../../src/quota/readers/env.js";
import { FakeClock } from "../stubs/index.js";

const inst: ProviderInstance = { id: "c", adapter: "claude", pool: "subscription" };

describe("reader env on Windows", () => {
  it("keeps the Windows base variables, matched without case, in the parent's spelling", () => {
    const env = buildReaderEnv(
      {
        Path: "C:\\bin",
        PATH: "dup",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\me",
        lc_all: "C",
        OPENAI_API_KEY: "secret",
        APPDATA: undefined,
      },
      inst,
      "CODEX_HOME",
      "win32",
    );
    expect(env).toEqual({
      Path: "C:\\bin",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      lc_all: "C",
      TERM: "dumb",
    });
  });

  it("POSIX is unchanged: exact names, no Windows variables", () => {
    expect(readerEnvAllowed("SystemRoot", "linux")).toBe(false);
    expect(readerEnvAllowed("Path", "linux")).toBe(false);
    expect(readerEnvAllowed("LC_ALL", "linux")).toBe(true);
    expect(readerEnvAllowed("SYSTEMROOT", "win32")).toBe(true);
  });

  it("claude reader expands ~\\ in config_dir against USERPROFILE", async () => {
    const seen: SpawnRequest[] = [];
    const reader = new ClaudeUsageReader({
      spawner: {
        spawn: async (req) => {
          seen.push(req);
          return { exitCode: 1, signal: null, timedOut: false };
        },
      },
      clock: new FakeClock(new Date("2026-11-07T12:00:00Z")),
      env: { USERPROFILE: "C:\\Users\\me" },
      llmFallback: false,
      platform: "win32",
    });
    await reader.read({ ...inst, configDir: "~\\.claude-alt" }).catch(() => {});
    await reader.read({ ...inst, configDir: "relative" }).catch(() => {});
    expect(seen[0]?.env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\me\\.claude-alt");
    expect(seen[1]?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
