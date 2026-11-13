/** Windows rules of the hook cache (injected platform). */
import { describe, expect, it } from "vitest";
import { type HookCache, hookDispatchHome, trustedRepoFor } from "../../../src/hook/cache.js";

const cache: HookCache = {
  version: 1,
  writtenAt: "2026-11-07T00:00:00.000Z",
  trustedRepos: [
    { root: "C:\\Work\\Repo", policyHash: "abc" },
    { root: "C:\\Work\\Repo\\sub", policyHash: null },
  ],
  policy: { profile: "balance", hardMode: false, summary: "s" },
};

describe("hook cache on Windows", () => {
  it("matches a trusted root ignoring case and separators, never a shared prefix", () => {
    expect(trustedRepoFor(cache, "c:/work/repo/SUB/x", "win32")?.root).toBe("C:\\Work\\Repo\\sub");
    expect(trustedRepoFor(cache, "c:\\work\\repo", "win32")?.root).toBe("C:\\Work\\Repo");
    expect(trustedRepoFor(cache, "C:\\Work\\Repository", "win32")).toBeNull();
    expect(trustedRepoFor(cache, "c:\\work\\repo", "linux")).toBeNull();
  });

  it("locates the Dispatch home through USERPROFILE", () => {
    expect(hookDispatchHome({ USERPROFILE: "C:\\Users\\me" }, "win32")).toBe(
      "C:\\Users\\me\\.dispatch",
    );
    expect(hookDispatchHome({ Dispatch_Home: "D:\\d" }, "win32")).toBe("D:\\d");
    expect(hookDispatchHome({ USERPROFILE: "C:\\Users\\me" }, "linux")).toBeNull();
  });
});
