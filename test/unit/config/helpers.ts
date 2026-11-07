/** Temp HOME / repo kit for config tests (never touches the real HOME). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp directory (realpath'd), removed after the test. */
export function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-config-")));
  cleanup.push(d);
  return d;
}

/** Writes `files` (relative path → content) under `root`. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** A sandbox with a temp HOME and an env pointing at it. */
export function sandbox() {
  const root = tempDir();
  const home = join(root, "home");
  mkdirSync(home);
  const env = { HOME: home };
  return {
    root,
    home,
    env,
    dispatchHome: join(home, ".dispatch"),
    /** Writes `~/.dispatch/config.yaml`. */
    global(text: string) {
      writeFiles(home, { ".dispatch/config.yaml": text });
    },
    /** Creates a repo (a `.git` dir, no git binary needed) with optional files. */
    repo(name = "repo", files: Record<string, string> = {}) {
      const dir = join(root, name);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFiles(dir, { ".git/HEAD": "ref: refs/heads/main\n", ...files });
      return dir;
    },
  };
}
