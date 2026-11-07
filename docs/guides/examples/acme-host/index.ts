import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../../../src/core/contracts.js";
import {
  type DoctorCheck,
  hostPresent,
  registerDoctorCheck,
  registerHost,
} from "../../../../src/hosts/_framework/index.js";
import { renderHookCommand } from "../../../../src/platform/launcher.js";
import { hookHandlers } from "./hook.js";

// `HostIntegration["id"]` is the closed union "claude-code" | "codex" (frozen contract, ADR 0002).
// A real third host first amends that union through a new ADR; the cast only keeps this example
// type-checking.
const ID = "acme" as unknown as HostIntegration["id"];
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** User-scope files only: everything lives under the user's home, never in a repository. */
function paths(ctx: HostPlanContext) {
  return {
    hooks: join(ctx.home, ".acme", "hooks.json"),
    skill: join(ctx.home, ".acme", "skills", "dispatch", "SKILL.md"),
  };
}

function hookCommand(ctx: HostPlanContext, event: string): string {
  return renderHookCommand({
    nodePath: ctx.nodePath,
    hookPath: ctx.hookPath,
    host: ID,
    event,
  });
}

export const acmeHost: HostIntegration = {
  id: ID,
  subagentStrategy: "none", // soft mode: the host cannot be made to redirect its own sub-agents
  subagentMatcher: null,
  waitTimeoutSec: 100, // must stay below the host's shell-tool timeout
  detectSelf(env) {
    // Environment only, never the PATH binary (a desktop app bundles its own CLI version).
    return env.ACME_SESSION_ID ? { host: "acme", version: env.ACME_VERSION ?? null } : null;
  },
  async detect(ctx) {
    return hostPresent({ home: ctx.home, binary: "acme", dir: ".acme", env: process.env });
  },
  /** Pure: returns the edits, writes nothing. `setup` previews, applies and records them. */
  plan(ctx): EditOp[] {
    const p = paths(ctx);
    const command = hookCommand(ctx, "SessionStart");
    const skill = `# Dispatch\n\nTo delegate a task run \`${ctx.launcherPath} run --detach --json --task '<task>'\`.\n`;
    return [
      {
        file: p.hooks,
        kind: "json-entry",
        signature: command, // a string inside the appended element identifies it for removal
        content: JSON.stringify({
          path: ["hooks", "SessionStart"],
          mode: "append",
          value: { hooks: [{ type: "command", command, timeout: 5 }] },
        }),
        trustGrant: null,
      },
      {
        file: p.skill, // a new file in Dispatch's own folder; no existing skill is touched
        kind: "new-file",
        signature: p.skill,
        content: skill,
        mode: "0644",
        sha256: sha256(skill),
        trustGrant: null,
      },
    ];
  },
  hookHandlers,
};

/** Doctor checks are read-only: no quota, no writes to host files. */
export const acmeHooksCheck: DoctorCheck = {
  id: "acme.hooks-installed",
  run(ctx) {
    try {
      const text = readFileSync(join(ctx.home, ".acme", "hooks.json"), "utf8");
      return text.includes("SessionStart")
        ? { status: "ok", message: "acme SessionStart hook present" }
        : { status: "warn", message: "no SessionStart hook", fix: "dispatch setup --refresh" };
    } catch {
      return { status: "warn", message: "acme hooks.json not found", fix: "dispatch setup" };
    }
  },
};

// Registration: one line each in src/hosts/index.ts (`builtinRegistry`).
export function registerAcme(): void {
  registerHost(acmeHost);
  registerDoctorCheck(acmeHooksCheck);
}
