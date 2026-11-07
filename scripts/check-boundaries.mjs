#!/usr/bin/env node
// Module-boundary guard (plan §2 "Module boundaries", §3 "CI"). No dependencies.
//   node scripts/check-boundaries.mjs [rootDir]
// Rules:
//   1. src/router/** is pure: no `Date`, `Math.random` or `process.env` (comments are ignored).
//   2. Only src/runner/** may import `child_process` / `node:child_process`.
//   3. .github/workflows/* must not contain `secrets.` or `pull_request_target`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();
const violations = [];

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, exts);
    return exts.some((e) => name.endsWith(e)) ? [full] : [];
  });
}

/** Removes block and line comments; good enough for a lint guard (strings are kept). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function check(file, text, rules) {
  const rel = relative(root, file).split(sep).join("/");
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of rules) {
      if (re.test(line)) violations.push(`${rel}:${i + 1}: ${why}`);
    }
  });
}

const CODE = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const src = join(root, "src");

for (const file of walk(join(src, "router"), CODE)) {
  check(file, stripComments(readFileSync(file, "utf8")), [
    [/\bDate\b/, "router must be pure: use DecisionInput.now instead of Date"],
    [/\bMath\.random\b/, "router must be pure: Math.random is banned"],
    [/\bprocess\.env\b/, "router must be pure: process.env is banned"],
  ]);
}

const runnerDir = join(src, "runner") + sep;
for (const file of walk(src, CODE)) {
  if (file.startsWith(runnerDir)) continue;
  check(file, stripComments(readFileSync(file, "utf8")), [
    [/["'](node:)?child_process["']/, "only src/runner may use child_process"],
  ]);
}

for (const file of walk(join(root, ".github", "workflows"), [".yml", ".yaml"])) {
  check(file, readFileSync(file, "utf8"), [
    [/secrets\./, "workflows must not use secrets"],
    [/pull_request_target/, "workflows must not use pull_request_target"],
  ]);
}

if (violations.length > 0) {
  console.error(`Boundary violations (${violations.length}):\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log("Boundaries OK");
