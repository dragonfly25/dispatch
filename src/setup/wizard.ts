/**
 * The interactive part of `dispatch setup` (spec §10): it asks only what Dispatch cannot find
 * out by itself, in four questions: the client you mainly use, the plan of each provider, the
 * starting strategy and the autonomy of delegated agents. Answers already given by flags or an
 * answers file are not asked again.
 */
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  AGY_WARNING,
  AUTONOMIES,
  MAIN_HOSTS,
  type MainHost,
  planChoices,
  type SetupAnswers,
  STRATEGIES,
  UNKNOWN_PLAN,
} from "./answers.js";
import type { DetectedCli, Detector } from "./detect.js";

/** Collaborators of the wizard; the CLI wires them to the terminal. */
export interface WizardDeps {
  io: { out(text: string): void; err(text: string): void };
  /** Shows `question` and resolves the raw answer line. */
  ask(question: string): Promise<string>;
  detect: Detector;
  env: Readonly<Record<string, string | undefined>>;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

const MAX_TRIES = 3;

const STRATEGY_LABEL: Record<(typeof STRATEGIES)[number], string> = {
  balance: "send each task to the provider with the most quota left",
  preserve: "spare your main client's quota; delegate more",
  specialize: "let the type of task decide the provider",
};
const AUTONOMY_LABEL: Record<(typeof AUTONOMIES)[number], string> = {
  "read-only": "delegated agents read and report; they never write",
  worktree: "they edit an isolated git worktree; you review the diff",
  direct: "they edit your working tree directly (opt-in, risky)",
};
const HOST_LABEL: Record<MainHost, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  none: "no preference",
};

/** Asks until the answer is a number or name from `options` (Enter = `def`). */
async function choose<T extends string>(
  deps: WizardDeps,
  title: string,
  options: readonly Choice<T>[],
  def: T,
): Promise<T> {
  const defIndex = Math.max(
    0,
    options.findIndex((o) => o.value === def),
  );
  const lines = options.map(
    (o, i) => `  ${i + 1}) ${o.value.padEnd(12)} ${o.label}${i === defIndex ? " (default)" : ""}`,
  );
  deps.io.out(`\n${title}\n${lines.join("\n")}\n`);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const raw = (await deps.ask(`Choice [${defIndex + 1}]: `)).trim().toLowerCase();
    if (raw === "") return options[defIndex]?.value ?? def;
    const byNumber = /^\d+$/.test(raw) ? options[Number(raw) - 1] : undefined;
    const hit = byNumber ?? options.find((o) => o.value.toLowerCase() === raw);
    if (hit) return hit.value;
    deps.io.out(`Please answer with a number from 1 to ${options.length} or a name.\n`);
  }
  throw new DispatchError(
    `no valid answer to "${title}"; run \`dispatch setup\` again or pass the answer as a flag`,
    ExitCode.USAGE,
    "setup.bad_answer",
  );
}

async function yesNo(deps: WizardDeps, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await deps.ask(`${question} [y/N] `)).trim());
}

/** Best guess of the client the user works in: the host we run under, else what is installed. */
export function guessHost(env: WizardDeps["env"], found: readonly DetectedCli[]): MainHost {
  if (env.CLAUDECODE) return "claude-code";
  if (env.CODEX_THREAD_ID) return "codex";
  const has = (id: string) => found.some((c) => c.id === id && c.installed);
  return has("claude") ? "claude-code" : has("codex") ? "codex" : "none";
}

function describeFound(c: DetectedCli): string {
  if (!c.installed) return `${c.id}: not found`;
  const login =
    c.loggedIn === true ? "logged in" : c.loggedIn === false ? "NOT logged in" : "login unknown";
  return `${c.id} ${c.version ?? ""} (${login})`.replace("  ", " ");
}

async function askPlan(
  deps: WizardDeps,
  id: string,
  found: DetectedCli | undefined,
  def: string,
): Promise<string> {
  const options: Choice<string>[] = [
    ...planChoices(id).map((p) => ({ value: p, label: "" })),
    { value: UNKNOWN_PLAN, label: "I do not know / skip" },
  ];
  if (found?.loggedIn === false) {
    deps.io.out(`Note: ${id} is installed but not logged in; log in with its own CLI later.\n`);
  }
  return choose(
    deps,
    `Which ${id} plan do you pay for?`,
    options,
    options.some((o) => o.value === def) ? def : UNKNOWN_PLAN,
  );
}

/**
 * Runs the wizard. `preset` holds what flags already answered; `current` the answers found in an
 * existing config (`--reconfigure`), used as defaults and to avoid re-asking about Antigravity.
 * Returns the answers to apply (only what was decided).
 */
export async function runWizard(
  deps: WizardDeps,
  preset: SetupAnswers,
  current: SetupAnswers | null,
): Promise<SetupAnswers> {
  const cur: SetupAnswers = current ?? { plans: {} };
  const out: SetupAnswers = { plans: { ...preset.plans } };
  deps.io.out("Dispatch setup: four questions, then the host integrations.\n");

  const found = await deps.detect(["claude", "codex"]);
  deps.io.out(`Detected: ${found.map(describeFound).join("; ")}\n`);

  // 1. Main client.
  out.mainHost =
    preset.mainHost ??
    (await choose(
      deps,
      "Which client do you mainly work in?",
      MAIN_HOSTS.map((h) => ({ value: h, label: HOST_LABEL[h] })),
      cur.mainHost ?? guessHost(deps.env, found),
    ));

  // 2. Plans of the installed providers.
  for (const c of found) {
    if (preset.plans[c.id] !== undefined) continue;
    if (!c.installed) continue;
    out.plans[c.id] = await askPlan(deps, c.id, c, cur.plans[c.id] ?? UNKNOWN_PLAN);
  }
  await askAntigravity(deps, preset, cur, out);

  // 3. Strategy.
  const customProfile =
    cur.profile !== undefined && !(STRATEGIES as readonly string[]).includes(cur.profile);
  if (preset.profile !== undefined) out.profile = preset.profile;
  else if (!customProfile) {
    out.profile = await choose(
      deps,
      "Which strategy should Dispatch start with?",
      STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABEL[s] })),
      (cur.profile as (typeof STRATEGIES)[number] | undefined) ?? "balance",
    );
  }

  // 4. Autonomy of delegated agents.
  const autonomy =
    preset.autonomy ??
    (await choose(
      deps,
      "How much may delegated agents do on their own?",
      AUTONOMIES.map((a) => ({ value: a, label: AUTONOMY_LABEL[a] })),
      cur.autonomy ?? "worktree",
    ));
  out.autonomy = autonomy;
  if (autonomy === "direct" && cur.autonomy !== "direct") {
    const sure = (
      await deps.ask('Direct lets agents change your working tree. Type "direct" to confirm: ')
    )
      .trim()
      .toLowerCase();
    if (sure !== "direct") {
      deps.io.out("Not confirmed: using worktree.\n");
      out.autonomy = "worktree";
    }
  }
  return out;
}

/**
 * Antigravity is experimental and restricted by Google's terms: it is only probed, asked about
 * and written after an explicit opt-in and a typed "yes" to the terms.
 */
async function askAntigravity(
  deps: WizardDeps,
  preset: SetupAnswers,
  cur: SetupAnswers,
  out: SetupAnswers,
): Promise<void> {
  const already = cur.enableAntigravity === true;
  let warned = false;
  const warn = (): void => {
    if (!warned) deps.io.out(`\n${AGY_WARNING}\n`);
    warned = true;
  };
  let enable = preset.enableAntigravity;
  if (enable === undefined && !already) {
    warn();
    enable = await yesNo(deps, "Do you want to enable Antigravity anyway?");
  }
  if (enable === true && !already) {
    let accepted = preset.acceptAgyTerms === true;
    if (!accepted) {
      warn();
      const typed = await deps.ask(
        'Type "yes" to confirm you accept the risk and Google\'s terms: ',
      );
      accepted = typed.trim().toLowerCase() === "yes";
    }
    if (!accepted) {
      deps.io.out("Terms not accepted: Antigravity stays off.\n");
      return;
    }
    const [agy] = await deps.detect(["antigravity"]);
    if (!agy?.installed) {
      deps.io.out(
        "agy was not found on PATH: Antigravity stays off (install it, then run `dispatch setup --reconfigure`).\n",
      );
      return;
    }
    out.enableAntigravity = true;
    out.acceptAgyTerms = true;
  }
  if ((enable === true || already) && preset.plans.antigravity === undefined) {
    out.plans.antigravity = await askPlan(
      deps,
      "antigravity",
      undefined,
      cur.plans.antigravity ?? UNKNOWN_PLAN,
    );
  }
}

/** Human-readable lines for the answers that will be written. */
export function describeAnswers(a: SetupAnswers): string[] {
  const lines: string[] = [];
  if (a.mainHost) lines.push(`main client: ${a.mainHost}`);
  if (a.profile) lines.push(`strategy (profile): ${a.profile}`);
  if (a.autonomy) lines.push(`autonomy of delegated agents: ${a.autonomy}`);
  const plans = Object.entries(a.plans).map(([id, p]) => `${id}=${p}`);
  lines.push(`plans: ${plans.length > 0 ? plans.join(", ") : "none declared (unknown)"}`);
  if (a.enableAntigravity !== undefined) {
    lines.push(`antigravity: ${a.enableAntigravity ? "enabled (terms accepted)" : "disabled"}`);
  }
  return lines;
}
