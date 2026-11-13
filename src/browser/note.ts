/**
 * The "Browser tools in this run" section added to the task of a browser agent: how the desktop
 * app's `mcp__Claude_Browser__*` tools its instructions mention map to the Playwright tools of the
 * `dispatch_browser` server, and how to run the repo's dev servers (`.claude/launch.json`) with
 * the shell instead of `preview_start` (verified live, docs/spikes/browser.md: a job backgrounded
 * with `&` dies when its shell command returns; a long-running command stays alive in codex's
 * background exec session and stops on Ctrl-C to that session, while a `kill` from another sandboxed
 * command is denied). Reads only; never writes.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { BROWSER_SERVER_NAME } from "./index.js";

/** One dev server of `.claude/launch.json`. */
export interface LaunchConfig {
  name: string;
  /** runtimeExecutable followed by runtimeArgs. */
  command: string[];
  port: number | null;
  /** Repo-relative working directory, when the configuration sets one. */
  cwd: string | null;
}

/** Most configurations read from one file. */
const MAX_CONFIGS = 10;

const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536;

/** A repo-relative path that stays inside the repo, else null. */
function relativeInside(v: unknown): string | null {
  if (typeof v !== "string" || v === "" || isAbsolute(v)) return null;
  const n = normalize(v);
  // Windows normalizes to `..\x`: either separator after `..` leaves the repo.
  return n === ".." || /^\.\.[\\/]/.test(n) ? null : n;
}

/**
 * The configurations of `<repoRoot>/.claude/launch.json` (the desktop app's preview servers):
 * lenient, an unreadable file or entry is skipped. Repo content: treated as data.
 */
export function readLaunchConfigs(
  repoRoot: string,
  read: (path: string) => string | null = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
): LaunchConfig[] {
  const text = read(join(repoRoot, ".claude", "launch.json"));
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(list)) return [];
  const out: LaunchConfig[] = [];
  for (const c of list.slice(0, MAX_CONFIGS)) {
    if (c === null || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.runtimeExecutable !== "string") continue;
    const args = Array.isArray(o.runtimeArgs)
      ? o.runtimeArgs.filter((a) => typeof a === "string")
      : [];
    out.push({
      name: o.name.slice(0, 60),
      command: [o.runtimeExecutable, ...args].map((s) => s.slice(0, 200)),
      port: isPort(o.port) ? o.port : null,
      cwd: relativeInside(o.cwd),
    });
  }
  return out;
}

/** The ports declared by `configs` (for the origin allowlist). */
export function launchPorts(configs: readonly LaunchConfig[]): number[] {
  return configs.flatMap((c) => (c.port === null ? [] : [c.port]));
}

/** POSIX single quoting, unless the word is plainly safe. */
function sh(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A file-name-safe label for a configuration. */
function label(name: string, i: number): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, "");
  return s === "" ? `server${i + 1}` : s;
}

/** The shell recipe for one configuration. */
function serverLines(c: LaunchConfig, i: number): string[] {
  const id = label(c.name, i);
  const log = `"$TMPDIR/dispatch-dev-${id}.log"`;
  const cd = c.cwd === null ? "" : `cd ${sh(c.cwd)} && `;
  const start = `${cd}exec ${c.command.map(sh).join(" ")} > ${log} 2>&1`;
  const lines = [
    `- preview_start "${c.name.replace(/"/g, "")}"${c.port === null ? "" : ` (port ${c.port})`}: run \`${start}\` as its own long-running shell command.`,
  ];
  if (c.port !== null) {
    lines.push(
      `  Then, in a separate command, wait until it answers: \`for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:${c.port}/ && break; sleep 1; done\`, and browse http://localhost:${c.port}/.`,
    );
  }
  lines.push(
    `  preview_logs: \`tail -n 100 ${log}\`. preview_stop: send Ctrl-C to that running command's session.`,
  );
  return lines;
}

/** The section appended under the agent instructions of a browser agent's task. */
export function browserNote(configs: readonly LaunchConfig[]): string {
  const s = BROWSER_SERVER_NAME;
  const lines = [
    "## Browser tools in this run",
    `Your instructions may name the Claude desktop browser tools (mcp__Claude_Browser__*). Here you have an isolated headless Chrome instead (temporary empty profile, no logins), through the \`${s}\` MCP tools. It may only open http://localhost and http://127.0.0.1${configs.some((c) => c.port !== null) ? " on the dev-server ports below" : ""}. Map the tools like this:`,
    "- navigate: browser_navigate (back: browser_navigate_back)",
    "- read_page, find: browser_snapshot (accessibility tree with element refs), browser_find",
    "- computer: browser_click, browser_type, browser_press_key, browser_hover, browser_drag; screenshots with browser_take_screenshot (without a file name: it is saved outside the repo)",
    "- form_input: browser_fill_form, browser_select_option or browser_type",
    "- javascript_tool: browser_evaluate",
    "- read_console_messages: browser_console_messages",
    "- read_network_requests: browser_network_requests, browser_network_request",
    "- resize_window: browser_resize; tabs_context: browser_tabs",
    "- preview_start, preview_logs, preview_stop: there is no preview service. Run the dev server yourself with the shell, as below.",
    "",
    "Dev servers: start each one as a long-running shell command WITHOUT `&`, nohup or disown (your shell tool keeps it running in a background session; a job backgrounded with `&` is killed when its command returns). Stop it by sending Ctrl-C to that session (write_stdin); `kill` from another command is blocked by the sandbox.",
  ];
  if (configs.length === 0) {
    lines.push(
      'This repo has no .claude/launch.json: start the app\'s dev server the same way (`exec <command> > "$TMPDIR/dispatch-dev.log" 2>&1`) on a localhost port, and stop it with Ctrl-C.',
    );
  } else {
    configs.forEach((c, i) => {
      lines.push(...serverLines(c, i));
    });
  }
  lines.push(
    "Stop every dev server you started before you finish (preview_stop), check with curl that its port no longer answers, and say in your summary that you did.",
  );
  return lines.join("\n");
}
