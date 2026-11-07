/**
 * What `dispatch setup` asks (spec §10) and where an answer can come from: the wizard, flags, or
 * an answers file. Everything here is pure data handling; prompting lives in `wizard.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { type Autonomy, AutonomySchema, ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { DEFAULT_PLANS } from "../quota/plans.js";

/** The client the user mainly works in; `none` records no preference. */
export const MAIN_HOSTS = ["claude-code", "codex", "none"] as const;
export type MainHost = (typeof MAIN_HOSTS)[number];

/** Strategies offered by the wizard (they are the shipped profiles of the same name). */
export const STRATEGIES = ["balance", "preserve", "specialize"] as const;
/** Autonomy levels, safest first. */
export const AUTONOMIES: readonly Autonomy[] = AutonomySchema.options;
/** Provider instance ids the wizard knows (the built-in adapters). */
export const PROVIDER_IDS = ["claude", "codex", "antigravity"] as const;
/** Declared when the user does not know their plan: nothing is written for it. */
export const UNKNOWN_PLAN = "unknown";

/** Everything setup can be told. A missing field means "not answered yet". */
export interface SetupAnswers {
  mainHost?: MainHost;
  profile?: string;
  autonomy?: Autonomy;
  /** Provider id → plan id (or {@link UNKNOWN_PLAN}). */
  plans: Record<string, string>;
  /** Antigravity is experimental and off unless both are true. */
  enableAntigravity?: boolean;
  acceptAgyTerms?: boolean;
}

/** Answers with every default applied. */
export interface ResolvedAnswers {
  mainHost: MainHost;
  profile: string;
  autonomy: Autonomy;
  plans: Record<string, string>;
  enableAntigravity: boolean;
}

/** The `setup` / `install` flags that carry answers. */
export interface AnswerFlags {
  answers?: string;
  host?: string;
  profile?: string;
  autonomy?: string;
  plan?: string[];
  enableAntigravity?: boolean;
  acceptAgyTerms?: boolean;
}

/** True when any answer flag was passed. */
export function hasAnswerFlags(f: AnswerFlags): boolean {
  return Boolean(
    f.answers ||
      f.host ||
      f.profile ||
      f.autonomy ||
      f.plan?.length ||
      f.enableAntigravity ||
      f.acceptAgyTerms,
  );
}

const usage = (message: string, code = "setup.bad_answer"): DispatchError =>
  new DispatchError(message, ExitCode.USAGE, code);

/** Plan ids Dispatch can estimate for `provider` (from the built-in plan table). */
export function planChoices(provider: string): string[] {
  return Object.values(DEFAULT_PLANS)
    .filter((p) => p.adapter === provider)
    .map((p) => p.plan);
}

/** Maps a user-typed provider name to an instance id (`agy` is the CLI's name). */
export function providerId(name: string): string {
  const id = name.trim().toLowerCase();
  const mapped = id === "agy" ? "antigravity" : id;
  if (!(PROVIDER_IDS as readonly string[]).includes(mapped)) {
    throw usage(`unknown provider "${name}" (choose: ${PROVIDER_IDS.join(", ")})`);
  }
  return mapped;
}

/** Validates one plan for a provider; returns the canonical (lower-case) id. */
export function checkPlan(provider: string, plan: string): string {
  const p = plan.trim().toLowerCase();
  if (p === UNKNOWN_PLAN || planChoices(provider).includes(p)) return p;
  throw usage(
    `unknown plan "${plan}" for ${provider} (choose: ${[...planChoices(provider), UNKNOWN_PLAN].join(", ")})`,
  );
}

function checkOne<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  const v = value.trim().toLowerCase();
  const hit = allowed.find((a) => a === v);
  if (!hit) throw usage(`unknown ${what} "${value}" (choose: ${allowed.join(", ")})`);
  return hit;
}

const AnswersFileSchema = z
  .object({
    main_host: z.string().optional(),
    profile: z.string().optional(),
    autonomy: z.string().optional(),
    plans: z.record(z.string(), z.string()).optional(),
    antigravity: z
      .object({ enable: z.boolean().optional(), accept_terms: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
type AnswersFile = z.infer<typeof AnswersFileSchema>;

function readAnswersFile(path: string, cwd: string): AnswersFile {
  const file = resolve(cwd, path);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw usage(
      `cannot read the answers file ${file}: ${(err as Error).message}`,
      "setup.answers_file",
    );
  }
  const r = AnswersFileSchema.safeParse(raw ?? {});
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw usage(`${file}: ${why.join("; ")}`, "setup.answers_file");
  }
  return r.data;
}

/** `--plan claude=max5x` → [provider, plan]. */
function splitPlan(spec: string): [string, string] {
  const i = spec.indexOf("=");
  if (i < 1 || i === spec.length - 1) {
    throw usage(`--plan expects <provider>=<plan>, got "${spec}"`);
  }
  return [spec.slice(0, i), spec.slice(i + 1)];
}

/**
 * Turns flags (and the answers file they name) into validated answers. Flags win over the file.
 * Every problem is a usage error naming the value and the accepted choices. `profiles` is the
 * list of profile names that exist (shipped plus the user's own).
 */
export function presetAnswers(
  flags: AnswerFlags,
  profiles: readonly string[],
  cwd: string = process.cwd(),
): SetupAnswers {
  const file: AnswersFile = flags.answers ? readAnswersFile(flags.answers, cwd) : {};
  const out: SetupAnswers = { plans: {} };
  const host = flags.host ?? file.main_host;
  if (host) out.mainHost = checkOne("host", host, MAIN_HOSTS);
  const profile = flags.profile ?? file.profile;
  if (profile) out.profile = checkOne("profile", profile, profiles);
  const autonomy = flags.autonomy ?? file.autonomy;
  if (autonomy) out.autonomy = checkOne("autonomy", autonomy, AUTONOMIES);
  const fromFile = Object.entries(file.plans ?? {});
  for (const [name, plan] of [...fromFile, ...(flags.plan ?? []).map(splitPlan)]) {
    const id = providerId(name);
    out.plans[id] = checkPlan(id, plan);
  }
  const enable = flags.enableAntigravity ?? file.antigravity?.enable;
  const accept = flags.acceptAgyTerms ?? file.antigravity?.accept_terms;
  if (enable !== undefined) out.enableAntigravity = enable;
  if (accept !== undefined) out.acceptAgyTerms = accept;
  return out;
}

/** The Antigravity ToS warning (Google's FAQ); shown before it can be enabled. */
export const AGY_WARNING = [
  "Antigravity (agy) is EXPERIMENTAL and restricted by Google's terms.",
  'Google\'s FAQ says wrapping `agy` in third-party tools is "not supported under consumer plans"',
  "and may get the account suspended. Dispatch keeps it off by default and read-only.",
].join("\n");

/** Fails unless Antigravity consent is complete (both the opt-in and the terms). */
export function assertAgyConsent(a: SetupAnswers): void {
  if (a.enableAntigravity === true && a.acceptAgyTerms !== true) {
    throw usage(
      "Antigravity needs explicit consent: pass --enable-antigravity together with --accept-agy-terms",
      "setup.agy_terms",
    );
  }
}

/** Applies the defaults to everything still unanswered (after checking Antigravity consent). */
export function withDefaults(a: SetupAnswers): ResolvedAnswers {
  assertAgyConsent(a);
  return {
    mainHost: a.mainHost ?? "none",
    profile: a.profile ?? "balance",
    autonomy: a.autonomy ?? "worktree",
    plans: a.plans,
    enableAntigravity: a.enableAntigravity === true,
  };
}
