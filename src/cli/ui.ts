/**
 * Terminal presentation helpers of the CLI: colors (Node's `util.styleText`), status symbols,
 * `~/` paths, quota meters, column alignment, boxed notes and a stderr spinner.
 *
 * Decoration is decided once per stream (see {@link decorationEnabled}) and travels through
 * {@link CliIo.decorate}; a {@link Ui} built with `enabled: false` returns every string unchanged
 * and uses ASCII marks, so piped, scripted and test output stays plain text without ANSI codes.
 */
import { styleText } from "node:util";
import { relativeToHome, samePathKey } from "../config/pathkey.js";
import { isWindows, type OsPlatform } from "../platform/os.js";
import type { CliIo } from "./io.js";

/** Check / step status shown with a symbol. */
export type Status = "ok" | "warn" | "fail";

/** Styling helpers bound to one decoration decision. */
export interface Ui {
  /** True when colors and Unicode symbols are used. */
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
  /** Symbols: `✔ ⚠ ✖ ●` when enabled, short ASCII words otherwise. */
  readonly sym: Readonly<Record<Status | "dot", string>>;
  /** The colored symbol of `status` (green / yellow / red). */
  mark(status: Status): string;
  /** Colors `text` like `status`. */
  tone(status: Status, text: string): string;
}

type Format = Parameters<typeof styleText>[0];

const UNICODE = { ok: "✔", warn: "⚠", fail: "✖", dot: "●" } as const;
const ASCII = { ok: "ok", warn: "warn", fail: "FAIL", dot: "-" } as const;
const TONE: Record<Status, Format> = { ok: "green", warn: "yellow", fail: "red" };

/** Builds a {@link Ui}; with `enabled: false` every helper is the identity. */
export function createUi(enabled: boolean): Ui {
  // validateStream: false — the caller already decided; never re-check process.stdout here.
  const fmt =
    (format: Format) =>
    (text: string): string =>
      enabled && text !== "" ? styleText(format, text, { validateStream: false }) : text;
  const sym = enabled ? UNICODE : ASCII;
  const tone = (status: Status, text: string) => fmt(TONE[status])(text);
  return {
    enabled,
    bold: fmt("bold"),
    dim: fmt("dim"),
    green: fmt("green"),
    yellow: fmt("yellow"),
    red: fmt("red"),
    cyan: fmt("cyan"),
    sym,
    mark: (status) => tone(status, sym[status]),
    tone,
  };
}

/** The undecorated {@link Ui}. */
export const plainUi: Ui = createUi(false);

/** {@link Ui} for stdout of `io`. */
export const outUi = (io: CliIo): Ui => createUi(io.decorate?.out === true);

/** {@link Ui} for stderr of `io`. */
export const errUi = (io: CliIo): Ui => createUi(io.decorate?.err === true);

/**
 * Whether a stream gets colors and symbols: never with `NO_COLOR` (any non-empty value);
 * `FORCE_COLOR` forces it on (`0` or `false` forces it off); otherwise only for a TTY.
 */
export function decorationEnabled(
  stream: { isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.NO_COLOR) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  return stream.isTTY === true;
}

/**
 * Shows `path` relative to `home` as `~/…` (Windows: `~\…`, matching case-insensitively and
 * either separator); unchanged when outside it or `home` is unknown.
 */
export function tildify(
  path: string,
  home: string | undefined,
  platform: OsPlatform = process.platform,
): string {
  if (isWindows(platform)) {
    if (!home) return path;
    const rel = relativeToHome(path, home, platform);
    if (rel !== null) return `~\\${rel}`;
    return samePathKey(path, home, platform) ? "~" : path;
  }
  if (!home || home === "/") return path;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/**
 * Replaces every `home/` path prefix inside free text with `~/`. Windows: every `home\` or
 * `home/` prefix, in any letter case, becomes `~` plus the separator that followed it.
 */
export function tildifyText(
  text: string,
  home: string | undefined,
  platform: OsPlatform = process.platform,
): string {
  if (isWindows(platform)) {
    const base = home?.replace(/[\\/]+$/, "");
    if (!base) return text;
    const pattern = base
      .split(/[\\/]+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]+");
    return text.replace(new RegExp(`${pattern}([\\\\/])`, "gi"), "~$1");
  }
  if (!home || home === "/") return text;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return text.split(`${base}/`).join("~/");
}

/**
 * A `width`-cell bar filled to `pct` (clamped to 0..100; NaN counts as 0). Unicode blocks when
 * `unicode`, else `#` and `-`.
 */
export function meter(pct: number, width: number, unicode = false): string {
  const w = Math.max(0, Math.floor(width));
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const filled = Math.round((p / 100) * w);
  const [on, off] = unicode ? ["█", "░"] : ["#", "-"];
  return on.repeat(filled) + off.repeat(w - filled);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Length of `text` as displayed (ANSI color codes do not count). */
export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

/** Pads `text` with spaces to `width` displayed cells. */
export function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

/**
 * Aligns `rows` into columns separated by `gap` spaces. The last cell of a row is never padded,
 * so lines carry no trailing spaces.
 */
export function columns(rows: readonly (readonly string[])[], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : padVisible(cell, widths[i] ?? 0)))
      .join(" ".repeat(gap))
      .trimEnd(),
  );
}

/** `command  what it does` hint lines, aligned (no title). */
export function hintRows(ui: Ui, steps: readonly (readonly [string, string])[]): string[] {
  return columns(steps.map(([cmd, what]) => [`  ${ui.cyan(cmd)}`, ui.dim(what)]));
}

/** A "Next steps:" block of {@link hintRows}. */
export function nextSteps(ui: Ui, steps: readonly (readonly [string, string])[]): string {
  return `${ui.bold("Next steps:")}\n${hintRows(ui, steps).join("\n")}\n`;
}

/**
 * A boxed note: a frame around `lines` when decorated, a title line and indented lines otherwise.
 */
export function box(ui: Ui, title: string, lines: readonly string[]): string {
  if (!ui.enabled) return `${[title, ...lines.map((l) => `  ${l}`)].join("\n")}\n`;
  const width = Math.max(visibleLength(title) + 2, ...lines.map(visibleLength));
  const top = `╭─ ${ui.bold(title)} ${"─".repeat(Math.max(0, width - visibleLength(title) - 2))}╮`;
  const body = lines.map((l) => `│ ${padVisible(l, width)} │`);
  return `${[top, ...body, `╰${"─".repeat(width + 2)}╯`].join("\n")}\n`;
}

/** A one-line progress indicator. */
export interface Spinner {
  /** Changes the text shown next to the spinner. */
  update(text: string): void;
  /** Clears the spinner line and stops the timer. */
  stop(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Starts a spinner that redraws one line of stderr every `intervalMs`. Without decoration it is
 * a no-op: nothing is ever written, so logs and pipes stay clean.
 */
export function startSpinner(io: CliIo, text: string, intervalMs = 100): Spinner {
  const ui = errUi(io);
  if (!ui.enabled) return { update: () => {}, stop: () => {} };
  let frame = 0;
  let label = text;
  const draw = () => {
    io.err(`\r\x1b[K${ui.cyan(FRAMES[frame % FRAMES.length] as string)} ${label}`);
    frame++;
  };
  draw();
  const timer = setInterval(draw, intervalMs);
  timer.unref?.();
  let stopped = false;
  return {
    update: (next) => {
      label = next;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      io.err("\r\x1b[K");
    },
  };
}
