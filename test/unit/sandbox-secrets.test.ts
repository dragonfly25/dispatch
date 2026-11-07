import { describe, expect, it } from "vitest";
import { scanPatch, unquoteGitPath } from "../../src/sandbox/secrets.js";
import { redact, SECRET_PATTERNS } from "../../src/state/redact.js";
import { SECRET_SAMPLES } from "../support/secrets.js";

const gh = SECRET_SAMPLES["github-token"];

describe("scanPatch [SEC-patch][AC7]", () => {
  it("reports file, new-file line and kind for added lines only, never the value", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,4 +10,5 @@ fn",
      " context",
      `-const old = "${gh}";`,
      `+const token = "${gh}";`,
      " context",
      "+++ added line that looks like a header",
      "\\ No newline at end of file",
      " tail",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      `-${SECRET_SAMPLES["aws-key-id"]}`,
    ].join("\n");
    const findings = scanPatch(patch);
    expect(findings).toEqual([{ file: "src/a.ts", line: 11, kind: "github-token" }]);
    expect(JSON.stringify(findings)).not.toContain("CANARY");
  });

  it("finds a private key in a new file and handles quoted paths and single-line hunks", () => {
    const patch = [
      'diff --git "a/caf\\303\\251.pem" "b/caf\\303\\251.pem"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251.pem"',
      "@@ -0,0 +1 @@",
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-x",
      `+${SECRET_SAMPLES.bearer} ${SECRET_SAMPLES["slack-token"]}`,
    ].join("\n");
    expect(scanPatch(patch)).toEqual([
      { file: "café.pem", line: 1, kind: "private-key" },
      { file: "one.txt", line: 1, kind: "slack-token" },
      { file: "one.txt", line: 1, kind: "bearer" },
    ]);
  });

  it("detects every redaction pattern", () => {
    for (const [name, value] of Object.entries(SECRET_SAMPLES)) {
      const line = value.split("\n")[0] as string;
      const patch = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,0 +1,1 @@\n+x = ${line}\n`;
      expect(scanPatch(patch).length, name).toBeGreaterThan(0);
    }
  });

  it("ignores binary patches and lines outside hunks", () => {
    const patch = [
      "diff --git a/b.bin b/b.bin",
      "new file mode 100644",
      "GIT binary patch",
      "literal 4",
      `+${gh}`,
      "",
    ].join("\n");
    expect(scanPatch(patch)).toEqual([]);
    expect(scanPatch("")).toEqual([]);
  });
});

describe("unquoteGitPath", () => {
  it("decodes C-style escapes and leaves plain paths alone", () => {
    expect(unquoteGitPath("plain/path")).toBe("plain/path");
    expect(unquoteGitPath('"a\\tb\\n\\"q\\"\\\\"')).toBe('a\tb\n"q"\\');
    expect(unquoteGitPath('"\\303\\244"')).toBe("ä");
    expect(unquoteGitPath('"')).toBe('"');
  });
});

describe("SECRET_PATTERNS export", () => {
  it("is the redactor's own list (redact still behaves the same)", () => {
    expect(SECRET_PATTERNS.map((p) => p.kind)).toContain("private-key");
    expect(redact(`x ${gh}`)).toBe("x [REDACTED:github-token]");
  });
});
