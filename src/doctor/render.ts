/** Text rendering of doctor lines. */
import { columns, padVisible, plainUi, tildifyText, type Ui } from "../cli/ui.js";
import { type DoctorLine, type DoctorReport, summarize } from "./types.js";

/** Presentation options of {@link renderLines}. */
export interface RenderOptions {
  /** Colors and symbols (default: plain text). */
  ui?: Ui;
  /** Show the detail and fix of every check, not only of warnings and failures. */
  verbose?: boolean;
  /** Home directory, shown as `~` in paths. */
  home?: string | undefined;
}

const INDENT = "      ";

/**
 * Renders `lines` grouped by section (in order of first appearance): one compact line per check
 * (symbol, id, first line of the message). The rest of the message and the fix follow only for
 * warnings and failures, or for every check with `verbose`.
 */
export function renderLines(lines: readonly DoctorLine[], opts: RenderOptions = {}): string {
  const ui = opts.ui ?? plainUi;
  const sections: string[] = [];
  for (const l of lines) if (!sections.includes(l.section)) sections.push(l.section);
  let out = "";
  for (const section of sections) {
    out += `\n${ui.bold(section)}\n`;
    const group = lines.filter((x) => x.section === section);
    const heads = columns(
      group.map((l) => {
        const [first = ""] = tildifyText(l.message, opts.home).split("\n");
        return [
          `  ${padVisible(ui.mark(l.status), ui.enabled ? 1 : 4)}`,
          l.status === "ok" ? l.id : ui.tone(l.status, l.id),
          first,
        ];
      }),
    );
    group.forEach((l, i) => {
      out += `${heads[i]}\n`;
      if (l.status === "ok" && !opts.verbose) return;
      // Continuation lines and fixes are often meant to be copied (permission rules, commands with
      // absolute launcher paths), so they keep the exact paths: `~` would not match at runtime.
      const rest = l.message.split("\n").slice(1);
      for (const d of rest) out += `${INDENT}${ui.dim(d)}\n`;
      if (l.fix) out += `${INDENT}${ui.cyan("fix:")} ${l.fix}\n`;
    });
  }
  return out;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The closing summary line: `✔ N ok · ⚠ N warnings · ✖ N failures`. */
export function renderSummary(lines: readonly DoctorLine[], ui: Ui = plainUi): string {
  const s = summarize(lines);
  if (ui.enabled) {
    const parts = [
      ui.tone("ok", `${ui.sym.ok} ${s.ok} ok`),
      (s.warn > 0 ? (t: string) => ui.tone("warn", t) : ui.dim)(
        `${ui.sym.warn} ${plural(s.warn, "warning")}`,
      ),
      (s.fail > 0 ? (t: string) => ui.tone("fail", t) : ui.dim)(
        `${ui.sym.fail} ${plural(s.fail, "failure")}`,
      ),
    ];
    return `\n${parts.join(ui.dim(" · "))}\n`;
  }
  const head = s.fail === 0 ? "Doctor OK" : "Doctor found problems";
  return `\n${head}: ${s.ok} ok, ${plural(s.warn, "warning")}, ${plural(s.fail, "failure")}\n`;
}

/** Builds the `--json` report. */
export function buildReport(lines: DoctorLine[], live: boolean): DoctorReport {
  const summary = summarize(lines);
  const ok = summary.fail === 0;
  return { schemaVersion: 1, ok, exitCode: ok ? 0 : 4, summary, checks: lines, live };
}
