#!/usr/bin/env node
// Acceptance report (plan §3 "CI", §8 Definition of done): runs the whole vitest suite (unit,
// test/e2e, test/security), groups the results by the tags in the test names ([UCn], [ACn],
// [SEC-x]) and prints one markdown table: UC1-UC14, AC1-AC7, then the security tags.
//
//   node scripts/acceptance.mjs                    run vitest, print the report
//   node scripts/acceptance.mjs --results r.json   read a vitest JSON report instead of running
//   node scripts/acceptance.mjs --out report.md    also write the markdown to a file
//   node scripts/acceptance.mjs --json             print the machine-readable summary instead
//
// Status of a row: FAIL when a tagged test failed or no test carries the tag; PENDING when every
// tagged test passes but some are `todo` (written, waiting for a work package or a real
// account); PASS otherwise. Skipped tests (opt-in perf runs, no python3) are listed but neither
// pass nor fail a row. Exit code 1 on any FAIL. AC1 is derived from UC1-UC14, AC6 from the
// documentation files; AC2-AC5 and AC7 map to their tags.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const USE_CASES = {
  UC1: "First setup on an existing repo",
  UC2: "Automatic delegation from Claude Code (soft)",
  UC3: "Same from Codex (hard interception)",
  UC4: "Fallback on quota",
  UC5: "Pinned task",
  UC6: "Unspecified model",
  UC7: "Second opinion",
  UC8: "Experimenting across profiles",
  UC9: "Collaborator without Dispatch",
  UC10: "Use without a host",
  UC11: "Broken quota channel",
  UC12: "Second account / API pool",
  UC13: "Timeout and a patch that does not apply",
  UC14: "Uninstall",
};

export const CRITERIA = {
  AC1: "UC1-UC14 pass (automated; real-account parts documented)",
  AC2: "install + uninstall leave the repo identical",
  AC3: "Every routing decision is reproducible (explain) and logged",
  AC4: "Works with every quota reader disabled",
  AC5: "A collaborator without Dispatch notices nothing",
  AC6: "English documentation: README, configuration reference, two guides",
  AC7: "No credential copied, logged or transmitted",
};

/** Files AC6 requires, non-empty. */
export const DOC_FILES = [
  "README.md",
  "docs/configuration.md",
  "docs/guides/writing-an-adapter.md",
  "docs/guides/writing-a-host-integration.md",
];

const TAG = /\[(UC\d+|AC\d+|SEC-[A-Za-z0-9-]+)\]/g;

/** Tags found in a test's full name (describe titles + title); each once. */
export function tagsOf(text) {
  return [...new Set([...text.matchAll(TAG)].map((m) => m[1]))];
}

const emptyCounts = () => ({ passed: 0, failed: 0, todo: 0, skipped: 0, failures: [] });

/** Groups a vitest JSON report by tag: `{ tag: { passed, failed, todo, skipped, failures } }`. */
export function groupByTag(report) {
  const groups = {};
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const name = t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(" ");
      for (const tag of tagsOf(name)) {
        groups[tag] ??= emptyCounts();
        const g = groups[tag];
        if (t.status === "passed") g.passed += 1;
        else if (t.status === "failed") {
          g.failed += 1;
          g.failures.push(name);
        } else if (t.status === "todo") g.todo += 1;
        else g.skipped += 1;
      }
    }
  }
  return groups;
}

/** AC6: how many of the documentation files exist and are not empty. */
export function docsCounts(root = ROOT, files = DOC_FILES) {
  const bad = files.filter((f) => {
    const p = join(root, f);
    return !(existsSync(p) && statSync(p).isFile() && readFileSync(p, "utf8").trim() !== "");
  });
  return { ok: files.length - bad.length, total: files.length, missing: bad };
}

const statusOf = (c) => {
  if (c.failed > 0) return "FAIL";
  if (c.passed + c.todo === 0) return "FAIL";
  return c.todo > 0 ? "PENDING" : "PASS";
};

const rank = { FAIL: 2, PENDING: 1, PASS: 0 };

/** Rows for the report: UC1-UC14, then AC1-AC7 (AC1 from the UC rows, AC6 from the docs). */
export function buildRows(groups, docs, manualExists = () => false) {
  const rowFor = (id, title) => {
    const c = groups[id] ?? emptyCounts();
    const total = c.passed + c.failed + c.todo;
    return {
      id,
      title,
      passed: c.passed,
      total,
      skipped: c.skipped,
      status: statusOf(c),
      note: total === 0 ? "no test carries this tag" : c.failures.length ? "failing tests" : "",
      failures: c.failures,
      manual: manualExists(id) ? `docs/manual-tests/${id}.md` : "",
    };
  };
  const uc = Object.entries(USE_CASES).map(([id, title]) => rowFor(id, title));
  const ac = Object.entries(CRITERIA).map(([id, title]) => {
    if (id === "AC1") {
      const worst = uc.reduce((w, r) => (rank[r.status] > rank[w] ? r.status : w), "PASS");
      return {
        id,
        title,
        passed: uc.filter((r) => r.status === "PASS").length,
        total: uc.length,
        skipped: 0,
        status: worst,
        note: worst === "PASS" ? "" : "see the UC rows",
        failures: [],
        manual: "",
      };
    }
    if (id === "AC6") {
      // The documentation files count as checks of their own, next to any [AC6]-tagged test.
      const c = groups.AC6 ?? emptyCounts();
      const failed = c.failed > 0 || docs.missing.length > 0;
      return {
        id,
        title,
        passed: c.passed + docs.ok,
        total: c.passed + c.failed + c.todo + docs.total,
        skipped: c.skipped,
        status: failed ? "FAIL" : c.todo > 0 ? "PENDING" : "PASS",
        note: docs.missing.length > 0 ? `missing or empty: ${docs.missing.join(", ")}` : "",
        failures: c.failures,
        manual: "",
      };
    }
    return rowFor(id, title);
  });
  return { uc, ac };
}

/** Rows for every `[SEC-*]` tag found, sorted by name. */
export function securityRows(groups) {
  return Object.keys(groups)
    .filter((t) => t.startsWith("SEC-"))
    .sort()
    .map((id) => {
      const c = groups[id];
      return {
        id,
        passed: c.passed,
        total: c.passed + c.failed + c.todo,
        status: statusOf(c),
        failures: c.failures,
      };
    });
}

const cell = (s) => String(s).replaceAll("|", "\\|");

/** The markdown report. */
export function renderMarkdown({ uc, ac }, sec, meta = {}) {
  const lines = ["## Dispatch acceptance report", ""];
  const table = (rows, withTitle) => {
    lines.push(
      withTitle
        ? "| ID | Requirement | Pass/total | Status | Manual script | Notes |"
        : "| Tag | Pass/total | Status |",
      withTitle ? "|---|---|---|---|---|---|" : "|---|---|---|",
    );
    for (const r of rows) {
      lines.push(
        withTitle
          ? `| ${r.id} | ${cell(r.title)} | ${r.passed}/${r.total} | ${r.status} | ${r.manual} | ${cell(
              [r.note, r.skipped ? `${r.skipped} skipped` : ""].filter(Boolean).join("; "),
            )} |`
          : `| ${r.id} | ${r.passed}/${r.total} | ${r.status} |`,
      );
    }
    lines.push("");
  };
  lines.push("### Use cases (spec §11)", "");
  table(uc, true);
  lines.push("### Acceptance criteria (spec §12)", "");
  table(ac, true);
  if (sec.length > 0) {
    lines.push("### Security suite tags", "");
    table(sec, false);
  }
  const all = [...uc, ...ac, ...sec];
  const count = (s) => all.filter((r) => r.status === s).length;
  lines.push(
    `**${count("PASS")} PASS, ${count("PENDING")} PENDING, ${count("FAIL")} FAIL**` +
      (meta.totals ? ` (${meta.totals})` : ""),
    "",
  );
  const failing = all.filter((r) => r.failures?.length);
  if (failing.length > 0) {
    lines.push("Failing tests:", "");
    for (const r of failing) for (const f of r.failures) lines.push(`- ${r.id}: ${f}`);
    lines.push("");
  }
  if (count("PENDING") > 0) {
    lines.push(
      "PENDING = tests are written but marked `todo` (waiting for a work package or a real account).",
      "",
    );
  }
  return `${lines.join("\n")}`;
}

/** True when anything is FAIL. */
export const hasFailure = ({ uc, ac }, sec) =>
  [...uc, ...ac, ...sec].some((r) => r.status === "FAIL");

function parseArgs(argv) {
  const opts = { results: null, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--results") opts.results = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function runVitest() {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-acceptance-"));
  const file = join(dir, "vitest.json");
  // vitest's own entry under this node: no `pnpm` lookup, which on Windows is a .cmd that
  // spawnSync cannot start without a shell.
  const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const r = spawnSync(
    process.execPath,
    [vitest, "run", "--reporter=json", `--outputFile=${file}`],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: process.env },
  );
  try {
    if (!existsSync(file)) {
      throw new Error(`vitest produced no report (exit ${r.status ?? r.signal})`);
    }
    return JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = opts.results ? JSON.parse(readFileSync(opts.results, "utf8")) : runVitest();
  const groups = groupByTag(report);
  const rows = buildRows(groups, docsCounts(), (id) =>
    existsSync(join(ROOT, "docs", "manual-tests", `${id}.md`)),
  );
  const sec = securityRows(groups);
  const totals = `${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ${
    report.numTodoTests ?? 0
  } todo of ${report.numTotalTests ?? 0} tests`;
  const failed = hasFailure(rows, sec) || (report.numFailedTests ?? 0) > 0;
  const markdown = renderMarkdown(rows, sec, { totals });
  if (opts.json)
    process.stdout.write(`${JSON.stringify({ ...rows, security: sec, failed }, null, 2)}\n`);
  else process.stdout.write(`${markdown}\n`);
  if (opts.out) writeFileSync(opts.out, `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if ((report.numFailedTests ?? 0) > 0 && !hasFailure(rows, sec)) {
    process.stderr.write(
      `acceptance: ${report.numFailedTests} test(s) failed outside the tagged rows\n`,
    );
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`acceptance: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
