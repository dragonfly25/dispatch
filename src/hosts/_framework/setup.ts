/**
 * `dispatch setup` and `dispatch uninstall --global` (plan §2 "Host integration"): plan the host
 * edits, preview them (every file and trust grant) before writing, apply them while recording
 * the manifest, and undo exactly them later.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../core/contracts.js";
import { type InstallPaths, renderLauncherScript } from "../../platform/launcher.js";
import { applyOp, type CommandRunner, parseCliSpec, revertEntry } from "./edits.js";
import { sha256 } from "./fsutil.js";
import { parseJsonEntrySpec } from "./json-entry.js";
import { type ManifestEntry, readManifest, sameOp, writeManifest } from "./manifest.js";

/** Everything setup needs to know about the machine. */
export interface SetupContext {
  home: string;
  dispatchHome: string;
  install: Pick<InstallPaths, "nodePath" | "cliPath" | "hookPath">;
  hosts: readonly HostIntegration[];
}

/** A planned setup: the ops in apply order and the preview shown before anything is written. */
export interface SetupPlan {
  ops: EditOp[];
  preview: string;
  detected: string[];
  absent: string[];
  /** Manifest entries no longer planned; `--refresh` removes them. */
  stale: ManifestEntry[];
}

/** Absolute path of the launcher, `<dispatchHome>/bin/dispatch`. */
export function launcherPath(dispatchHome: string): string {
  return join(dispatchHome, "bin", "dispatch");
}

/** The {@link HostPlanContext} handed to host integrations. */
export function hostPlanContext(ctx: SetupContext): HostPlanContext {
  return {
    home: ctx.home,
    launcherPath: launcherPath(ctx.dispatchHome),
    nodePath: ctx.install.nodePath,
    hookPath: ctx.install.hookPath,
  };
}

/** The new-file op that installs the launcher (mode 0755). */
export function launcherOp(ctx: SetupContext): EditOp {
  const content = renderLauncherScript(ctx.install);
  return {
    file: launcherPath(ctx.dispatchHome),
    kind: "new-file",
    signature: "dispatch-launcher",
    content,
    mode: "0755",
    sha256: sha256(content),
    trustGrant: null,
  };
}

function describeOp(op: EditOp): string {
  switch (op.kind) {
    case "new-file":
    case "rules-file":
      return `create ${op.file} (mode ${op.mode ?? "0644"})`;
    case "text-block":
      return `add a marked block to ${op.file}`;
    case "json-entry": {
      const spec = parseJsonEntrySpec(op.content);
      return `${spec.mode === "append" ? "add an entry to" : "set"} "${spec.path.join(".")}" in ${op.file}`;
    }
    case "cli-command":
      return `run ${[op.file, ...parseCliSpec(op.content).argv].join(" ")}`;
  }
}

/** Renders the human-readable preview: every change, then every trust grant verbatim. */
export function renderPreview(plan: Omit<SetupPlan, "preview">): string {
  const lines = ["Dispatch setup will make these changes:"];
  for (const op of plan.ops) lines.push(`  - ${describeOp(op)}`);
  for (const e of plan.stale) lines.push(`  - remove the earlier Dispatch edit in ${e.file}`);
  const grants = plan.ops.filter((op) => op.trustGrant !== null);
  if (grants.length > 0) {
    lines.push("", "Trust grants (they give a host extra authority; read them carefully):");
    for (const op of grants) lines.push(`  - ${op.file}: ${op.trustGrant}`);
  }
  if (plan.detected.length > 0) lines.push("", `Hosts detected: ${plan.detected.join(", ")}`);
  if (plan.absent.length > 0) {
    lines.push(`Hosts not found (nothing is written for them): ${plan.absent.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Plans setup: the launcher plus the ops of every detected host. Writes nothing. Hosts that are
 * not detected contribute no ops, so no directory is ever created for an absent host.
 */
export async function planSetup(ctx: SetupContext): Promise<SetupPlan> {
  const hostCtx = hostPlanContext(ctx);
  const ops: EditOp[] = [launcherOp(ctx)];
  const detected: string[] = [];
  const absent: string[] = [];
  for (const host of ctx.hosts) {
    if (await host.detect(hostCtx)) {
      detected.push(host.id);
      ops.push(...host.plan(hostCtx));
    } else {
      absent.push(host.id);
    }
  }
  const manifest = readManifest(ctx.dispatchHome);
  const stale = manifest.entries.filter((e) => !ops.some((op) => sameOp(e, op)));
  const plan = { ops, detected, absent, stale };
  return { ...plan, preview: renderPreview(plan) };
}

/** Options of {@link applySetup}. */
export interface ApplyOptions {
  dispatchHome: string;
  /** `true` (`--yes`), or a prompt that sees the preview and answers. */
  confirm: boolean | ((preview: string) => Promise<boolean>);
  runner?: CommandRunner | undefined;
  /** Remove stale manifest entries (`setup --refresh`). */
  refresh?: boolean;
}

/** What {@link applySetup} did. */
export interface ApplySummary {
  confirmed: boolean;
  applied: string[];
  unchanged: string[];
  removed: string[];
  warnings: string[];
}

/**
 * Applies a plan after confirmation, saving the manifest after every op so a failure part-way
 * leaves an accurate record for `uninstall --global`. Idempotent: re-running changes nothing.
 */
export async function applySetup(plan: SetupPlan, opts: ApplyOptions): Promise<ApplySummary> {
  const summary: ApplySummary = {
    confirmed: false,
    applied: [],
    unchanged: [],
    removed: [],
    warnings: [],
  };
  const ok = typeof opts.confirm === "boolean" ? opts.confirm : await opts.confirm(plan.preview);
  if (!ok) return summary;
  summary.confirmed = true;
  const manifest = readManifest(opts.dispatchHome);
  const deps = { runner: opts.runner };

  if (opts.refresh) {
    for (const entry of [...plan.stale].reverse()) {
      const r = await revertEntry(entry, deps);
      if (r.warning) summary.warnings.push(r.warning);
      manifest.entries = manifest.entries.filter((e) => !sameOp(e, entry));
      summary.removed.push(entry.file);
      writeManifest(opts.dispatchHome, manifest);
    }
  }

  for (const op of plan.ops) {
    const idx = manifest.entries.findIndex((e) => sameOp(e, op));
    const prev = idx === -1 ? undefined : manifest.entries[idx];
    const r = await applyOp(op, prev, deps);
    if (idx === -1) manifest.entries.push(r.entry);
    else manifest.entries[idx] = r.entry;
    (r.status === "applied" ? summary.applied : summary.unchanged).push(op.file);
    writeManifest(opts.dispatchHome, manifest);
  }
  return summary;
}

/** Options of {@link uninstallGlobal}. */
export interface UninstallOptions {
  dispatchHome: string;
  /** Keep `~/.dispatch` (config, state); only the host integration and the launcher go. */
  keepDispatchHome?: boolean;
  runner?: CommandRunner | undefined;
}

/** What {@link uninstallGlobal} did. */
export interface UninstallSummary {
  reverted: string[];
  warnings: string[];
  /** True when the Dispatch home was deleted. */
  homeRemoved: boolean;
}

/**
 * Undoes every manifest entry in reverse order. Entries the user edited are left in place with a
 * warning. Entries that fail stay in the manifest, and then the Dispatch home is kept so a later
 * run can retry; otherwise the home is deleted unless `keepDispatchHome`.
 */
export async function uninstallGlobal(opts: UninstallOptions): Promise<UninstallSummary> {
  const manifest = readManifest(opts.dispatchHome);
  const summary: UninstallSummary = { reverted: [], warnings: [], homeRemoved: false };
  const failed: ManifestEntry[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    try {
      const r = await revertEntry(entry, { runner: opts.runner });
      if (r.warning) summary.warnings.push(r.warning);
      if (r.status === "reverted") summary.reverted.push(entry.file);
    } catch (err) {
      failed.unshift(entry);
      summary.warnings.push(
        `${entry.file}: could not undo (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (failed.length > 0) {
    writeManifest(opts.dispatchHome, { ...manifest, entries: failed });
    return summary;
  }
  if (opts.keepDispatchHome) {
    rmSync(join(opts.dispatchHome, "setup-manifest.json"), { force: true });
  } else {
    rmSync(opts.dispatchHome, { recursive: true, force: true });
    summary.homeRemoved = true;
  }
  return summary;
}
