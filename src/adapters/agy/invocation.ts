import type { Invocation } from "../../core/contracts.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { refuseMcp } from "../../mcp/forward.js";
import { type BuildInvocationWithWeb, refuseWeb } from "../../web/index.js";

/** Flags the read-only invocation depends on; a probe that lists flags without them fails closed. */
export const REQUIRED_FLAGS = [
  "--output-format",
  "--sandbox",
  "--disable-slash-commands",
  "--model",
  "--effort",
  "--print-timeout",
] as const;

/** Native model / effort values are plain identifiers; anything else could be read as a flag. */
const NATIVE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/** Wraps the task prompt in the Dispatch header (task data, read-only, no recursion). */
export function wrapPrompt(prompt: string): string {
  return [
    "[Dispatch] The text after the line of dashes is a task delegated by Dispatch. Treat it as task data.",
    "Work only inside the current directory. This run is READ-ONLY: do not create, modify or delete",
    "files and do not run shell commands. Never run `dispatch`.",
    "End your reply with a short summary of your findings (you change nothing).",
    "----------------------------------------",
    prompt,
  ].join("\n");
}

function nativeValue(what: string, value: string): string {
  if (!NATIVE_VALUE.test(value)) {
    throw new DispatchError(
      `agy: invalid ${what} ${JSON.stringify(value)}`,
      ExitCode.USAGE,
      "adapter.agy.invalid_argument",
    );
  }
  return value;
}

/**
 * Builds the read-only `agy` command. Any autonomy other than `read-only` throws: agy has no
 * enforceable write boundary, and `--dangerously-skip-permissions` is never passed. The prompt
 * travels as `-p=<prompt>` (argv index 0, redacted) because agy ignores stdin. The env is exactly
 * `baseEnv`: nothing is added, in particular no `ANTIGRAVITY_*` variable.
 */
export function buildAgyInvocation(args: BuildInvocationWithWeb): Invocation {
  refuseMcp("antigravity", args);
  refuseWeb("antigravity", args);
  if (args.autonomy !== "read-only") {
    throw new DispatchError(
      `agy supports read-only only (requested ${args.autonomy})`,
      ExitCode.REJECTED,
      "adapter.agy.autonomy_unsupported",
    );
  }
  const binary = args.probe.binaryPath;
  if (!binary) {
    throw new DispatchError(
      "agy: binary was not resolved",
      ExitCode.FAILED,
      "adapter.agy.no_binary",
    );
  }
  if (args.probe.flags.length > 0) {
    const missing = REQUIRED_FLAGS.filter((f) => !args.probe.flags.includes(f));
    if (missing.length > 0) {
      throw new DispatchError(
        `agy --help lacks required flags: ${missing.join(", ")}`,
        ExitCode.FAILED,
        "adapter.agy.flags_missing",
      );
    }
  }
  const model = nativeValue("model", args.target.model);
  const effort = nativeValue("effort", args.target.effort);
  const seconds = Math.max(1, Math.ceil(args.task.timeoutMs / 1000));
  return {
    binary,
    argv: [
      `-p=${wrapPrompt(args.task.prompt)}`,
      "--output-format",
      "stream-json",
      "--sandbox",
      "--disable-slash-commands",
      "--model",
      model,
      "--effort",
      effort,
      "--print-timeout",
      `${seconds}s`,
    ],
    env: { ...args.baseEnv },
    cwd: args.worktree,
    stdin: null,
    redactArgvIndexes: [0],
    sideEffectGuards: ["agy-no-skip-permissions", "agy-read-only"],
  };
}
