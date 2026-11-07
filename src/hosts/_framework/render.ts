/**
 * Rendering helpers for host assets (`assets/hosts/<host>/…`) and small detection helpers that
 * host integrations (WP22 claude-code, WP27 codex) use to build their {@link EditOp} lists.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { assetsDir } from "../../config/paths.js";
import type { EditOp, HostIntegration, HostPlanContext } from "../../core/contracts.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { renderHookCommand } from "../../platform/launcher.js";
import { type ResolveFs, resolveBinary } from "../../platform/resolve.js";
import { sha256 } from "./fsutil.js";

/** Placeholder values understood by the host templates (see docs/spikes/hosts-prototype.md §4). */
export interface TemplateValues {
  LAUNCHER: string;
  WAIT_TIMEOUT: string;
  VERSION: string;
  HOOK_COMMAND_SESSION_START: string;
  HOOK_COMMAND_PRE_TOOL_USE: string;
}

/**
 * Replaces `{{NAME}}` placeholders. With `jsonEscape` (`.json` and `.tmpl` files) values are
 * escaped as JSON string contents. An unknown placeholder is an error, never left in place.
 */
export function renderTemplate(
  text: string,
  values: Readonly<Record<string, string>>,
  jsonEscape: boolean,
): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) {
      throw new DispatchError(`unknown template placeholder {{${name}}}`, ExitCode.FAILED);
    }
    return jsonEscape ? JSON.stringify(v).slice(1, -1) : v;
  });
}

/** Template values for `host`, derived from the plan context. */
export function templateValues(
  ctx: HostPlanContext,
  host: Pick<HostIntegration, "id" | "waitTimeoutSec">,
): TemplateValues {
  const hook = (event: string) =>
    renderHookCommand({ nodePath: ctx.nodePath, hookPath: ctx.hookPath, host: host.id, event });
  return {
    LAUNCHER: ctx.launcherPath,
    WAIT_TIMEOUT: String(host.waitTimeoutSec),
    VERSION: pkg.version,
    HOOK_COMMAND_SESSION_START: hook("SessionStart"),
    HOOK_COMMAND_PRE_TOOL_USE: hook("PreToolUse"),
  };
}

/** Reads and renders `assets/hosts/<rel>`; escaping follows the file extension. */
export function renderHostAsset(
  rel: string,
  values: TemplateValues,
  root: string = join(assetsDir(), "hosts"),
): string {
  const text = readFileSync(join(root, rel), "utf8");
  return renderTemplate(text, { ...values }, rel.endsWith(".json") || rel.endsWith(".tmpl"));
}

/**
 * The Dispatch home (`~/.dispatch` or `$DISPATCH_HOME`), derived from the launcher path
 * `<home>/bin/dispatch` so host integrations need nothing beyond {@link HostPlanContext}.
 */
export function dispatchHomeOf(ctx: HostPlanContext): string {
  return dirname(dirname(ctx.launcherPath));
}

/**
 * Permanent directory for a host's rendered assets, `~/.dispatch/hosts/<host>/`. The Claude
 * plugin runs from its marketplace dir, so it must never live in a temp dir.
 */
export function hostAssetDir(ctx: HostPlanContext, hostId: string): string {
  return join(dispatchHomeOf(ctx), "hosts", hostId);
}

/** One rendered asset to write: template path (under assets/hosts) → absolute destination. */
export interface AssetCopy {
  template: string;
  dest: string;
  mode?: string;
  trustGrant?: string | null;
  kind?: "new-file" | "rules-file";
}

/** Builds `new-file`/`rules-file` ops for rendered assets (signature = destination path). */
export function assetOps(values: TemplateValues, copies: readonly AssetCopy[], root?: string) {
  return copies.map((c): EditOp => {
    const content = renderHostAsset(c.template, values, root);
    return {
      file: c.dest,
      kind: c.kind ?? "new-file",
      signature: c.dest,
      content,
      mode: c.mode ?? "0644",
      sha256: sha256(content),
      trustGrant: c.trustGrant ?? null,
    };
  });
}

/** Options of {@link hostPresent}. */
export interface PresenceOptions {
  home: string;
  binary: string;
  /** Host config dir name under HOME, e.g. ".claude" or ".codex". */
  dir: string;
  env: Readonly<Record<string, string | undefined>>;
  fs?: ResolveFs;
}

/**
 * Host detection rule (plan §2): the host binary is resolvable or its config dir exists. Absent
 * hosts get no ops, so setup never creates directories for them.
 */
export function hostPresent(opts: PresenceOptions): boolean {
  if (existsSync(join(opts.home, opts.dir))) return true;
  const resolveOpts = opts.fs ? { env: opts.env, fs: opts.fs } : { env: opts.env };
  return resolveBinary(opts.binary, resolveOpts) !== null;
}
