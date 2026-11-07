/** Text rendering of doctor lines. */
import { type DoctorLine, type DoctorReport, summarize } from "./types.js";

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

/** Renders `lines` grouped by section (in order of first appearance), each with its fix. */
export function renderLines(lines: readonly DoctorLine[]): string {
  const sections: string[] = [];
  for (const l of lines) if (!sections.includes(l.section)) sections.push(l.section);
  let out = "";
  for (const section of sections) {
    out += `\n${section}\n`;
    for (const l of lines.filter((x) => x.section === section)) {
      const body = l.message.replaceAll("\n", "\n            ");
      out += `  ${MARK[l.status]}  ${l.id}: ${body}\n`;
      if (l.fix) out += `            fix: ${l.fix}\n`;
    }
  }
  return out;
}

/** The closing summary line. */
export function renderSummary(lines: readonly DoctorLine[]): string {
  const s = summarize(lines);
  return `\n${s.fail === 0 ? "Doctor OK" : "Doctor found problems"}: ${s.ok} ok, ${s.warn} warning(s), ${s.fail} failure(s)\n`;
}

/** Builds the `--json` report. */
export function buildReport(lines: DoctorLine[], live: boolean): DoctorReport {
  const summary = summarize(lines);
  const ok = summary.fail === 0;
  return { schemaVersion: 1, ok, exitCode: ok ? 0 : 4, summary, checks: lines, live };
}
