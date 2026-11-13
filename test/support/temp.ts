import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isWindows, type OsPlatform } from "../../src/platform/os.js";

const created = new Set<string>();
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string, parent: string = tmpdir()): string {
  // Native realpath resolves macOS /var -> /private/var and Windows 8.3 names (RUNNER~1).
  const dir = realpathSync.native(mkdtempSync(join(parent, prefix)));
  created.add(dir);
  return dir;
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  created.delete(dir);
}

/** A throwaway HOME. Nothing in it is touched by the real user's HOME, `~/.dispatch` or `~/.claude`. */
export interface TempHome {
  /** Temp HOME (also the root that holds `dispatchHome`). */
  home: string;
  /** `<home>/.dispatch`; not created, Dispatch creates it on first use. */
  dispatchHome: string;
  /**
   * Env overrides to spread into the code under test: HOME, USERPROFILE, DISPATCH_HOME, CODEX_HOME,
   * XDG_*, and on Windows APPDATA/LOCALAPPDATA (so nothing falls back to the real profile).
   */
  env: Record<string, string>;
  /** Removes the directory (also done automatically when the test process exits). */
  cleanup(): void;
}

/** Creates a temp HOME and the env overrides that point every tool at it. */
export function tempHome(platform: OsPlatform = process.platform): TempHome {
  const home = makeTempDir("dispatch-home-");
  const dispatchHome = join(home, ".dispatch");
  return {
    home,
    dispatchHome,
    env: {
      HOME: home,
      USERPROFILE: home,
      DISPATCH_HOME: dispatchHome,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ...(isWindows(platform)
        ? {
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
          }
        : {}),
    },
    cleanup: () => removeTempDir(home),
  };
}

/** A file in `tempRepo({ files })`: contents, or `{ content, mode }`, or `{ symlink }` to a target. */
export type RepoFile =
  | string
  | Uint8Array
  | { content: string | Uint8Array; mode?: number }
  | { symlink: string };

export interface TempRepoOptions {
  /** Default `{ "README.md": "# fixture repo\n" }`. */
  files?: Record<string, RepoFile>;
  /** Commit all files (default true). */
  commit?: boolean;
  /** Create the repo inside this existing directory (default: the OS temp dir). Handy when a test writes `../x`. */
  parent?: string;
  /** Initial branch (default "main"). */
  branch?: string;
  message?: string;
}

export interface TempRepo {
  /** Real path of the work tree. */
  dir: string;
  /** Runs `git <args>` in the repo and returns trimmed stdout. */
  git(...args: string[]): string;
  /** Writes (creating parents) a file relative to the repo root. */
  write(rel: string, file: RepoFile): void;
  /** `git add -A && git commit`; returns the new HEAD sha. */
  commitAll(message?: string): string;
  cleanup(): void;
}

/** Env that makes git ignore the user's and the system's config. */
export const GIT_TEST_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
} as const;

/** `git init`, local identity (never the user's), optional initial commit. */
export function tempRepo(opts: TempRepoOptions = {}): TempRepo {
  const dir = makeTempDir("dispatch-repo-", opts.parent);
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...GIT_TEST_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (rel: string, file: RepoFile): void => {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof file === "object" && "symlink" in file) {
      symlinkSync(file.symlink, target);
      return;
    }
    const content = typeof file === "string" || file instanceof Uint8Array ? file : file.content;
    writeFileSync(target, content);
    if (typeof file === "object" && !(file instanceof Uint8Array) && file.mode !== undefined) {
      chmodSync(target, file.mode);
    }
  };
  const commitAll = (message = "initial commit"): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "-q", "-b", opts.branch ?? "main");
  git("config", "user.name", "Dispatch Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  for (const [rel, file] of Object.entries(opts.files ?? { "README.md": "# fixture repo\n" })) {
    write(rel, file);
  }
  if (opts.commit !== false) commitAll(opts.message);
  return { dir, git, write, commitAll, cleanup: () => removeTempDir(dir) };
}
