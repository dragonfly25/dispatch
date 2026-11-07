/**
 * Isolated browser for delegated agents (Claude Code custom agents whose `tools:` list the desktop
 * app's `mcp__Claude_Browser__*` tools): a Dispatch-owned Playwright MCP server, pinned and
 * installed by `dispatch setup` under `~/.dispatch/tools/playwright-mcp`, that drives the
 * installed Google Chrome with a temporary empty profile. Never the user's Chrome profile, never a
 * CDP attach to a running browser.
 *
 * Verified live (docs/spikes/browser.md), @playwright/mcp 0.0.84 with codex 0.167:
 * - `--isolated --headless --browser chrome` launches the installed Chrome with
 *   `--user-data-dir=<TMPDIR>/playwright_chromiumdev_profile-*` over a pipe, deleted on close.
 * - The server writes an empty registry dir under `$HOME/Library/Caches/ms-playwright/b` (from
 *   `os.homedir()`, ignoring PLAYWRIGHT_BROWSERS_PATH): its HOME is pointed at the attempt dir.
 * - `browser_run_code_unsafe` (arbitrary code in the server process, outside every sandbox) is a
 *   core tool with no flag to turn it off: codex's per-server `enabled_tools` allowlist hides it.
 * - `--allowed-origins` blocks other origins (`ERR_BLOCKED_BY_CLIENT`) and `file://` is blocked by
 *   default, but Playwright says the allowlist is NOT a security boundary (redirects pass).
 *
 * The request reaches `Adapter.buildInvocation` without touching the frozen
 * `BuildInvocationArgs`: the runner passes {@link BuildInvocationWithBrowser} (a structural
 * superset), the codex adapter reads `browser`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { BuildInvocationWithNetwork } from "../sandbox/network.js";

/** The pinned npm package. */
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp";
/** The pinned version (owner-approved download). */
export const PLAYWRIGHT_MCP_VERSION = "0.0.84";

/**
 * Integrity of every package of the pinned install, as npm records it in `package-lock.json`
 * (the registry's sha512). An install whose lockfile differs is not used.
 */
export const PINNED_INTEGRITY: Readonly<Record<string, string>> = {
  "node_modules/@playwright/mcp":
    "sha512-weqLrA7/D8MJzNV9/t3Hnjp100tS2sxFXKeb2gH6Nhktqmdfvx5qRA9AZ5Mhjnre1jY0wltsrRK5VZS5NBgcvw==",
  "node_modules/playwright":
    "sha512-dmAJMVHKzHvMQjn+XDcaq/pxaZ0W6n8i78rwTM+VGRtQ3WBF5ZiSdB1yL/cyoYUGUMwg3jxN65KqC9cERaCbIg==",
  "node_modules/playwright-core":
    "sha512-LPMw8B/HRQKMcJeXTqWSrkB/AfCKKmbDQMbu0p7zg8MgibOWaKMjZWR/StAtrQkOxvOmZEju1o1TnPgdoOCwrg==",
};

/** Name of the Dispatch-owned MCP server in the codex child (reserved: never forwarded). */
export const BROWSER_SERVER_NAME = "dispatch_browser";
/** The desktop app's built-in browser server the delegated agents name in `tools:`. */
export const CLAUDE_BROWSER_SERVER = "Claude_Browser";

/**
 * Playwright tools the child may use (codex `enabled_tools`). Left out: `browser_run_code_unsafe`
 * (code in the server process), `browser_file_upload` and `browser_drop` (read local files).
 */
export const ENABLED_TOOLS: readonly string[] = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_select_option",
  "browser_fill_form",
  "browser_handle_dialog",
  "browser_evaluate",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_take_screenshot",
  "browser_resize",
  "browser_tabs",
  "browser_wait_for",
  "browser_emulate_media",
  "browser_close",
];

/** Directory of the install inside the Dispatch home. */
export function browserToolsDir(dispatchHome: string): string {
  return join(dispatchHome, "tools", "playwright-mcp");
}

/** The server entry point of an install in `dir`. */
export function browserCliPath(dir: string): string {
  return join(dir, "node_modules", "@playwright", "mcp", "cli.js");
}

/** Read-only file access (injectable for tests). */
export interface BrowserFs {
  exists(path: string): boolean;
  read(path: string): string | null;
}

/** The real filesystem. */
export const realBrowserFs: BrowserFs = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

/** Whether the pinned install in `dir` is complete and matches {@link PINNED_INTEGRITY}. */
export type InstallStatus =
  | { ok: true; version: string; cliPath: string }
  | { ok: false; reason: string; version?: string };

/** Checks the install in `dir` (pinned version, lockfile integrity, entry point). */
export function installStatus(dir: string, fs: BrowserFs = realBrowserFs): InstallStatus {
  const pkgText = fs.read(join(dir, "node_modules", "@playwright", "mcp", "package.json"));
  if (pkgText === null) return { ok: false, reason: `not installed (${dir})` };
  let version = "";
  try {
    version = String((JSON.parse(pkgText) as { version?: unknown }).version ?? "");
  } catch {
    return { ok: false, reason: "the installed package.json is unreadable" };
  }
  if (version !== PLAYWRIGHT_MCP_VERSION) {
    return {
      ok: false,
      version,
      reason: `installed ${version || "?"}, pinned ${PLAYWRIGHT_MCP_VERSION} (run \`dispatch setup --refresh --yes\`)`,
    };
  }
  let lock: { packages?: Record<string, { integrity?: unknown }> } = {};
  try {
    lock = JSON.parse(fs.read(join(dir, "package-lock.json")) ?? "{}");
  } catch {
    // checked below
  }
  for (const [pkg, integrity] of Object.entries(PINNED_INTEGRITY)) {
    if (lock.packages?.[pkg]?.integrity !== integrity) {
      return { ok: false, version, reason: `integrity of ${pkg} does not match the pinned one` };
    }
  }
  const cliPath = browserCliPath(dir);
  if (!fs.exists(cliPath))
    return { ok: false, version, reason: "the server entry point is missing" };
  return { ok: true, version, cliPath };
}

/** Where Google Chrome is installed per platform (the stable channel Playwright's `chrome` uses). */
export function chromeCandidates(platform: string, home: string | undefined): string[] {
  if (platform === "darwin") {
    const app = join("Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    return [join("/Applications", app), ...(home ? [join(home, "Applications", app)] : [])];
  }
  if (platform === "linux") return ["/opt/google/chrome/chrome"];
  return [];
}

/** The installed Google Chrome, or null. */
export function findChrome(
  platform: string,
  home: string | undefined,
  fs: Pick<BrowserFs, "exists"> = realBrowserFs,
): string | null {
  return chromeCandidates(platform, home).find((p) => fs.exists(p)) ?? null;
}

/** Inputs of {@link browserReadiness}. */
export interface ReadinessInput {
  /** `hosts.claude-code.browser` after tighten-only merging. */
  enabled: boolean;
  dispatchHome: string;
  platform: string;
  home: string | undefined;
  fs?: BrowserFs;
}

/** Whether delegated agents can get the isolated browser on this machine. */
export type Readiness =
  | { ready: true; cliPath: string; chrome: string; version: string }
  | { ready: false; reason: string };

/** Enabled, installed (pinned, integrity checked) and Chrome found; else why not. */
export function browserReadiness(input: ReadinessInput): Readiness {
  if (!input.enabled) {
    return { ready: false, reason: "the isolated browser is off (hosts.claude-code.browser)" };
  }
  const fs = input.fs ?? realBrowserFs;
  const st = installStatus(browserToolsDir(input.dispatchHome), fs);
  if (!st.ok) return { ready: false, reason: `the isolated browser is ${st.reason}` };
  const chrome = findChrome(input.platform, input.home, fs);
  if (chrome === null) return { ready: false, reason: "Google Chrome is not installed" };
  return { ready: true, cliPath: st.cliPath, chrome, version: st.version };
}

/** The browser given to one run (the codex adapter turns it into `-c mcp_servers...`). */
export interface BrowserRun {
  /** Absolute node that runs the server (the one running Dispatch). */
  nodePath: string;
  /** {@link browserCliPath} of the verified install. */
  cliPath: string;
  /** `--allowed-origins` entries (see {@link allowedOrigins}). */
  origins: string[];
}

/** Optional extension of the invocation arguments carrying the browser of this run. */
export interface BrowserForwarding {
  browser?: BrowserRun;
}

/** `BuildInvocationArgs` plus MCP servers, web access, sandbox network and browser. */
export type BuildInvocationWithBrowser = BuildInvocationWithNetwork & BrowserForwarding;

/**
 * Origins the browser may request: `http://localhost:<p>` and `http://127.0.0.1:<p>` for each
 * dev-server port, or any port on both hosts when none is declared. Not a security boundary.
 */
export function allowedOrigins(ports: readonly number[]): string[] {
  const ps = ports.length > 0 ? [...new Set(ports)].map(String) : ["*"];
  return ps.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
}

/** Only codex can host the browser server (claude `--safe-mode` drops MCP, agy never). */
const BROWSER_CAPABLE: ReadonlySet<string> = new Set(["codex"]);

/** True when `adapterId` can give the child the isolated browser. */
export function adapterCanBrowser(adapterId: string): boolean {
  return BROWSER_CAPABLE.has(adapterId);
}

/** Fails closed in an adapter that cannot host the browser when a run still asks for it. */
export function refuseBrowser(adapterId: string, args: BrowserForwarding): void {
  if (args.browser === undefined) return;
  throw new DispatchError(
    `${adapterId} cannot be given the isolated browser (only codex can)`,
    ExitCode.REJECTED,
    "adapter.browser_unsupported",
  );
}
