/**
 * The spawn shape of every runner child: `toSpawnCommand` (npm `.cmd` shims unwrapped to
 * `node <script>` on Windows, other batch files refused) plus one runner-side rule for bare
 * command names.
 */
import { win32 } from "node:path";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { envGet, isWindows, type OsPlatform } from "../platform/os.js";
import { nodeResolveFs, type ResolveFs, resolveBinary } from "../platform/resolve.js";
import { type SpawnCommand, toSpawnCommand } from "../platform/spawnable.js";

/** Signature of `toSpawnCommand`; injectable so tests can run real POSIX children as "win32". */
export type ToSpawn = typeof toSpawnCommand;

/**
 * True for a bare command name on Windows (`git`: no directory part, no extension). Spawning such
 * a name as is would let the Windows launcher search the child's cwd before PATH, so on win32
 * {@link spawnCommandFor} resolves it to an absolute path first.
 */
export function isBareCommand(binary: string): boolean {
  return !/[\\/:]/.test(binary) && win32.extname(binary) === "";
}

/** Lookup inputs for bare names on Windows; injectable for tests. */
export interface BareLookup {
  /** Env whose `PATH`/`PATHEXT` are searched (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  fs?: ResolveFs;
}

/** Resolved bare names per filesystem, keyed by name + `PATH` + `PATHEXT`. */
let resolvedBare = new WeakMap<ResolveFs, Map<string, string>>();

/** Clears the bare-name cache of {@link spawnCommandFor} (tests). */
export function clearBareCommandCache(): void {
  resolvedBare = new WeakMap();
}

/**
 * Absolute path of the bare name `binary` on Windows, from absolute `PATH` entries (then the
 * well-known install dirs) with `PATHEXT` limited to `.com/.exe/.bat/.cmd`. Never the cwd: a
 * `git.exe` planted in a worktree or a cloned repo must not run in place of the real one.
 * Cached per name + `PATH` + `PATHEXT`; a miss is not cached.
 */
function resolveBareWindows(binary: string, lookup: BareLookup): string {
  const env = lookup.env ?? process.env;
  const fs = lookup.fs ?? nodeResolveFs;
  const key = [
    binary.toLowerCase(),
    envGet(env, "PATH", "win32") ?? "",
    envGet(env, "PATHEXT", "win32") ?? "",
  ].join("\0");
  let cache = resolvedBare.get(fs);
  if (cache === undefined) {
    cache = new Map();
    resolvedBare.set(fs, cache);
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const found = resolveBinary(binary, { env, platform: "win32", fs });
  if (!found) {
    throw new DispatchError(
      `cannot find ${binary} on PATH (absolute PATH entries with .com/.exe/.bat/.cmd only); ` +
        "install it or add its directory to PATH",
      ExitCode.FAILED,
      "binary.not_found",
    );
  }
  cache.set(key, found.path);
  return found.path;
}

/**
 * What to hand to `spawn(command, args, { shell: false })` for `binary argv` on `platform`.
 * On Windows a bare name is first resolved to an absolute path (throws `binary.not_found` when
 * it cannot be). Throws `binary.unspawnable` (from `toSpawnCommand`) for a Windows batch file
 * that is not an npm shim, or for any other non-executable path. POSIX names pass to
 * `toSpawnCommand` unchanged.
 */
export function spawnCommandFor(
  binary: string,
  argv: readonly string[],
  platform: OsPlatform = process.platform,
  convert: ToSpawn = toSpawnCommand,
  lookup: BareLookup = {},
): SpawnCommand {
  const target =
    isWindows(platform) && isBareCommand(binary) ? resolveBareWindows(binary, lookup) : binary;
  return convert(target, argv, { platform });
}
