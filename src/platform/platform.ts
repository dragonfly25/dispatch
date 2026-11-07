import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Platforms Dispatch runs on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux"] as const;

/**
 * Throws a USAGE {@link DispatchError} unless `platform` (a `process.platform` value) is macOS or
 * Linux. Windows users are pointed to WSL.
 */
export function assertSupportedPlatform(platform: string = process.platform): void {
  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) return;
  const hint =
    platform === "win32"
      ? "Windows is not supported natively; run Dispatch inside WSL (Windows Subsystem for Linux)."
      : "Dispatch supports macOS and Linux only (on Windows, use WSL).";
  throw new DispatchError(
    `unsupported platform "${platform}". ${hint}`,
    ExitCode.USAGE,
    "platform.unsupported",
  );
}
