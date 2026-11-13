/** Windows rules of the config layer, exercised on any OS with an injected platform / fs. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandTilde,
  isPathInside,
  pathApi,
  pathKey,
  relativeToHome,
  samePathKey,
} from "../../../src/config/pathkey.js";
import { dispatchHome, globalConfigPath, homeVarsText } from "../../../src/config/paths.js";
import {
  checkTrust,
  type FileIdentity,
  findRepo,
  type NoFollowFs,
  readNoFollow,
  readPolicySet,
  trustedEntry,
} from "../../../src/config/trust.js";
import { sandbox, tempDir, writeFiles } from "./helpers.js";

const W = "win32" as const;
const P = "linux" as const;

describe("pathkey", () => {
  it("keys are exact on POSIX and case/separator-insensitive on Windows", () => {
    expect(pathKey("/A/b/", P)).toBe("/A/b/");
    expect(pathKey("C:/Users/Me/", W)).toBe("c:\\users\\me");
    expect(pathKey("C:\\", W)).toBe("c:\\");
    expect(pathKey("c:/", W)).toBe("c:\\");
    expect(samePathKey("C:/Users/Me/repo", "c:\\users\\me\\REPO\\", W)).toBe(true);
    expect(samePathKey("/a/B", "/a/b", P)).toBe(false);
    expect(pathApi(W)).toBe(win32);
    expect(pathApi(P).sep).toBe("/");
  });

  it("isPathInside matches the root itself and children, not siblings with a shared prefix", () => {
    expect(isPathInside("C:/Repo/src", "c:\\repo", W)).toBe(true);
    expect(isPathInside("c:\\repo", "C:\\Repo\\", W)).toBe(true);
    expect(isPathInside("c:\\repo2", "c:\\repo", W)).toBe(false);
    expect(isPathInside("D:\\x", "C:\\", W)).toBe(false);
    expect(isPathInside("C:\\x", "C:\\", W)).toBe(true);
    expect(isPathInside("/r/s", "/r", P)).toBe(true);
    expect(isPathInside("/r/s", "/r/", P)).toBe(true);
    expect(isPathInside("/R/s", "/r", P)).toBe(false);
  });

  it("expandTilde accepts ~\\ on Windows only", () => {
    expect(expandTilde("~\\cfg", "C:\\Users\\me", W)).toBe(win32.join("C:\\Users\\me", "cfg"));
    expect(expandTilde("~/cfg", "C:\\Users\\me", W)).toBe(win32.join("C:\\Users\\me", "cfg"));
    expect(expandTilde("~", "C:\\Users\\me", W)).toBe("C:\\Users\\me");
    expect(expandTilde("~\\cfg", "/home/me", P)).toBe("~\\cfg");
    expect(expandTilde("~/cfg", "/home/me", P)).toBe("/home/me/cfg");
    expect(expandTilde("~/cfg", undefined, P)).toBe("~/cfg");
    expect(expandTilde("~other", "/home/me", P)).toBe("~other");
  });

  it("relativeToHome", () => {
    expect(relativeToHome("c:/users/ME/a/b", "C:\\Users\\me", W)).toBe("a\\b");
    expect(relativeToHome("C:\\Users\\me", "C:\\Users\\me", W)).toBeNull();
    expect(relativeToHome("C:\\x", "C:\\", W)).toBeNull();
    expect(relativeToHome("D:\\Users\\me\\a", "C:\\Users\\me", W)).toBeNull();
    expect(relativeToHome("/h/me/a", "/h/me/", P)).toBe("a");
    expect(relativeToHome("/h/me/a", "/", P)).toBeNull();
    expect(relativeToHome("/h/mex", "/h/me", P)).toBeNull();
    expect(relativeToHome("/h/me/a", undefined, P)).toBeNull();
  });
});

describe("dispatchHome on Windows", () => {
  it("falls back to USERPROFILE, then HOMEDRIVE+HOMEPATH, matching names without case", () => {
    expect(dispatchHome({ USERPROFILE: "C:\\Users\\me" }, W)).toBe("C:\\Users\\me\\.dispatch");
    expect(dispatchHome({ HOMEDRIVE: "D:", HOMEPATH: "\\me" }, W)).toBe("D:\\me\\.dispatch");
    expect(dispatchHome({ dispatch_home: "E:\\d" }, W)).toBe("E:\\d");
    expect(globalConfigPath({ UserProfile: "C:\\u" }, W)).toMatch(/\.dispatch[\\/]config\.yaml$/);
  });

  it("names USERPROFILE in the error on Windows only", () => {
    expect(() => dispatchHome({}, W)).toThrow(/neither DISPATCH_HOME nor HOME nor USERPROFILE/);
    expect(() => dispatchHome({ USERPROFILE: "C:\\u" }, P)).toThrow(
      /neither DISPATCH_HOME nor HOME is set/,
    );
    expect(homeVarsText(P)).toBe("HOME");
  });
});

describe("[SEC-trust] Windows trust lookup", () => {
  const entry = { hash: "h", files: {}, trusted_at: "t" };

  it("matches a repo id case- and separator-insensitively on Windows only", () => {
    const trusted = { "C:/Users/Me/Repo/.git": entry };
    expect(trustedEntry(trusted, "c:\\users\\me\\repo\\.git", W)).toBe(entry);
    expect(trustedEntry(trusted, "c:\\users\\me\\other\\.git", W)).toBeUndefined();
    expect(trustedEntry({ "/r/.git": entry }, "/R/.git", P)).toBeUndefined();
    expect(trustedEntry({ "/r/.git": entry }, "/r/.git", P)).toBe(entry);
  });

  it("checkTrust with platform win32 finds the repo through the native realpath", () => {
    const sb = sandbox();
    const repo = sb.repo("main");
    writeFiles(repo, { ".dispatch/config.yaml": "version: 1\n" });
    const found = findRepo(repo, W);
    expect(found?.id).toBe(join(repo, ".git"));
    const state = checkTrust(repo, {}, { platform: W });
    expect(state.status).toBe("untrusted");
  });
});

/** A fake fs whose lstat and fstat identities can be made to disagree. */
function fakeFs(opts: {
  lstat?: Partial<FileIdentity> | Error;
  fstat?: Partial<FileIdentity> & { size?: bigint };
  data?: string;
}): NoFollowFs & { flags: number[]; closed: number } {
  const id = (p: Partial<FileIdentity>): FileIdentity => ({
    dev: 1n,
    ino: 2n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...p,
  });
  const data = Buffer.from(opts.data ?? "version: 1\n");
  const fs = {
    flags: [] as number[],
    closed: 0,
    lstatSync: () => {
      if (opts.lstat instanceof Error) throw opts.lstat;
      return id(opts.lstat ?? {});
    },
    openSync: (_p: string, flags: number) => {
      fs.flags.push(flags);
      return 7;
    },
    fstatSync: () => ({ size: BigInt(data.length), ...id(opts.fstat ?? {}), ...opts.fstat }),
    readSync: (_fd: number, buf: Buffer, off: number, len: number, pos: number) =>
      data.copy(buf, off, pos, pos + len),
    closeSync: () => {
      fs.closed++;
    },
  };
  return fs as NoFollowFs & { flags: number[]; closed: number };
}

describe("[SEC-trust] readNoFollow on Windows (no O_NOFOLLOW)", () => {
  it("reads a regular file whose lstat and fstat identities agree", () => {
    const fs = fakeFs({});
    expect(readNoFollow("C:\\r\\.dispatch\\config.yaml", W, fs)?.toString()).toBe("version: 1\n");
    expect(fs.closed).toBe(1);
  });

  it("refuses a symlink or junction (lstat reports both as links) before opening", () => {
    const fs = fakeFs({ lstat: { isSymbolicLink: () => true } });
    expect(() => readNoFollow("C:\\r\\x.yaml", W, fs)).toThrow(/cannot read/);
    expect(fs.flags).toEqual([]);
  });

  it("refuses a file swapped for a link between lstat and open (identity differs)", () => {
    const fs = fakeFs({ fstat: { ino: 99n } });
    expect(() => readNoFollow("C:\\r\\x.yaml", W, fs)).toThrow(/cannot read/);
    expect(fs.closed).toBe(1);
    const dev = fakeFs({ fstat: { dev: 5n } });
    expect(() => readNoFollow("C:\\r\\x.yaml", W, dev)).toThrow(/cannot read/);
  });

  it("returns null when absent and closes on fstat failure", () => {
    const gone = fakeFs({ lstat: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(readNoFollow("C:\\r\\x.yaml", W, gone)).toBeNull();
    const denied = fakeFs({ lstat: Object.assign(new Error("x"), { code: "EACCES" }) });
    expect(() => readNoFollow("C:\\r\\x.yaml", W, denied)).toThrow(/cannot read/);
    const broken = fakeFs({});
    broken.fstatSync = () => {
      throw new Error("io");
    };
    expect(() => readNoFollow("C:\\r\\x.yaml", W, broken)).toThrow(/cannot read/);
    expect(broken.closed).toBe(1);
  });

  it("returns null for a non-file", () => {
    const fs = fakeFs({ fstat: { isFile: () => false } });
    // lstat and fstat both say "not a file" with the same identity.
    fs.lstatSync = () => ({
      dev: 1n,
      ino: 2n,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    expect(readNoFollow("C:\\r\\dir", W, fs)).toBeNull();
  });

  it("with the real fs and platform win32, a symlinked policy file is refused", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "real.yaml"), "a: 1\n");
    symlinkSync(join(dir, "real.yaml"), join(dir, "link.yaml"));
    expect(readNoFollow(join(dir, "real.yaml"), W)?.toString()).toBe("a: 1\n");
    expect(() => readNoFollow(join(dir, "link.yaml"), W)).toThrow(/cannot read/);
    expect(readNoFollow(join(dir, "missing.yaml"), W)).toBeNull();
  });

  it("readPolicySet passes the platform and fs seams to the reader", () => {
    const sb = sandbox();
    const repo = sb.repo("r");
    mkdirSync(join(repo, ".dispatch"));
    writeFiles(repo, { ".dispatch/config.yaml": "version: 1\n" });
    const fs = fakeFs({ data: "version: 1\nprofile: off\n" });
    const set = readPolicySet(repo, { platform: W, fs });
    expect(set.files[0]?.bytes.toString()).toBe("version: 1\nprofile: off\n");
  });
});
