/**
 * Run directory and its `events.jsonl` log. The run directory lives inside the repo
 * (`<repo>/.dispatch/state/runs/<runId>/`, git-ignored by `.dispatch/.gitignore`) so hosts can read
 * the patch without a permission prompt (docs/spikes/hosts-prototype.md, finding 5). Without a
 * `.dispatch/` folder (no install, UC10) it falls back to `<dispatchHome>/runs/<runId>/`.
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactDeep } from "../state/redact.js";

/** File name of the per-run event log. */
export const EVENTS_FILE = "events.jsonl";

/** Picks (and creates, mode 0700) the run directory; see the module comment. */
export function resolveRunDir(repoRoot: string, dispatchHome: string, runId: string): string {
  const repoDispatch = join(repoRoot, ".dispatch");
  const inRepo = existsSync(repoDispatch) && statSync(repoDispatch).isDirectory();
  const dir = inRepo
    ? join(repoDispatch, "state", "runs", runId)
    : join(dispatchHome, "runs", runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Append-only JSONL log of a run. Every record is redacted before it is written. */
export class RunLog {
  readonly path: string;

  constructor(
    runDir: string,
    private readonly secrets: () => readonly string[],
  ) {
    this.path = join(runDir, EVENTS_FILE);
  }

  /** Appends one record; logging failures never break the run. */
  write(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(redactDeep(record, this.secrets()))}\n`, {
        mode: 0o600,
      });
    } catch {
      // best effort
    }
  }
}
