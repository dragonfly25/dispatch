/**
 * Per-OS facts shared by the child adapters (Windows support): which adapters can run at all on
 * the current OS, and the allow-listed environment of probe commands.
 *
 * Every helper takes `platform` (default `process.platform`) so the Windows branches are testable
 * on POSIX hosts.
 */
import type { RoutingConfig } from "../core/routing.js";
import { envGet, isWindows, type OsPlatform, WINDOWS_BASE_ENV } from "../platform/os.js";
import { excludeUnavailable, type UnavailableRestriction } from "../router/capability.js";

/**
 * Why an adapter cannot run on `platform` (null: it can). `buildInvocation` refuses with this
 * reason (`adapter.platform_unsupported`), and `doctor` can report it without starting a child.
 * - claude: its OS sandbox does not exist on native Windows ("On native Windows, Claude Code runs
 *   commands unsandboxed", code.claude.com/docs/en/sandboxing), and Dispatch requires it
 *   (`sandbox.failIfUnavailable: true`), so every child would exit at startup.
 * - antigravity: headless auto-deny and the binary layout are unverified on Windows, and its
 *   prompt travels in argv; experimental and opt-in, so it stays off there.
 */
export function adapterPlatformBlocker(
  adapterId: string,
  platform: OsPlatform = process.platform,
): string | null {
  if (!isWindows(platform)) return null;
  return WINDOWS_BLOCKERS[adapterId] ?? null;
}

const WINDOWS_BLOCKERS: Readonly<Record<string, string>> = {
  claude:
    "Claude Code's OS sandbox is not available on native Windows (it runs commands unsandboxed " +
    "there) and Dispatch requires it; run Dispatch and Claude Code inside WSL2 instead",
  antigravity:
    "the Antigravity adapter is not verified on native Windows (headless auto-deny, argv " +
    "prompt); it stays disabled there",
};

/**
 * `routing` with every enabled instance whose adapter cannot run on `platform` disabled, and
 * those instances with their {@link adapterPlatformBlocker} reason. The runner routes with it, so
 * such an instance is skipped like an unavailable one and the fallback chain moves on; `explain`
 * can apply it to the same effect. A no-op on macOS and Linux.
 */
export function excludePlatformBlocked(
  routing: RoutingConfig,
  platform: OsPlatform = process.platform,
): UnavailableRestriction {
  return excludeUnavailable(routing, (i) => adapterPlatformBlocker(i.adapter, platform));
}

/**
 * Allow-listed environment for a probe command: each of `keys` present in `source`, and on
 * Windows also {@link WINDOWS_BASE_ENV} (DLL lookup, profile, temp dirs). Lookups are
 * case-insensitive on Windows (`Path`), and the child receives the canonical upper-case names.
 */
export function probeEnv(
  source: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
  platform: OsPlatform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!isWindows(platform)) {
    for (const key of keys) {
      const v = source[key];
      if (v !== undefined) env[key] = v;
    }
    return env;
  }
  for (const key of [...keys, ...WINDOWS_BASE_ENV]) {
    const v = envGet(source, key, platform);
    if (v !== undefined) env[key] = v;
  }
  return env;
}
