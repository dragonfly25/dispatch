/**
 * Best-effort secret scan of a unified diff (plan §2 "Sandbox", AC7). Pure: no I/O.
 *
 * Only added lines are scanned, with the same patterns the state redactor uses. A finding names
 * the file, the line in the new file and the kind of secret; it never carries the matched value.
 */
import { SECRET_PATTERNS } from "../state/redact.js";

/** One suspected secret in the patch. */
export interface SecretFinding {
  /** Repo-relative path of the file in the patched tree. */
  file: string;
  /** 1-based line number in the patched file. */
  line: number;
  /** Pattern kind, e.g. `github-token` or `private-key`. */
  kind: string;
}

/** Non-global copies, so `test` carries no `lastIndex` state between lines. */
const PATTERNS = SECRET_PATTERNS.map(({ kind, re }) => ({
  kind,
  re: new RegExp(re.source, re.flags.replace("g", "")),
}));

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Undoes git's C-style quoting of a path (`"b/caf\303\251"` -> `b/café`). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(simple[next] ?? next, "utf8"));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Path of a `+++ ` header without its `b/` prefix; null for `/dev/null` (a deletion). */
function targetPath(header: string): string | null {
  const raw = unquoteGitPath(header.slice(4).replace(/\t.*$/, ""));
  if (raw === "/dev/null") return null;
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

/** Kinds of secret found in one line, at most one finding per kind. */
function kindsIn(line: string): string[] {
  return PATTERNS.filter((p) => p.re.test(line)).map((p) => p.kind);
}

/**
 * Scans the added lines of a git patch (as produced with `a/` and `b/` prefixes). Binary hunks,
 * context and removed lines are ignored.
 */
export function scanPatch(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lineNo = 0;
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const tag = line[0];
      if (tag === "+") {
        if (file !== null) {
          for (const kind of kindsIn(line.slice(1))) findings.push({ file, line: lineNo, kind });
        }
        lineNo++;
        newLeft--;
      } else if (tag === "-") {
        oldLeft--;
      } else if (tag !== "\\") {
        lineNo++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) file = null;
    else if (line.startsWith("+++ ")) file = targetPath(line);
    else {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        lineNo = Number(m[2]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
      }
    }
  }
  return findings;
}
