/**
 * Small filesystem helpers for the setup framework. `src/hosts/_framework` is the only module that
 * writes host files (plan §2 "Module boundaries"); every write goes through {@link atomicWrite}.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Lowercase hex sha256 of a string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** File contents as UTF-8, or null when the file does not exist. */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Follows a symlinked file (e.g. a dotfiles-managed settings.json) so edits land in its target. */
export function writeTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * Creates `dir` and missing parents. Returns the directories that did not exist before, outermost
 * first, so a revert can remove exactly those (innermost first).
 */
export function mkdirTracked(dir: string): string[] {
  const missing: string[] = [];
  let cur = dir;
  while (!existsSync(cur)) {
    missing.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (missing.length > 0) mkdirSync(dir, { recursive: true });
  return missing;
}

/**
 * Writes `content` atomically: a temp file in the same directory, then `rename`. Keeps the mode
 * of an existing file unless `mode` is given. Symlinked targets are written through.
 */
export function atomicWrite(path: string, content: string, mode?: number): void {
  const target = writeTarget(path);
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const keepMode = mode ?? (existsSync(target) ? statSync(target).mode & 0o7777 : undefined);
  try {
    writeFileSync(tmp, content, { mode: keepMode ?? 0o644 });
    if (keepMode !== undefined) chmodSync(tmp, keepMode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Removes the given directories innermost first, each only when it is empty. */
export function removeEmptyDirs(dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // already gone or not a directory: nothing to do
    }
  }
}
