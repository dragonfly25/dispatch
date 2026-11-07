/**
 * `json-entry` edits on JSON/JSONC host files (e.g. `~/.codex/hooks.json`), made with jsonc-parser
 * so comments and every byte outside Dispatch's entry survive. A byte-exact textual inverse is
 * recorded, so removing the entry restores the original file byte for byte when nobody touched
 * the edited region; otherwise a structural removal is used.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { atomicWrite, mkdirTracked, readTextOrNull, removeEmptyDirs, sha256 } from "./fsutil.js";
import { ABSENT, type TextInverse } from "./manifest.js";

/**
 * The `content` of a json-entry {@link EditOp}, as JSON.
 * - `append`: `value` is appended to the array at `path` (created when missing). The entry is the
 *   array element containing a string equal to the op's `signature` (the hook command).
 *   Its pre-image is the number of leading `path` segments that existed before (to prune the
 *   containers setup created).
 * - `set`: `path` is set to `value`; the previous value (or "absent") is kept as the pre-image.
 */
export interface JsonEntrySpec {
  path: (string | number)[];
  mode: "append" | "set";
  value: unknown;
}

/** Parses and validates a json-entry `content`. */
export function parseJsonEntrySpec(content: string): JsonEntrySpec {
  let spec: Partial<JsonEntrySpec> | undefined;
  try {
    spec = JSON.parse(content) as Partial<JsonEntrySpec>;
  } catch {
    spec = undefined;
  }
  if (
    !spec ||
    !Array.isArray(spec.path) ||
    spec.path.length === 0 ||
    (spec.mode !== "append" && spec.mode !== "set") ||
    spec.value === undefined
  ) {
    throw new DispatchError(
      "json-entry content must be {path: non-empty array, mode: append|set, value}",
      ExitCode.USAGE,
      "setup.bad_op",
    );
  }
  return spec as JsonEntrySpec;
}

/** Stable JSON (sorted keys) used to hash entries independently of formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    const obj = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of {@link canonicalJson}. */
export function jsonHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => containsString(v, needle));
  }
  return false;
}

/** Parses JSONC; throws a clear error instead of editing a broken file. */
function parse(file: string, text: string): Node | undefined {
  if (text.trim() === "") return undefined;
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || root === undefined) {
    throw new DispatchError(
      `cannot edit ${file}: it is not valid JSON/JSONC; fix it and re-run`,
      ExitCode.TIMEOUT_OR_STATE,
      "setup.json_invalid",
    );
  }
  return root;
}

/** Indentation and line endings detected from the file, so inserted text blends in. */
export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}

/** Minimal changed span between `before` and `after` (common prefix and suffix trimmed). */
export function diffSpan(before: string, after: string): TextInverse {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return {
    original: before.slice(p, before.length - s),
    inserted: after.slice(p, after.length - s),
  };
}

/**
 * Undoes `inv` in `text` at the single occurrence of `inv.inserted` overlapping `[from, to)`.
 * Returns null when there is no unambiguous occurrence (the region was edited since).
 */
export function undoSpan(text: string, inv: TextInverse, from: number, to: number): string | null {
  if (inv.inserted === "") return null;
  const hits: number[] = [];
  for (let i = text.indexOf(inv.inserted); i !== -1; i = text.indexOf(inv.inserted, i + 1)) {
    if (i < to && i + inv.inserted.length > from) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const at = hits[0] as number;
  return text.slice(0, at) + inv.original + text.slice(at + inv.inserted.length);
}

/** Result of locating Dispatch's entry in a file. */
interface Located {
  node: Node;
  value: unknown;
  index: number;
}

function locate(root: Node | undefined, spec: JsonEntrySpec, signature: string): Located | null {
  if (!root) return null;
  if (spec.mode === "set") {
    const node = findNodeAtLocation(root, spec.path as JSONPath);
    return node ? { node, value: getNodeValue(node), index: -1 } : null;
  }
  const arr = findNodeAtLocation(root, spec.path as JSONPath);
  if (arr?.type !== "array") return null;
  const children = arr.children ?? [];
  for (const [index, node] of children.entries()) {
    const value = getNodeValue(node);
    if (containsString(value, signature)) return { node, value, index };
  }
  return null;
}

/** What {@link applyJsonEntry} did. */
export interface JsonApplyResult {
  status: "applied" | "unchanged";
  sha256: string;
  createdFile: boolean;
  createdDirs: string[];
  preImage: unknown;
  inverse?: TextInverse;
}

/**
 * Inserts (append) or sets Dispatch's entry. Idempotent: an identical entry already present is
 * left untouched (`unchanged`). A different entry with the same signature must be removed first.
 */
export function applyJsonEntry(file: string, signature: string, content: string): JsonApplyResult {
  const spec = parseJsonEntrySpec(content);
  const existing = readTextOrNull(file);
  const text = existing ?? "";
  const root = parse(file, text);
  const hash = jsonHash(spec.value);
  const found = locate(root, spec, signature);
  if (found && jsonHash(found.value) === hash) {
    return {
      status: "unchanged",
      sha256: hash,
      createdFile: false,
      createdDirs: [],
      preImage: undefined,
    };
  }
  if (found && spec.mode === "append") {
    throw new DispatchError(
      `${file} already has a different Dispatch entry (${signature}); run \`dispatch uninstall --global\` or remove it by hand`,
      ExitCode.TIMEOUT_OR_STATE,
      "setup.entry_conflict",
    );
  }
  const preImage = spec.mode === "set" ? (found?.value ?? ABSENT) : existingDepth(root, spec.path);
  const path = spec.mode === "append" ? [...spec.path, -1] : spec.path;
  const edits = modify(text, path as JSONPath, spec.value, {
    formattingOptions: detectFormatting(text),
  });
  let next = applyEdits(text, edits);
  if (existing === null && !next.endsWith("\n")) next += "\n";
  const createdDirs = existing === null ? mkdirTracked(dirname(file)) : [];
  atomicWrite(file, next, existing === null ? 0o644 : undefined);
  return {
    status: "applied",
    sha256: hash,
    createdFile: existing === null,
    createdDirs,
    preImage,
    inverse: diffSpan(text, next),
  };
}

/** What a revert did; `warning` is set when Dispatch left something for the user to handle. */
export interface RevertResult {
  status: "reverted" | "missing" | "kept";
  warning?: string;
}

/** Recorded facts needed to remove a json-entry. */
export interface JsonEntryRecord {
  file: string;
  signature: string;
  content: string;
  sha256: string;
  createdFile: boolean;
  createdDirs: string[];
  preImage?: unknown;
  inverse?: TextInverse | undefined;
}

/** True for objects/arrays that hold nothing but (recursively) empty objects/arrays. */
function hollow(v: unknown): boolean {
  return v !== null && typeof v === "object" && Object.values(v).every(hollow);
}

/** Whitespace only, or a document that is {@link hollow} (e.g. `{"hooks": {}}`). */
function isEmptyEquivalent(text: string): boolean {
  return text.trim() === "" || hollow(docValue(text));
}

/**
 * Removes exactly Dispatch's entry. A hash mismatch (the user edited it) keeps the entry and
 * returns a warning with the manual instruction. A file Dispatch created and that is now
 * empty-equivalent is deleted, together with the directories setup created for it.
 */
export function revertJsonEntry(rec: JsonEntryRecord): RevertResult {
  const spec = parseJsonEntrySpec(rec.content);
  const text = readTextOrNull(rec.file);
  if (text === null) return { status: "missing" };
  const found = locate(parse(rec.file, text), spec, rec.signature);
  const where = spec.path.join(".");
  if (!found) return { status: "missing" };
  if (jsonHash(found.value) !== rec.sha256) {
    return {
      status: "kept",
      warning: `${rec.file}: the Dispatch entry at "${where}" was edited since setup, so it was left in place; remove it by hand if you no longer want it`,
    };
  }
  const structural = structuralRemove(text, spec, found, rec.preImage);
  const textual = rec.inverse
    ? undoSpan(text, rec.inverse, found.node.offset, found.node.offset + found.node.length)
    : null;
  // The byte-exact inverse wins only when it yields the same data as the structural removal and
  // adds no syntax problems (e.g. a dangling comma after user edits next to the entry).
  const next =
    textual !== null &&
    canonicalJson(docValue(textual)) === canonicalJson(docValue(structural)) &&
    strictErrors(textual) <= strictErrors(text)
      ? textual
      : structural;
  if (rec.createdFile && isEmptyEquivalent(next)) {
    rmSync(rec.file, { force: true });
    removeEmptyDirs(rec.createdDirs);
    return { status: "reverted" };
  }
  atomicWrite(rec.file, next);
  return { status: "reverted" };
}

function docValue(text: string): unknown {
  const root = safeParse(text);
  return root ? getNodeValue(root) : undefined;
}

/** Parse errors without JSONC leniency (trailing commas count). */
function strictErrors(text: string): number {
  const errors: ParseError[] = [];
  parseTree(text, errors, { allowTrailingComma: false });
  return errors.length;
}

function safeParse(text: string): Node | undefined {
  try {
    return parse("", text);
  } catch {
    return undefined;
  }
}

function structuralRemove(
  text: string,
  spec: JsonEntrySpec,
  found: Located,
  preImage: unknown,
): string {
  const fmt = { formattingOptions: detectFormatting(text) };
  if (spec.mode === "set") {
    const restore = preImage === ABSENT || preImage === undefined ? undefined : preImage;
    return applyEdits(text, modify(text, spec.path as JSONPath, restore, fmt));
  }
  let next = applyEdits(
    text,
    modify(text, [...spec.path, found.index] as JSONPath, undefined, fmt),
  );
  // Prune the now-empty containers that setup created (deeper than what existed before).
  const existed = typeof preImage === "number" ? preImage : spec.path.length;
  for (let depth = spec.path.length; depth > Math.max(existed, 0); depth--) {
    const at = spec.path.slice(0, depth) as JSONPath;
    const root = safeParse(next);
    const node = root ? findNodeAtLocation(root, at) : undefined;
    if (!node || (node.children ?? []).length > 0) break;
    next = applyEdits(next, modify(next, at, undefined, fmt));
  }
  return next;
}

/** Number of leading segments of `path` that exist in the document (append-mode pre-image). */
function existingDepth(root: Node | undefined, path: (string | number)[]): number {
  if (!root) return 0;
  let depth = 0;
  while (depth < path.length && findNodeAtLocation(root, path.slice(0, depth + 1) as JSONPath)) {
    depth++;
  }
  return depth;
}

/**
 * Removes `key` (a top-level property) from a JSON file when its value is an empty object or array.
 * Used to undo keys a host CLI leaves behind after its own uninstall. Returns true on removal.
 */
export function removeKeyIfEmpty(file: string, key: string): boolean {
  const text = readTextOrNull(file);
  const root = text === null ? undefined : safeParse(text);
  const node = root ? findNodeAtLocation(root, [key]) : undefined;
  if (text === null || !node) return false;
  const value = getNodeValue(node);
  if (value === null || typeof value !== "object" || Object.keys(value).length > 0) return false;
  const edits = modify(text, [key], undefined, { formattingOptions: detectFormatting(text) });
  atomicWrite(file, applyEdits(text, edits));
  return true;
}

/** Value of the top-level `key` in a JSON file, or "absent" when the file or key is missing. */
export function getJsonKey(file: string, key: string): unknown {
  const text = readTextOrNull(file);
  const root = text === null ? undefined : safeParse(text);
  const node = root ? findNodeAtLocation(root, [key]) : undefined;
  return node ? getNodeValue(node) : ABSENT;
}
