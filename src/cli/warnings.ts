/**
 * Process-warning filter of the CLI entry. `node:sqlite` is experimental and Node announces it on
 * stderr when the state database is first opened; that is noise for users. Only that one warning
 * is dropped, every other warning still prints.
 */

/** True for the ExperimentalWarning Node emits when `node:sqlite` loads. */
export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message);
}

/** The slice of `process` the filter uses; injectable for tests. */
export interface WarningTarget {
  pid: number;
  env: Readonly<Record<string, string | undefined>>;
  execArgv: readonly string[];
  stderr: { write(text: string): unknown };
  removeAllListeners(event: "warning"): unknown;
  on(event: "warning", listener: (warning: Error & { code?: string }) => void): unknown;
}

/**
 * Replaces Node's default `warning` listener with one that drops the SQLite ExperimentalWarning
 * and prints everything else in Node's own format. Does nothing when warnings are disabled
 * (`NODE_NO_WARNINGS=1` or `--no-warnings`), where Node's listener already stays silent.
 */
export function installWarningFilter(proc: WarningTarget = process): void {
  if (proc.env.NODE_NO_WARNINGS === "1" || proc.execArgv.includes("--no-warnings")) return;
  proc.removeAllListeners("warning");
  let hinted = false;
  proc.on("warning", (warning) => {
    if (isSqliteExperimentalWarning(warning)) return;
    const code = warning.code ? `[${warning.code}] ` : "";
    let text = `(node:${proc.pid}) ${code}${warning.name}: ${warning.message}\n`;
    if (!hinted) {
      hinted = true;
      text += "(Use `node --trace-warnings ...` to show where the warning was created)\n";
    }
    proc.stderr.write(text);
  });
}
