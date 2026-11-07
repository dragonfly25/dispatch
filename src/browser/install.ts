/**
 * Provisioning of the isolated browser by `dispatch setup`: one `cli-command` setup op that runs
 * the npm next to Dispatch's own node to install the pinned `@playwright/mcp` into
 * `~/.dispatch/tools/playwright-mcp`, recorded in the setup manifest so `setup --refresh` reinstalls
 * a missing or outdated copy and `uninstall --global` removes the directory.
 *
 * The install never runs lifecycle scripts (`--ignore-scripts`), never downloads a browser
 * (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; the installed Google Chrome is used), is never global
 * (`--prefix`) and is never planned as root. The integrity npm records in the lockfile is checked
 * against the pinned one before every use ({@link installStatus}).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EditOp } from "../core/contracts.js";
import { browserToolsDir, PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_MCP_VERSION } from "./index.js";

/** The trust grant setup shows (and the wizard asks about). */
export const BROWSER_GRANT =
  "Install an isolated browser for delegated agents (Playwright MCP, driving Google Chrome)";

/** What the grant means, shown before the question and in the preview. */
export const BROWSER_DETAIL = [
  `Downloads ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} (~19 MB, no browser download) from npm into`,
  "~/.dispatch/tools/playwright-mcp, without running install scripts. Agents that use the Claude",
  "desktop browser tools can then run on codex with the installed Google Chrome and a temporary",
  "empty profile (never your own profile, cookies or logins), limited to localhost dev servers.",
  "They also need the sandbox network (network: delegated-agents).",
].join("\n");

/** The `signature` of the op in the manifest. */
export const BROWSER_OP_SIGNATURE = "dispatch-browser-playwright-mcp";

/** The npm CLI script next to `nodePath` (`<bin>/npm` → `npm-cli.js`), or null. */
export function npmCliFor(nodePath: string, exists = existsSync): string | null {
  const bin = dirname(nodePath);
  const candidates = [
    join(bin, "npm"),
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (!exists(c)) continue;
    try {
      const real = realpathSync(c);
      if (real.endsWith(".js")) return real;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Inputs of {@link browserInstallOp}. */
export interface BrowserOpInput {
  dispatchHome: string;
  nodePath: string;
  /** Resolved {@link npmCliFor}. */
  npmCli: string;
}

/** The argv (after node) that installs the pinned package into `dir`. */
export function installArgv(npmCli: string, dir: string): string[] {
  return [
    npmCli,
    "install",
    "--prefix",
    dir,
    "--ignore-scripts",
    "--save-exact",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    `${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}`,
  ];
}

/**
 * The setup op: node runs npm (no shell, no PATH lookup); `ensure` makes `--refresh` reinstall a
 * copy that went missing; undo removes the directory (node, offline).
 */
export function browserInstallOp(input: BrowserOpInput): EditOp {
  const dir = browserToolsDir(input.dispatchHome);
  const content = JSON.stringify({
    argv: installArgv(input.npmCli, dir),
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", npm_config_ignore_scripts: "true" },
    undo: ["-e", `require("node:fs").rmSync(${JSON.stringify(dir)},{recursive:true,force:true})`],
    ensure: join(dir, "node_modules", "@playwright", "mcp", "package.json"),
    snapshot: { leftovers: [{ path: dir, recursive: true }] },
  });
  return {
    file: input.nodePath,
    kind: "cli-command",
    signature: BROWSER_OP_SIGNATURE,
    content,
    trustGrant: `${BROWSER_GRANT}: ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} (~19 MB) from npm into ${dir}; uses the installed Google Chrome with a temporary empty profile, never your own profile`,
  };
}

/** Why the browser cannot be provisioned here, or null. */
export function provisionBlocker(nodePath: string, uid: number | undefined): string | null {
  if (uid === 0) return "setup runs as root: the isolated browser is never installed as root";
  if (npmCliFor(nodePath) === null) return `npm was not found next to ${nodePath}`;
  return null;
}
