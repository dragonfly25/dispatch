/**
 * Doctor checks that do not depend on a provider: platform, launcher, configuration, repo trust,
 * and (with `--from-host`) the conditions a host-launched call needs.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AppContext } from "../app/context.js";
import { globalConfigPath } from "../config/paths.js";
import { assertSupportedPlatform } from "../platform/platform.js";
import { type DoctorLine, mkLine } from "./types.js";

const MIN_NODE: [number, number] = [22, 13];
const REFRESH = "dispatch setup --refresh";

/** `platform`: macOS or Linux, on a supported Node. */
export function platformLine(
  platform = process.platform,
  nodeVersion = process.version,
): DoctorLine {
  try {
    assertSupportedPlatform(platform);
  } catch (err) {
    return mkLine("fail", "system", "platform", (err as Error).message);
  }
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, "").split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    return mkLine(
      "fail",
      "system",
      "platform",
      `${platform}, node ${nodeVersion}: Dispatch needs Node >= ${MIN_NODE.join(".")}`,
      { fix: `install a newer Node, then run \`${REFRESH}\`` },
    );
  }
  return mkLine("ok", "system", "platform", `${platform}, node ${nodeVersion}`);
}

const LAUNCHER_EXEC = /^exec "([^"]+)"(?: [^"\s]+)* "([^"]+)" "\$@"$/m;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `launcher`: `<dispatchHome>/bin/dispatch` exists and the node, cli and hook paths it names still
 * exist (they go stale after a Node upgrade or an npm reinstall).
 */
export function launcherLine(dispatchHome: string): DoctorLine {
  const launcher = join(dispatchHome, "bin", "dispatch");
  if (!existsSync(launcher)) {
    return mkLine("warn", "system", "launcher", `${launcher} does not exist (setup has not run)`, {
      fix: "dispatch setup",
    });
  }
  const m = LAUNCHER_EXEC.exec(readFileSync(launcher, "utf8"));
  if (!m?.[1] || !m[2]) {
    return mkLine("warn", "system", "launcher", `${launcher} has an unrecognised format`, {
      fix: REFRESH,
    });
  }
  const [node, cli] = [m[1], m[2]];
  const hook = join(dirname(cli), "hook.mjs");
  const data = { launcher, node, cli, hook };
  const gone = [
    ...(executable(node) ? [] : [node]),
    ...(existsSync(cli) ? [] : [cli]),
    ...(existsSync(hook) ? [] : [hook]),
  ];
  if (gone.length > 0) {
    return mkLine(
      "fail",
      "system",
      "launcher",
      `${launcher} points at paths that no longer exist: ${gone.join(", ")}`,
      { fix: REFRESH, data },
    );
  }
  return mkLine("ok", "system", "launcher", `${launcher} -> ${node} ${cli}`, { data });
}

/** `config.global` (+ `config.issues`): the global config parses and the effective config loads. */
export function configLines(
  ctx: AppContext | null,
  error: unknown,
  env: AppContext["env"],
): DoctorLine[] {
  if (!ctx) {
    const why = error instanceof Error ? error.message : String(error);
    return [
      mkLine("fail", "system", "config.global", `configuration cannot be loaded: ${why}`, {
        fix: "fix the file named above (`dispatch validate` re-checks it)",
      }),
    ];
  }
  const path = globalConfigPath(env);
  const lines: DoctorLine[] = [
    existsSync(path)
      ? mkLine("ok", "system", "config.global", `${path} is valid`)
      : mkLine(
          "warn",
          "system",
          "config.global",
          `${path} does not exist; built-in defaults apply`,
          {
            fix: "dispatch setup",
          },
        ),
  ];
  for (const issue of ctx.config.issues) {
    if (issue.key === "trust") continue; // reported by `repo.trust`
    lines.push(
      mkLine(
        issue.level === "error" ? "fail" : "warn",
        "system",
        "config.issues",
        `${issue.key}: ${issue.message}`,
        { fix: "dispatch validate" },
      ),
    );
  }
  return lines;
}

/** `repo.trust`: the repo's `.dispatch/` policy is trusted, or says how to trust it. */
export function repoLine(ctx: AppContext): DoctorLine {
  const { status, repoId, hash, changed } = ctx.config.trust;
  switch (status) {
    case "trusted":
      return mkLine(
        "ok",
        "repo",
        "repo.trust",
        `.dispatch/ policy is trusted (${(hash ?? "").slice(0, 12)})`,
        { data: { repoId } },
      );
    case "untrusted":
      return mkLine(
        "warn",
        "repo",
        "repo.trust",
        ".dispatch/ exists but is not trusted: the repo policy is ignored",
        { fix: "review .dispatch/, then run `dispatch trust`" },
      );
    case "changed":
      return mkLine(
        "warn",
        "repo",
        "repo.trust",
        `.dispatch/ changed since it was trusted (${changed.join(", ")}): the repo policy is ignored`,
        { fix: "review the changes, then run `dispatch trust`" },
      );
    case "symlink":
      return mkLine(
        "warn",
        "repo",
        "repo.trust",
        ".dispatch/ contains a symlink: the repo policy is ignored",
        { fix: "replace the symlink with a regular file" },
      );
    default:
      return mkLine(
        "ok",
        "repo",
        "repo.trust",
        repoId
          ? "no .dispatch/ policy in this repo (run `dispatch install` to add one)"
          : "not inside a git repository",
      );
  }
}

/** Creates `dir` if needed and writes and removes a probe file in it; the error message, or null when it is writable. */
export function probeWritable(dir: string): string | null {
  const probe = join(dir, `.doctor-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
