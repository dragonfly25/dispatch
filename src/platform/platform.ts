import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Platforms Dispatch runs on. WSL reports `linux` and is supported as Linux. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * Throws a USAGE {@link DispatchError} unless `platform` (a `process.platform` value) is macOS,
 * Linux (including WSL) or native Windows.
 */
export function assertSupportedPlatform(platform: string = process.platform): void {
  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) return;
  throw new DispatchError(
    `unsupported platform "${platform}". Dispatch supports macOS, Linux and Windows only.`,
    ExitCode.USAGE,
    "platform.unsupported",
  );
}
