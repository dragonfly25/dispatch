import { describe, expect, it } from "vitest";
import {
  envGet,
  envKey,
  homeDir,
  isOwnerOnly,
  isWindows,
  launcherFileName,
  WINDOWS_BASE_ENV,
} from "../../../src/platform/os.js";

describe("isWindows", () => {
  it("is true only for win32", () => {
    expect(isWindows("win32")).toBe(true);
    expect(isWindows("linux")).toBe(false);
    expect(isWindows("darwin")).toBe(false);
  });
  it("defaults to the running platform", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("envGet", () => {
  it("reads exact names and treats empty as unset", () => {
    expect(envGet({ PATH: "/bin" }, "PATH", "linux")).toBe("/bin");
    expect(envGet({ PATH: "" }, "PATH", "linux")).toBeUndefined();
  });
  it("is case-sensitive on POSIX", () => {
    expect(envGet({ Path: "/bin" }, "PATH", "linux")).toBeUndefined();
  });
  it("is case-insensitive on win32 and skips empty matches", () => {
    expect(envGet({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin");
    expect(envGet({ path: "", Path: "C:\\x" }, "PATH", "win32")).toBe("C:\\x");
    expect(envGet({ Other: "1" }, "PATH", "win32")).toBeUndefined();
  });
});

describe("envKey", () => {
  it("returns the name as given on POSIX or when present", () => {
    expect(envKey({ Path: "x" }, "PATH", "linux")).toBe("PATH");
    expect(envKey({ PATH: "x" }, "PATH", "win32")).toBe("PATH");
  });
  it("returns the existing spelling on win32", () => {
    expect(envKey({ Path: "x" }, "PATH", "win32")).toBe("Path");
    expect(envKey({}, "PATH", "win32")).toBe("PATH");
  });
});

describe("homeDir", () => {
  it("uses HOME on POSIX only", () => {
    expect(homeDir({ HOME: "/home/me" }, "linux")).toBe("/home/me");
    expect(homeDir({ USERPROFILE: "C:\\Users\\me" }, "linux")).toBeUndefined();
  });
  it("prefers HOME, then USERPROFILE, then HOMEDRIVE+HOMEPATH on win32", () => {
    expect(homeDir({ HOME: "C:\\h", USERPROFILE: "C:\\Users\\me" }, "win32")).toBe("C:\\h");
    expect(homeDir({ USERPROFILE: "C:\\Users\\me" }, "win32")).toBe("C:\\Users\\me");
    expect(homeDir({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\me" }, "win32")).toBe("D:\\Users\\me");
    expect(homeDir({ HOMEDRIVE: "D:" }, "win32")).toBeUndefined();
  });
});

describe("isOwnerOnly", () => {
  it("requires the same uid and no group/other bits on POSIX", () => {
    expect(isOwnerOnly({ uid: 501, mode: 0o100600 }, "linux", 501)).toBe(true);
    expect(isOwnerOnly({ uid: 501, mode: 0o100640 }, "linux", 501)).toBe(false);
    expect(isOwnerOnly({ uid: 0, mode: 0o100600 }, "linux", 501)).toBe(false);
  });
  it("passes on win32, where mode bits do not reflect ACLs", () => {
    expect(isOwnerOnly({ uid: 0, mode: 0o100666 }, "win32", undefined)).toBe(true);
  });
  it("defaults to the running process", () => {
    const st = { uid: process.getuid?.() ?? 0, mode: 0o100600 };
    expect(isOwnerOnly(st)).toBe(true);
  });
});

describe("launcherFileName and WINDOWS_BASE_ENV", () => {
  it("names the launcher per platform", () => {
    expect(launcherFileName("darwin")).toBe("dispatch");
    expect(launcherFileName("win32")).toBe("dispatch.cmd");
    expect(launcherFileName()).toBe(process.platform === "win32" ? "dispatch.cmd" : "dispatch");
  });
  it("lists only upper-case, secret-free system variables", () => {
    for (const name of WINDOWS_BASE_ENV) {
      expect(name).toBe(name.toUpperCase());
      expect(name).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/);
    }
    expect(WINDOWS_BASE_ENV).toContain("SYSTEMROOT");
    expect(WINDOWS_BASE_ENV).toContain("USERPROFILE");
  });
});
