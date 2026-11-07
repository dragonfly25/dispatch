/**
 * Apply and revert one {@link EditOp} per kind. Every function here is idempotent and records what
 * it needs in a {@link ManifestEntry} so `uninstall --global` can undo exactly Dispatch's edits.
 */
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type EditOp, ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { atomicWrite, mkdirTracked, readTextOrNull, removeEmptyDirs, sha256 } from "./fsutil.js";
import {
  applyJsonEntry,
  diffSpan,
  getJsonKey,
  type RevertResult,
  removeKeyIfEmpty,
  revertJsonEntry,
  undoSpan,
} from "./json-entry.js";
import { ABSENT, type CliSnapshot, type ManifestEntry } from "./manifest.js";

export type { RevertResult } from "./json-entry.js";

/** Result of a finished command. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Port that runs host CLI commands for `cli-command` ops (e.g. `claude plugin install …`).
 * The production implementation lives in `src/runner` (the only module that may spawn).
 */
export interface CommandRunner {
  run(binary: string, argv: readonly string[]): Promise<CommandResult>;
}

/**
 * The `content` of a `cli-command` op, as JSON. A bare JSON array is accepted as `{argv}` (no undo).
 * - `undo`: argv that reverts the command (e.g. `plugin uninstall …`), run by `uninstall --global`.
 * - `snapshot.jsonKeys`: top-level keys of JSON files the command adds. Those absent before setup
 *   are removed after `undo` when the host CLI left them as empty objects (restores pre-install
 *   state, see docs/spikes/hosts-prototype.md §1).
 * - `snapshot.leftovers`: paths the command may create. Those absent before setup are removed after
 *   `undo`: a directory recursively when `recursive`, else only when empty; a file only when its
 *   JSON equals `match`.
 */
export interface CliCommandSpec {
  argv: string[];
  undo?: string[];
  snapshot?: {
    jsonKeys?: { file: string; keys: string[] }[];
    leftovers?: { path: string; recursive?: boolean; match?: unknown }[];
  };
}

/** Parses a cli-command `content`. */
export function parseCliSpec(content: string): CliCommandSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = undefined;
  }
  const spec = (Array.isArray(raw) ? { argv: raw } : raw) as CliCommandSpec | undefined;
  const isArgv = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string");
  if (!spec || !isArgv(spec.argv) || (spec.undo !== undefined && !isArgv(spec.undo))) {
    throw new DispatchError(
      "cli-command content must be a JSON argv or {argv, undo?, snapshot?}",
      ExitCode.USAGE,
      "setup.bad_op",
    );
  }
  return spec;
}

/** Dependencies of apply/revert. */
export interface EditDeps {
  runner?: CommandRunner | undefined;
}

/** Outcome of {@link applyOp}. */
export interface ApplyResult {
  status: "applied" | "unchanged";
  entry: ManifestEntry;
}

function baseEntry(op: EditOp): ManifestEntry {
  return {
    file: op.file,
    kind: op.kind,
    signature: op.signature,
    sha256: "",
    createdFile: false,
    createdDirs: [],
    trustGrant: op.trustGrant,
    content: op.content,
  };
}

function conflict(message: string): DispatchError {
  return new DispatchError(message, ExitCode.TIMEOUT_OR_STATE, "setup.conflict");
}

function needRunner(deps: EditDeps): CommandRunner {
  if (!deps.runner) {
    throw new DispatchError(
      "no command runner for cli-command",
      ExitCode.FAILED,
      "setup.no_runner",
    );
  }
  return deps.runner;
}

/** Applies `op`. `prev` is the manifest entry from an earlier setup, if any. */
export async function applyOp(
  op: EditOp,
  prev: ManifestEntry | undefined,
  deps: EditDeps = {},
): Promise<ApplyResult> {
  switch (op.kind) {
    case "new-file":
    case "rules-file":
      return applyNewFile(op, prev);
    case "text-block":
      return applyTextBlock(op, prev);
    case "json-entry": {
      if (prev && readTextOrNull(op.file) !== null && prev.content !== op.content) {
        // Refresh: the planned entry changed. Remove ours first, then insert the new one.
        const r = revertJsonEntry(prev);
        if (r.warning) throw conflict(r.warning);
      }
      const r = applyJsonEntry(op.file, op.signature, op.content);
      if (r.status === "unchanged" && prev) return { status: "unchanged", entry: prev };
      const entry: ManifestEntry = {
        ...baseEntry(op),
        sha256: r.sha256,
        createdFile: r.createdFile || (prev?.createdFile ?? false),
        createdDirs: r.createdDirs.length > 0 ? r.createdDirs : (prev?.createdDirs ?? []),
        preImage: r.preImage,
      };
      if (r.inverse) entry.inverse = r.inverse;
      return { status: r.status, entry };
    }
    case "cli-command":
      return applyCli(op, prev, deps);
  }
}

function applyNewFile(op: EditOp, prev: ManifestEntry | undefined): ApplyResult {
  const hash = sha256(op.content);
  if (op.sha256 !== undefined && op.sha256 !== hash) {
    throw new DispatchError(`sha256 of ${op.file} does not match its content`, ExitCode.USAGE);
  }
  const mode = Number.parseInt(op.mode ?? "0644", 8);
  const entry: ManifestEntry = { ...baseEntry(op), sha256: hash };
  const existing = readTextOrNull(op.file);
  if (existing !== null) {
    if (existing === op.content) {
      return { status: "unchanged", entry: prev ? { ...prev, content: op.content } : entry };
    }
    if (!prev) {
      throw conflict(`refusing to overwrite ${op.file}: it exists and was not created by Dispatch`);
    }
    if (sha256(existing) !== prev.sha256) {
      throw conflict(`refusing to overwrite ${op.file}: it was edited since setup`);
    }
    atomicWrite(op.file, op.content, mode);
    return {
      status: "applied",
      entry: { ...entry, createdFile: prev.createdFile, createdDirs: prev.createdDirs },
    };
  }
  const createdDirs = mkdirTracked(dirname(op.file));
  atomicWrite(op.file, op.content, mode);
  return { status: "applied", entry: { ...entry, createdFile: true, createdDirs } };
}

const markers = (sig: string) => [`# dispatch:begin ${sig}`, `# dispatch:end ${sig}`] as const;

/** The full marked block Dispatch writes for a text-block op. */
export function renderTextBlock(signature: string, content: string): string {
  const [begin, end] = markers(signature);
  const body = content.endsWith("\n") || content === "" ? content : `${content}\n`;
  return `${begin}\n${body}${end}\n`;
}

function findBlock(text: string, signature: string): { start: number; block: string } | null {
  const [begin, end] = markers(signature);
  const start = text.indexOf(`${begin}\n`);
  if (start === -1) return null;
  const endAt = text.indexOf(`${end}\n`, start);
  if (endAt === -1) return null;
  return { start, block: text.slice(start, endAt + end.length + 1) };
}

function applyTextBlock(op: EditOp, prev: ManifestEntry | undefined): ApplyResult {
  const block = renderTextBlock(op.signature, op.content);
  const entry: ManifestEntry = { ...baseEntry(op), sha256: sha256(block) };
  const existing = readTextOrNull(op.file);
  const text = existing ?? "";
  const found = findBlock(text, op.signature);
  if (found) {
    if (found.block === block) return { status: "unchanged", entry: prev ?? entry };
    if (!prev || sha256(found.block) !== prev.sha256) {
      throw conflict(`refusing to replace the edited Dispatch block in ${op.file}`);
    }
    atomicWrite(op.file, text.replace(found.block, block));
    const refreshed: ManifestEntry = { ...prev, ...entry };
    if (prev.inverse) {
      // Keep undoing back to the pre-setup bytes, with the new block in place of the old one.
      const inserted = prev.inverse.inserted.replace(found.block, block);
      refreshed.inverse = { original: prev.inverse.original, inserted };
    }
    return { status: "applied", entry: refreshed };
  }
  const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
  const next = text + prefix + block;
  const createdDirs = existing === null ? mkdirTracked(dirname(op.file)) : [];
  atomicWrite(op.file, next, existing === null ? 0o644 : undefined);
  return {
    status: "applied",
    entry: { ...entry, createdFile: existing === null, createdDirs, inverse: diffSpan(text, next) },
  };
}

function revertTextBlock(entry: ManifestEntry): RevertResult {
  const text = readTextOrNull(entry.file);
  const found = text === null ? null : findBlock(text, entry.signature);
  if (text === null || !found) return { status: "missing" };
  if (sha256(found.block) !== entry.sha256) {
    return {
      status: "kept",
      warning: `${entry.file}: the block between "# dispatch:begin/end ${entry.signature}" was edited since setup, so it was left in place; delete it by hand if you no longer want it`,
    };
  }
  const end = found.start + found.block.length;
  const next =
    (entry.inverse && undoSpan(text, entry.inverse, found.start, end)) ??
    text.slice(0, found.start) + text.slice(end);
  if (entry.createdFile && next.trim() === "") {
    rmSync(entry.file, { force: true });
    removeEmptyDirs(entry.createdDirs);
  } else {
    atomicWrite(entry.file, next);
  }
  return { status: "reverted" };
}

function revertNewFile(entry: ManifestEntry): RevertResult {
  const text = readTextOrNull(entry.file);
  if (text === null) return { status: "missing" };
  if (sha256(text) !== entry.sha256) {
    return {
      status: "kept",
      warning: `${entry.file} was edited since setup, so it was left in place; delete it by hand if you no longer want it`,
    };
  }
  if (!entry.createdFile) return { status: "kept" };
  rmSync(entry.file, { force: true });
  removeEmptyDirs(entry.createdDirs);
  return { status: "reverted" };
}

function cliLabel(binary: string, argv: readonly string[]): string {
  return [binary, ...argv].join(" ");
}

async function applyCli(
  op: EditOp,
  prev: ManifestEntry | undefined,
  deps: EditDeps,
): Promise<ApplyResult> {
  const spec = parseCliSpec(op.content);
  if (prev && prev.content === op.content) return { status: "unchanged", entry: prev };
  const snapshot: CliSnapshot = prev?.snapshot ?? {
    jsonKeys: (spec.snapshot?.jsonKeys ?? []).flatMap(({ file, keys }) =>
      keys.map((key) => ({ file, key, before: getJsonKey(file, key) })),
    ),
    paths: (spec.snapshot?.leftovers ?? []).map((l) => ({
      path: l.path,
      existed: existsSync(l.path),
    })),
  };
  const res = await needRunner(deps).run(op.file, spec.argv);
  if (res.code !== 0) {
    throw new DispatchError(
      `\`${cliLabel(op.file, spec.argv)}\` failed (exit ${res.code}): ${res.stderr.trim()}`,
      ExitCode.FAILED,
      "setup.command_failed",
    );
  }
  return {
    status: "applied",
    entry: { ...baseEntry(op), sha256: sha256(op.content), undo: spec.undo ?? [], snapshot },
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Removes a leftover path that did not exist before setup (see {@link CliCommandSpec}). */
function removeLeftover(l: { path: string; recursive?: boolean; match?: unknown }): void {
  if (!existsSync(l.path)) return;
  if (statSync(l.path).isDirectory()) {
    if (l.recursive) rmSync(l.path, { recursive: true, force: true });
    else if (readdirSync(l.path).length === 0) rmdirSync(l.path);
    return;
  }
  if (l.match === undefined) return;
  try {
    const text = readTextOrNull(l.path);
    if (text !== null && sameJson(JSON.parse(text), l.match)) rmSync(l.path, { force: true });
  } catch {
    // not JSON: leave it
  }
}

async function revertCli(entry: ManifestEntry, deps: EditDeps): Promise<RevertResult> {
  const undo = entry.undo ?? [];
  if (undo.length === 0) {
    return { status: "kept", warning: `no undo recorded for \`${entry.file} ${entry.signature}\`` };
  }
  const res = await needRunner(deps).run(entry.file, undo);
  if (res.code !== 0) {
    return {
      status: "kept",
      warning: `\`${cliLabel(entry.file, undo)}\` failed (exit ${res.code}); run it by hand`,
    };
  }
  const spec = parseCliSpec(entry.content);
  for (const k of entry.snapshot?.jsonKeys ?? []) {
    if (k.before === ABSENT) removeKeyIfEmpty(k.file, k.key);
  }
  const existed = new Map((entry.snapshot?.paths ?? []).map((p) => [p.path, p.existed]));
  for (const l of spec.snapshot?.leftovers ?? []) {
    if (existed.get(l.path) === false) removeLeftover(l);
  }
  return { status: "reverted" };
}

/** Reverts one manifest entry. Never throws for user edits: those come back as warnings. */
export async function revertEntry(
  entry: ManifestEntry,
  deps: EditDeps = {},
): Promise<RevertResult> {
  switch (entry.kind) {
    case "new-file":
    case "rules-file":
      return revertNewFile(entry);
    case "text-block":
      return revertTextBlock(entry);
    case "json-entry":
      return revertJsonEntry(entry);
    case "cli-command":
      return revertCli(entry, deps);
  }
}
