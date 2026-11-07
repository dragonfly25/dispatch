/** Hosts Dispatch can run inside of. */
export type DetectedHost = "claude-code" | "codex" | "antigravity";

/** Result of {@link detectHost}. */
export interface HostDetection {
  /** The host the current process runs under, or null when none is detected. */
  host: DetectedHost | null;
  /** The host's session id, when its env exposes one. */
  sessionId?: string;
  /** Nesting depth from `DISPATCH_DEPTH` (0 when unset). */
  depth: number;
  /** Human-readable list of the env markers that matched (for `doctor`). */
  evidence: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/** Reads a non-empty env value. */
function get(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Parses `DISPATCH_DEPTH`. Unset or empty is 0. A set but unparsable value counts as depth 1:
 * anything that set the variable is a Dispatch child, so it must never be treated as top level.
 */
export function parseDepth(env: Env): number {
  const raw = get(env, "DISPATCH_DEPTH");
  if (raw === undefined) return 0;
  return /^\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : 1;
}

/**
 * Detects the host from environment variables only (never from the PATH binary, see
 * docs/spikes/hosts.md). When several markers are present (a host started from inside another),
 * the first of Claude Code, Codex, Antigravity wins and every marker is listed in `evidence`.
 */
export function detectHost(env: Env): HostDetection {
  const found: { host: DetectedHost; sessionId?: string; evidence: string[] }[] = [];

  if (get(env, "CLAUDECODE") === "1") {
    const sessionId = get(env, "CLAUDE_CODE_SESSION_ID");
    found.push({
      host: "claude-code",
      ...(sessionId ? { sessionId } : {}),
      evidence: ["CLAUDECODE=1", ...(sessionId ? ["CLAUDE_CODE_SESSION_ID"] : [])],
    });
  }

  const threadId = get(env, "CODEX_THREAD_ID");
  const codexSession = threadId ?? get(env, "CODEX_SESSION_ID");
  if (codexSession !== undefined) {
    found.push({
      host: "codex",
      sessionId: codexSession,
      evidence: [threadId !== undefined ? "CODEX_THREAD_ID" : "CODEX_SESSION_ID"],
    });
  }

  if (get(env, "ANTIGRAVITY_AGENT") === "1") {
    found.push({ host: "antigravity", evidence: ["ANTIGRAVITY_AGENT=1"] });
  }

  const depth = parseDepth(env);
  const depthEvidence = get(env, "DISPATCH_DEPTH") === undefined ? [] : ["DISPATCH_DEPTH"];
  const first = found[0];
  if (first === undefined) return { host: null, depth, evidence: depthEvidence };

  const result: HostDetection = {
    host: first.host,
    depth,
    evidence: [...found.flatMap((f) => f.evidence), ...depthEvidence],
  };
  if (first.sessionId !== undefined) result.sessionId = first.sessionId;
  return result;
}

/**
 * True when running inside a sandboxed Codex shell (`CODEX_SANDBOX` set). Then the Codex rules
 * file did not match the launcher invocation and the run would fail without network.
 */
export function codexSandboxActive(env: Env): boolean {
  return get(env, "CODEX_SANDBOX") !== undefined;
}

/** Message printed when {@link codexSandboxActive} is true. */
export const CODEX_SANDBOX_MESSAGE =
  "running inside the Codex sandbox: the Codex rules file did not match this command, " +
  "so it has no network access. Call the absolute launcher path (~/.dispatch/bin/dispatch, " +
  "written by `dispatch setup`) with single quotes and without `cd`, pipes or `$`, so the " +
  "rule in ~/.codex/rules/dispatch.rules matches.";
