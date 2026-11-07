/**
 * `~/.dispatch/setup-manifest.json`: the record of every host edit `dispatch setup` applied, so
 * `uninstall --global` can undo exactly those edits and nothing else.
 */
import { join } from "node:path";
import { z } from "zod";
import type { EditOp } from "../../core/contracts.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { atomicWrite, mkdirTracked, readTextOrNull } from "./fsutil.js";

/** File name of the manifest inside the Dispatch home. */
export const MANIFEST_FILE = "setup-manifest.json";

/** Sentinel for "the file, key or path did not exist before setup". */
export const ABSENT = "absent" as const;

/** A byte-exact textual inverse: replacing `inserted` with `original` undoes the edit. */
export const TextInverseSchema = z.object({ original: z.string(), inserted: z.string() });
export type TextInverse = z.infer<typeof TextInverseSchema>;

/** State of host paths recorded before a `cli-command` ran (see edits `CliCommandSpec`). */
export const CliSnapshotSchema = z.object({
  /** JSON keys per file: the original value, or "absent". */
  jsonKeys: z.array(z.object({ file: z.string(), key: z.string(), before: z.unknown() })),
  /** Whether each leftover path existed before the command ran. */
  paths: z.array(z.object({ path: z.string(), existed: z.boolean() })),
});
export type CliSnapshot = z.infer<typeof CliSnapshotSchema>;

/** One applied {@link EditOp}. Identity is `(kind, file, signature)`. */
export const ManifestEntrySchema = z.object({
  file: z.string().min(1),
  kind: z.enum(["json-entry", "text-block", "new-file", "rules-file", "cli-command"]),
  signature: z.string().min(1),
  /** sha256 of what Dispatch wrote (the file, the canonical JSON entry or the block). */
  sha256: z.string(),
  createdFile: z.boolean(),
  /** Directories setup created for this op, outermost first. */
  createdDirs: z.array(z.string()),
  trustGrant: z.string().nullable(),
  /** json-entry: the value that was at the pointer before, or "absent". */
  preImage: z.unknown().optional(),
  /** json-entry / text-block: byte-exact inverse of the textual edit. */
  inverse: TextInverseSchema.optional(),
  /** cli-command: the argv that undoes it (empty when the host gave none). */
  undo: z.array(z.string()).optional(),
  snapshot: CliSnapshotSchema.optional(),
  /** The op as planned (content included), so `--refresh` can compare. */
  content: z.string(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  entries: z.array(ManifestEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Path of the manifest for a Dispatch home. */
export function manifestPath(dispatchHome: string): string {
  return join(dispatchHome, MANIFEST_FILE);
}

/** True when `entry` records `op`. */
export function sameOp(
  entry: Pick<ManifestEntry, "kind" | "file" | "signature">,
  op: Pick<EditOp, "kind" | "file" | "signature">,
): boolean {
  return entry.kind === op.kind && entry.file === op.file && entry.signature === op.signature;
}

/** Reads the manifest; an absent file is an empty manifest, a corrupt one is an error. */
export function readManifest(dispatchHome: string): Manifest {
  const path = manifestPath(dispatchHome);
  const text = readTextOrNull(path);
  if (text === null) return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  const parsed = ManifestSchema.safeParse(safeJson(text));
  if (!parsed.success) {
    throw new DispatchError(
      `setup manifest ${path} is unreadable; fix or remove it, then re-run setup`,
      ExitCode.TIMEOUT_OR_STATE,
      "setup.manifest_invalid",
    );
  }
  return parsed.data;
}

/** Writes the manifest atomically (mode 0600). */
export function writeManifest(dispatchHome: string, manifest: Manifest, now = new Date()): void {
  mkdirTracked(dispatchHome);
  const out: Manifest = { ...manifest, updatedAt: now.toISOString() };
  atomicWrite(manifestPath(dispatchHome), `${JSON.stringify(out, null, 2)}\n`, 0o600);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
