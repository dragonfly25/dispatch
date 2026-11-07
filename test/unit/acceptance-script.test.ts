/** scripts/acceptance.mjs: groups a vitest JSON report by [UCn]/[ACn]/[SEC-*] tag (plan §3 CI). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../scripts/acceptance.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Status = "passed" | "failed" | "todo" | "skipped";
interface Fake {
  name: string;
  status: Status;
}

/** One passing test per UC and per tagged AC (AC1 and AC6 are derived), plus `extra`. */
function everything(extra: Fake[] = [], drop: string[] = []): Fake[] {
  const tags = [
    ...Array.from({ length: 14 }, (_, i) => `UC${i + 1}`),
    "AC2",
    "AC3",
    "AC4",
    "AC5",
    "AC7",
  ].filter((t) => !drop.includes(t));
  return [
    ...tags.map((t) => ({ name: `[${t}] works`, status: "passed" as const })),
    { name: "[SEC-env] canary", status: "passed" },
    ...extra,
  ];
}

function run(tests: Fake[]) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-acc-"));
  dirs.push(dir);
  const file = join(dir, "r.json");
  const count = (s: Status) => tests.filter((t) => t.status === s).length;
  writeFileSync(
    file,
    JSON.stringify({
      numTotalTests: tests.length,
      numPassedTests: count("passed"),
      numFailedTests: count("failed"),
      numTodoTests: count("todo"),
      testResults: [
        {
          assertionResults: tests.map((t) => ({
            ancestorTitles: ["suite"],
            fullName: `suite ${t.name}`,
            title: t.name,
            status: t.status,
          })),
        },
      ],
    }),
  );
  const r = spawnSync(process.execPath, [script, "--results", file, "--json"], {
    encoding: "utf8",
  });
  const out = JSON.parse(r.stdout) as {
    uc: { id: string; status: string; passed: number; total: number; note: string }[];
    ac: { id: string; status: string; note: string }[];
    security: { id: string; status: string }[];
    failed: boolean;
  };
  const text = spawnSync(process.execPath, [script, "--results", file], { encoding: "utf8" });
  return { code: r.status, out, markdown: text.stdout };
}

describe("[AC1] scripts/acceptance.mjs", () => {
  it("all tags passing (and the docs present) gives PASS everywhere and exit 0", () => {
    const { code, out, markdown } = run(everything());
    expect(code).toBe(0);
    expect(out.uc).toHaveLength(14);
    expect(out.ac).toHaveLength(7);
    expect([...out.uc, ...out.ac].map((r) => r.status)).toEqual(Array(21).fill("PASS"));
    expect(out.security).toEqual([
      { id: "SEC-env", passed: 1, total: 1, status: "PASS", failures: [] },
    ]);
    expect(markdown).toContain("| UC1 | First setup on an existing repo | 1/1 | PASS |");
    expect(markdown).toContain("| AC6 |");
    expect(markdown).toContain("**22 PASS, 0 PENDING, 0 FAIL**");
  });

  it("a failing tagged test makes its row (and AC1) FAIL and the exit code 1", () => {
    const { code, out, markdown } = run(everything([{ name: "[UC4] broken", status: "failed" }]));
    expect(code).toBe(1);
    expect(out.uc.find((r) => r.id === "UC4")).toMatchObject({
      status: "FAIL",
      passed: 1,
      total: 2,
    });
    expect(out.ac.find((r) => r.id === "AC1")?.status).toBe("FAIL");
    expect(markdown).toContain("- UC4: suite [UC4] broken");
  });

  it("todo tests are PENDING, not FAIL: exit 0, and a tag nobody tests is FAIL", () => {
    const pending = run(everything([{ name: "[UC3] pending WP27: x", status: "todo" }]));
    expect(pending.code).toBe(0);
    expect(pending.out.uc.find((r) => r.id === "UC3")).toMatchObject({
      status: "PENDING",
      total: 2,
    });
    expect(pending.out.ac.find((r) => r.id === "AC1")?.status).toBe("PENDING");
    expect(pending.markdown).toContain("PENDING = tests are written but marked `todo`");

    const missing = run(everything([], ["UC9", "AC5"]));
    expect(missing.code).toBe(1);
    expect(missing.out.uc.find((r) => r.id === "UC9")).toMatchObject({
      status: "FAIL",
      note: "no test carries this tag",
    });
    expect(missing.out.ac.find((r) => r.id === "AC5")?.status).toBe("FAIL");
  });

  it("skipped tests are reported but neither pass nor fail a row; several tags per test count each", () => {
    const { out } = run(
      everything([
        { name: "[UC10] needs python", status: "skipped" },
        { name: "[UC2][UC3][SEC-env] shared", status: "passed" },
      ]),
    );
    expect(out.uc.find((r) => r.id === "UC10")).toMatchObject({ status: "PASS", total: 1 });
    expect(out.uc.find((r) => r.id === "UC2")).toMatchObject({ passed: 2, total: 2 });
    expect(out.uc.find((r) => r.id === "UC3")).toMatchObject({ passed: 2, total: 2 });
    expect(out.security).toMatchObject([{ id: "SEC-env", passed: 2, total: 2 }]);
  });
});
