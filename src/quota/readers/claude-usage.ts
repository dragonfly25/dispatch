/**
 * Claude quota reader: `claude -p /usage --safe-mode` (official command, spends no quota). It sees
 * the account's whole usage, interactive sessions included. The CLI uses its own login (found
 * through HOME / `CLAUDE_CONFIG_DIR`); Dispatch never opens credential files.
 *
 * Privacy: the output is cut to its quota header ({@link trimUsageHeader}) as soon as the child
 * exits; the local-usage breakdown that follows is never stored, logged, cached or sent anywhere.
 *
 * When the deterministic parser cannot read the header, an optional Haiku fallback
 * (`claude -p --model haiku`, no tools) extracts the windows from the trimmed header only; its
 * answer is kept only if every number and time appears literally in that header. The fallback runs
 * only for callers with a long budget (`status`, `doctor`), never on the routing path.
 */

import { tmpdir } from "node:os";
import { z } from "zod";
import { expandTilde, pathApi } from "../../config/pathkey.js";
import type { Clock, ProviderInstance, QuotaWindow, Spawner } from "../../core/contracts.js";
import { homeDir, type OsPlatform } from "../../platform/os.js";
import { DEFAULT_READER_TIMEOUT_MS, type QuotaReadContext, type QuotaReader } from "../reader.js";
import {
  isGrounded,
  kindOfLabel,
  parseUsageHeader,
  resolveReset,
  trimUsageHeader,
  type UsageLine,
} from "./claude-usage-parse.js";
import { buildReaderEnv } from "./env.js";
import { QuotaAuthError, QuotaFormatError, QuotaReaderError } from "./errors.js";

export const CLAUDE_USAGE_ID = "claude-usage";
/** `source` of readings extracted by the Haiku fallback. */
export const CLAUDE_USAGE_LLM_SOURCE = "claude-usage+llm";
/** The fallback only runs when the read may take at least this long (never on the routing path). */
export const LLM_FALLBACK_MIN_TIMEOUT_MS = 20_000;

/** argv of the quota read. */
export const CLAUDE_USAGE_ARGV = ["-p", "/usage", "--safe-mode"] as const;
/** argv of the Haiku fallback: no tools, one turn, no session file, JSON result. */
export const CLAUDE_USAGE_LLM_ARGV = [
  "-p",
  "--safe-mode",
  "--model",
  "haiku",
  "--tools",
  "",
  "--max-turns",
  "1",
  "--output-format",
  "json",
  "--no-session-persistence",
] as const;

const AUTH_ERROR = /not logged in|log ?in|sign ?in|authenticat|unauthori[sz]ed|credential|expired/i;

const LlmResultSchema = z.object({ result: z.string(), is_error: z.boolean().optional() });
const LlmWindowsSchema = z.object({
  windows: z.array(
    z.object({
      label: z.string().min(1),
      usedPercent: z.number().min(0).max(100),
      resetText: z.string().nullish(),
      timeZone: z.string().nullish(),
    }),
  ),
});

/** Prompt of the fallback; `header` is the trimmed quota header and nothing else. */
export function llmPrompt(header: string): string {
  return [
    "Extract the usage limits from the text between the markers. Answer with strict JSON only, no prose:",
    '{"windows":[{"label":"<text between \\"Current\\" and the colon>","usedPercent":<number>,"resetText":"<reset date/time as written, without the zone>","timeZone":"<IANA zone in parentheses, or null>"}]}',
    "Copy values literally; never invent one. Use an empty list when there is none.",
    "<<<",
    header,
    ">>>",
  ].join("\n");
}

/** Options of {@link ClaudeUsageReader}. */
export interface ClaudeUsageOptions {
  spawner: Spawner;
  clock: Clock;
  /** Environment the child env is derived from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Working directory (default: the OS temp dir; `/usage` needs no repository). */
  cwd?: string;
  timeoutMs?: number;
  /** Haiku fallback when the header cannot be parsed (default true). */
  llmFallback?: boolean;
  /** Zone assumed for reset times without one (default: the local zone). */
  localZone?: string;
  /** Platform whose path and env rules apply (default `process.platform`). */
  platform?: OsPlatform;
  /** Resolves the binary (config `binary:` -> PATH -> well-known dirs); default: `instance.binary ?? "claude"`. */
  resolveBinary?: (instance: ProviderInstance) => string | Promise<string>;
}

/** Reads Claude quota from `claude -p /usage`. */
export class ClaudeUsageReader implements QuotaReader {
  readonly id = CLAUDE_USAGE_ID;
  readonly version = "1";
  readonly channel = "cli:/usage";
  readonly llmFallback: boolean;
  /** Set once a reset time without a zone was read in the local zone (shown by `doctor`). */
  zoneAssumed = false;
  readonly #opts: ClaudeUsageOptions;

  constructor(options: ClaudeUsageOptions) {
    this.#opts = options;
    this.llmFallback = options.llmFallback !== false;
  }

  async read(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<QuotaWindow[]> {
    // An API-key account has no subscription windows; `/usage` would only describe billing.
    if (instance.pool === "api_credit") return [];
    const o = this.#opts;
    const timeoutMs = ctx?.timeoutMs ?? o.timeoutMs ?? DEFAULT_READER_TIMEOUT_MS;
    const started = o.clock.monotonicMs();
    const { out } = await this.#run(instance, [...CLAUDE_USAGE_ARGV], timeoutMs, ctx);
    const header = trimUsageHeader(out.join("\n"));
    out.length = 0; // the breakdown is dropped right here
    const parsed = parseUsageHeader(header);
    let problem = parsed.problem;
    if (parsed.ok) {
      const windows = this.#windows(parsed.lines, this.id);
      const unresolved = parsed.lines.find((l) => l.resetText && !windows.get(l.kind)?.resetAt);
      if (!unresolved) return [...windows.values()];
      problem = `unreadable reset time "${unresolved.resetText}"`;
    } else if (!/^\s*current\b/im.test(header) && AUTH_ERROR.test(header)) {
      throw new QuotaAuthError(this.id, "claude /usage reports no login");
    }

    const left = timeoutMs - (o.clock.monotonicMs() - started);
    if (!this.llmFallback || timeoutMs < LLM_FALLBACK_MIN_TIMEOUT_MS || header === "") {
      throw new QuotaFormatError(this.id, problem ?? "unreadable /usage output");
    }
    return this.#fallback(instance, header, left, ctx);
  }

  /** Runs `claude` with `argv`; throws on timeout or a non-zero exit. */
  async #run(
    instance: ProviderInstance,
    argv: string[],
    timeoutMs: number,
    ctx: QuotaReadContext | undefined,
    stdin?: string,
  ): Promise<{ out: string[]; err: string[] }> {
    const o = this.#opts;
    const base = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    const env = buildReaderEnv(base, instance, undefined, platform);
    if (instance.configDir) {
      const dir = expandTilde(instance.configDir, homeDir(env, platform), platform);
      if (pathApi(platform).isAbsolute(dir)) env.CLAUDE_CONFIG_DIR = dir;
    }
    // Dispatch's own hooks stay inert in the child.
    env.DISPATCH_DEPTH = String((Number.parseInt(base.DISPATCH_DEPTH ?? "", 10) || 0) + 1);
    const out: string[] = [];
    const err: string[] = [];
    const binary = o.resolveBinary
      ? await o.resolveBinary(instance)
      : (instance.binary ?? "claude");
    const result = await o.spawner.spawn({
      binary,
      argv,
      env,
      cwd: o.cwd ?? tmpdir(),
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      onLine: (stream, line) => (stream === "stdout" ? out : err).push(line),
    });
    if (result.timedOut) {
      throw new QuotaReaderError(this.id, `claude ${argv[1]} timed out after ${timeoutMs} ms`);
    }
    if (result.exitCode !== 0) {
      const auth = err.some((l) => AUTH_ERROR.test(l));
      const how = result.signal ?? `code ${result.exitCode}`;
      if (auth) throw new QuotaAuthError(this.id, `claude exited with ${how}`);
      throw new QuotaReaderError(this.id, `claude ${argv[1] ?? ""} exited with ${how}`.trim());
    }
    return { out, err };
  }

  /** Haiku fallback over the trimmed header; grounded or nothing. */
  async #fallback(
    instance: ProviderInstance,
    header: string,
    timeoutMs: number,
    ctx: QuotaReadContext | undefined,
  ): Promise<QuotaWindow[]> {
    const { out } = await this.#run(
      instance,
      [...CLAUDE_USAGE_LLM_ARGV],
      timeoutMs,
      ctx,
      llmPrompt(header),
    );
    const reply = LlmResultSchema.safeParse(parseJson(out.join("\n")));
    if (!reply.success || reply.data.is_error) {
      throw new QuotaFormatError(this.id, "the fallback answered with no usable result");
    }
    const answer = LlmWindowsSchema.safeParse(parseJson(reply.data.result));
    if (!answer.success)
      throw new QuotaFormatError(this.id, "the fallback answer is not valid JSON");
    const lines: UsageLine[] = [];
    for (const w of answer.data.windows) {
      if (!isGrounded(header, w)) {
        throw new QuotaFormatError(this.id, "the fallback answer is not grounded in /usage");
      }
      const kind = kindOfLabel(w.label);
      if (!kind) continue;
      lines.push({
        label: w.label,
        kind,
        usedPct: w.usedPercent,
        resetText: w.resetText ?? null,
        timeZone: w.timeZone ?? null,
      });
    }
    if (lines.length === 0) throw new QuotaFormatError(this.id, "no window in /usage");
    return [...this.#windows(lines, CLAUDE_USAGE_LLM_SOURCE).values()];
  }

  /** Windows by kind; `zoneAssumed` is updated when a reset had no zone. */
  #windows(lines: readonly UsageLine[], source: string): Map<string, QuotaWindow> {
    const now = this.#opts.clock.now();
    const byKind = new Map<string, QuotaWindow>();
    for (const l of lines) {
      const reset = l.resetText
        ? resolveReset(l.resetText, l.timeZone, now, this.#opts.localZone)
        : null;
      if (reset?.zoneAssumed) this.zoneAssumed = true;
      byKind.set(l.kind, {
        kind: l.kind,
        usedPct: l.usedPct,
        resetAt: reset?.iso ?? null,
        source,
        readAt: now.toISOString(),
        reliability: "real",
      });
    }
    return byKind;
  }
}

/** JSON in `text`: the whole text, else the outermost `{…}` (models sometimes fence it). */
function parseJson(text: string): unknown {
  const attempts = [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      // next candidate
    }
  }
  return undefined;
}
