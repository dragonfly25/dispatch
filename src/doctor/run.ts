/**
 * `dispatch doctor`: collects the check lines (system, repo, every provider instance, registered
 * host checks) and, with `--live`, runs the smoke test. Rendering and the CLI wiring live in
 * `src/cli/commands/doctor.ts`.
 */
import {
  type AppContext,
  type AppEnv,
  type LoadAppContextOptions,
  loadAppContext,
} from "../app/context.js";
import { dispatchHome } from "../config/paths.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { HostRegistry } from "../hosts/_framework/registry.js";
import type { ResolveFs } from "../platform/resolve.js";
import { INTERACTIVE_READER_TIMEOUT_MS } from "../quota/provider.js";
import { fromHostLines } from "./host.js";
import { type LiveTarget, needsReadOnly } from "./live.js";
import {
  checkInstance,
  type InstanceCheckDeps,
  type InstanceReport,
  loadFixtureVersions,
  quotaLine,
} from "./provider.js";
import { configLines, launcherLine, networkLine, platformLine, repoLine } from "./system.js";
import { type DoctorLine, mkLine } from "./types.js";

/** Inputs of {@link collectChecks}. */
export interface CollectOptions {
  cwd: string;
  env: AppEnv;
  load: Omit<LoadAppContextOptions, "cwd" | "env">;
  registry: HostRegistry;
  fromHost: boolean;
  resolveFs?: ResolveFs | undefined;
}

/** The non-live part of a doctor run. `ctx` is null when the configuration could not be loaded (the caller closes it). */
export interface Collected {
  ctx: AppContext | null;
  lines: DoctorLine[];
  reports: Map<string, InstanceReport>;
}

function safeDispatchHome(env: AppEnv): string | null {
  try {
    return dispatchHome(env);
  } catch {
    return null;
  }
}

/** Runs every check that spends no quota. Never throws for a broken configuration. */
export async function collectChecks(opts: CollectOptions): Promise<Collected> {
  const { env } = opts;
  const home = safeDispatchHome(env);
  let ctx: AppContext | null = null;
  let loadError: unknown;
  try {
    ctx = loadAppContext({ cwd: opts.cwd, env, ...opts.load });
  } catch (err) {
    loadError = err;
  }

  const lines: DoctorLine[] = [platformLine()];
  lines.push(
    home === null
      ? mkLine("fail", "system", "launcher", "cannot locate the Dispatch home: HOME is not set")
      : launcherLine(home),
  );
  lines.push(...configLines(ctx, loadError, env));

  const reports = new Map<string, InstanceReport>();
  if (ctx) {
    lines.push(networkLine(ctx), repoLine(ctx));
    const deps: InstanceCheckDeps = {
      spawner: ctx.spawner,
      resolveFs: opts.resolveFs,
      fixtureVersions: loadFixtureVersions(ctx.assetsDir),
    };
    const instances = ctx.config.execution.instances;
    const done = await Promise.all(instances.map((inst) => checkInstance(ctx, inst, deps)));
    const quota = await quotaLines(
      ctx,
      instances.filter((i) => i.enabled),
    );
    for (const r of done) {
      reports.set(r.instance.id, r);
      lines.push(...r.lines);
      const q = quota.get(r.instance.id);
      if (q) lines.push(q);
    }
  }

  if (home !== null) {
    const hostCtx = { home: env.HOME ?? "", dispatchHome: home, env };
    for (const r of await opts.registry.runDoctorChecks(hostCtx)) {
      const { id, status, message, fix } = r;
      lines.push(mkLine(status, "host", id, message, fix ? { fix } : {}));
    }
    if (opts.fromHost) lines.push(...fromHostLines(env, home));
  }
  return { ctx, lines, reports };
}

/** Fresh quota read of the enabled instances, as one line each (UC11). */
async function quotaLines(
  ctx: AppContext,
  enabled: AppContext["config"]["execution"]["instances"],
): Promise<Map<string, DoctorLine>> {
  const out = new Map<string, DoctorLine>();
  if (enabled.length === 0) return out;
  try {
    const snapshot = await ctx.quota.snapshot(enabled, {
      hostInstanceId: ctx.host.self,
      fresh: true,
      readerTimeoutMs: INTERACTIVE_READER_TIMEOUT_MS,
    });
    for (const inst of enabled) {
      out.set(inst.id, quotaLine(ctx, inst, snapshot, ctx.quota.readerHealth(inst.id)));
    }
  } catch (err) {
    for (const inst of enabled) {
      out.set(
        inst.id,
        mkLine(
          "fail",
          inst.id,
          `${inst.id}.quota`,
          `quota state is unavailable: ${(err as Error).message}. Routing falls back to the host.`,
        ),
      );
    }
  }
  return out;
}

const usage = (message: string) => new DispatchError(message, ExitCode.USAGE, "cli.usage");

/**
 * Picks the instances the live test runs on: the enabled, non-host instances (or the
 * `--provider` list), plus lines explaining every instance that was left out.
 */
export function selectLiveTargets(
  ctx: AppContext,
  reports: ReadonlyMap<string, InstanceReport>,
  wanted: readonly string[] | undefined,
): { targets: LiveTarget[]; skipped: DoctorLine[] } {
  const all = ctx.config.execution.instances;
  const unknown = (wanted ?? []).filter((id) => !all.some((i) => i.id === id));
  if (unknown.length > 0) {
    throw usage(
      `unknown provider(s) ${unknown.join(", ")} (configured: ${all.map((i) => i.id).join(", ")})`,
    );
  }
  const chosen = wanted ? all.filter((i) => wanted.includes(i.id)) : all.filter((i) => i.enabled);
  const targets: LiveTarget[] = [];
  const skipped: DoctorLine[] = [];
  const skip = (id: string, why: string) =>
    skipped.push(mkLine("warn", "live", `live.${id}`, `${id}: skipped, ${why}`));
  for (const inst of chosen) {
    const report = reports.get(inst.id);
    if (!inst.enabled) skip(inst.id, "the instance is disabled (nothing was started)");
    else if (ctx.host.self === inst.id)
      skip(inst.id, "this is the host itself, never a delegation target");
    else if (!report?.adapter || !report.probe)
      skip(inst.id, "its binary or adapter is unavailable (see the checks above)");
    else {
      targets.push({
        instance: inst,
        adapter: report.adapter,
        probe: report.probe,
        readOnly: needsReadOnly(ctx, inst, report.adapter),
      });
    }
  }
  return { targets, skipped };
}
