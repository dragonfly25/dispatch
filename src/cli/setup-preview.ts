/**
 * The plan preview of `dispatch setup`: every change grouped by destination (Dispatch, Claude
 * Code, Codex) with `~/` paths, then the trust grants (a short plain-language line per host and
 * the exact grant text), then which hosts were found.
 */
import { describeOp, type SetupPlan } from "../hosts/_framework/index.js";
import { plainUi, tildify, tildifyText, type Ui } from "./ui.js";

/** Display name of a plan group. */
const GROUP_LABEL: Record<string, string> = {
  dispatch: "Dispatch",
  browser: "Isolated browser",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** What each host's trust grants mean, in one sentence. */
const GRANT_SUMMARY: Record<string, string> = {
  browser:
    "Delegated agents that use the Claude desktop browser tools get an isolated Chrome (temporary empty profile) on codex.",
  "claude-code": "Claude Code loads the Dispatch plugin (a sub-agent and a hook) in every session.",
  codex:
    "Codex may run the Dispatch launcher outside its sandbox, and runs the Dispatch hooks once you approve them with /hooks.",
};

/** The global config setup is about to write. */
export interface ConfigPreview {
  path: string;
  mode: "create" | "update";
  lines: string[];
  /** Trust grants the config change records (e.g. MCP forwarding), shown with the host grants. */
  grants?: string[];
}

/** Rendered preview parts; `grants` is empty when nothing grants extra authority. */
export interface PlanPreview {
  changes: string;
  grants: string;
}

/** Renders the preview of `plan` (and of the global config `change`, if any). */
export function renderPlanPreview(
  plan: Pick<SetupPlan, "groups" | "stale" | "detected" | "absent">,
  change: ConfigPreview | null,
  opts: { ui?: Ui; home?: string | undefined } = {},
): PlanPreview {
  const ui = opts.ui ?? plainUi;
  const home = opts.home;
  const label = (host: string) => ui.bold(GROUP_LABEL[host] ?? host);
  const lines = ["Dispatch setup will make these changes:"];
  for (const g of plan.groups) {
    lines.push("", label(g.host));
    if (g.host === "dispatch" && change) {
      lines.push(`  ${ui.green("+")} Global config: ${change.mode} ${tildify(change.path, home)}`);
      for (const l of change.lines) lines.push(`      ${ui.dim(l)}`);
    }
    for (const op of g.ops) lines.push(`  ${ui.green("+")} ${tildifyText(describeOp(op), home)}`);
  }
  if (plan.stale.length > 0) {
    lines.push("", ui.bold("No longer planned"));
    for (const e of plan.stale) {
      lines.push(
        `  ${ui.yellow("-")} remove the earlier Dispatch edit in ${tildify(e.file, home)}`,
      );
    }
  }
  lines.push("");
  if (plan.detected.length > 0) lines.push(`Hosts detected: ${plan.detected.join(", ")}`);
  if (plan.absent.length > 0) {
    lines.push(ui.dim(`Hosts not found (nothing is written for them): ${plan.absent.join(", ")}`));
  }

  const grants: string[] = [];
  const lead = ui.enabled ? `${ui.mark("warn")} ` : "  ";
  for (const grant of change?.grants ?? []) {
    grants.push(`${lead}${ui.bold("Dispatch:")}`, ui.dim(`    ${grant}`));
  }
  for (const g of plan.groups) {
    const granting = g.ops.filter((op) => op.trustGrant !== null);
    if (granting.length === 0) continue;
    grants.push(`${lead}${ui.bold(GRANT_SUMMARY[g.host] ?? `${label(g.host)}:`)}`);
    for (const op of granting) {
      grants.push(
        ui.dim(`    ${tildify(op.file, home)}: ${tildifyText(op.trustGrant ?? "", home)}`),
      );
    }
  }
  return {
    changes: `${lines.join("\n")}\n`,
    grants:
      grants.length === 0
        ? ""
        : `${["Trust grants (they give a host extra authority; read them carefully):", ...grants].join("\n")}\n`,
  };
}

/** The hints printed once setup is applied. */
export function setupNextSteps(detected: readonly string[]): [string, string][] {
  return [
    ...(detected.includes("codex")
      ? ([["codex → /hooks", "approve the two Dispatch hooks in Codex"]] as [string, string][])
      : []),
    ["dispatch install", "in a git repository, to turn delegation on there"],
    ["new session", "start a new Claude Code / Codex session to load the integration"],
    ["dispatch doctor", "check the CLIs, logins and hooks"],
  ];
}
