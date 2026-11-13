/** `doctor --from-host`: what a call made from inside Claude Code or Codex needs. */
import { join } from "node:path";
import type { AppEnv } from "../app/context.js";
import { CODEX_WINDOWS_NO_RULES, codexRulesSupported } from "../hosts/codex/integration.js";
import { CODEX_SANDBOX_MESSAGE, codexSandboxActive, detectHost } from "../platform/host.js";
import type { OsPlatform } from "../platform/os.js";
import { probeWritable } from "./system.js";
import { type DoctorLine, mkLine } from "./types.js";

/**
 * When a host launched this process, its state directory must be writable and the Codex rule must
 * have matched (`CODEX_SANDBOX` unset); otherwise the run would fail inside the host.
 */
export function fromHostLines(
  env: AppEnv,
  dispatchHome: string,
  platform: OsPlatform = process.platform,
): DoctorLine[] {
  const det = detectHost(env);
  if (det.host === null) {
    return [
      mkLine(
        "warn",
        "host",
        "host.detected",
        "no host detected (CLAUDECODE and CODEX_THREAD_ID are unset): --from-host checks what an agent's call needs, so run it from inside Claude Code or Codex",
      ),
    ];
  }
  const lines = [
    mkLine(
      "ok",
      "host",
      "host.detected",
      `running inside ${det.host} (${det.evidence.join(", ")})`,
    ),
  ];
  const state = join(dispatchHome, "state");
  const problem = probeWritable(state);
  lines.push(
    problem === null
      ? mkLine("ok", "host", "host.state-writable", `${state} is writable from this host`)
      : mkLine(
          "fail",
          "host",
          "host.state-writable",
          `${state} is not writable from this host: ${problem}`,
          {
            fix:
              det.host === "codex"
                ? "allow writes to ~/.dispatch in the Codex sandbox, or fix ~/.codex/rules/dispatch.rules"
                : "grant the host write access to ~/.dispatch",
          },
        ),
  );
  if (codexSandboxActive(env) && !codexRulesSupported(platform)) {
    lines.push(
      mkLine(
        "fail",
        "host",
        "host.codex-rule",
        `running inside the Codex sandbox: ${CODEX_WINDOWS_NO_RULES}`,
        {
          fix: "approve running the Dispatch command outside the sandbox when Codex asks",
        },
      ),
    );
  } else if (codexSandboxActive(env)) {
    lines.push(
      mkLine("fail", "host", "host.codex-rule", CODEX_SANDBOX_MESSAGE, {
        fix: "call the absolute launcher with a single-quoted task; make sure ~/.codex/rules/dispatch.rules exists (`dispatch setup --refresh`) and approve the Dispatch hooks in Codex `/hooks`",
      }),
    );
  } else if (det.host === "codex") {
    lines.push(
      mkLine(
        "ok",
        "host",
        "host.codex-rule",
        "CODEX_SANDBOX is not set: the Codex rule matched this call",
      ),
    );
  }
  return lines;
}
