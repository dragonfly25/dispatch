/**
 * The interactive part of `dispatch setup` (spec §10): it asks only what Dispatch cannot find
 * out by itself, in four questions: the client you mainly use, the plan of each provider, the
 * starting strategy and the autonomy of delegated agents. Answers already given by flags or an
 * answers file are not asked again.
 */
import { BROWSER_DETAIL, BROWSER_GRANT } from "../browser/install.js";
import {
  AGY_WARNING,
  AUTONOMIES,
  FORWARD_MCP_DETAIL,
  FORWARD_MCP_GRANT,
  MAIN_HOSTS,
  type MainHost,
  planChoices,
  type SetupAnswers,
  STRATEGIES,
  UNKNOWN_PLAN,
} from "./answers.js";
import type { DetectedCli, Detector } from "./detect.js";
import { type Choice, linePrompter, type Prompter } from "./prompter.js";

/** Collaborators of the wizard; the CLI wires them to the terminal. */
export interface WizardDeps {
  io: { out(text: string): void; err(text: string): void };
  /** Shows `question` and resolves the raw answer line. */
  ask(question: string): Promise<string>;
  detect: Detector;
  env: Readonly<Record<string, string | undefined>>;
  /** How questions are asked (default: the numbered readline prompter over `io` and `ask`). */
  prompter?: Prompter;
}

/** Number of setup steps shown as "Step n/4". */
const STEPS = 4;
const step = (n: number, title: string): string => `Step ${n}/${STEPS} · ${title}`;

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

/** `✔ claude 2.1.0 (logged in)` / `● codex not found`, for the rich prompter. */
function detectedLine(c: DetectedCli): string {
  return c.installed ? `✔ ${describeFound(c)}` : `● ${c.id} not found`;
}

async function askPlan(
  p: Prompter,
  id: string,
  found: DetectedCli | undefined,
  def: string,
): Promise<string> {
  const options: Choice<string>[] = [
    ...planChoices(id).map((p) => ({ value: p, label: "" })),
    { value: UNKNOWN_PLAN, label: "I do not know / skip" },
  ];
  if (found?.loggedIn === false) {
    p.info(`Note: ${id} is installed but not logged in; log in with its own CLI later.`);
  }
  return p.select(
    step(2, `Which ${id} plan do you pay for?`),
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
  const p = deps.prompter ?? linePrompter(deps.io, deps.ask);
  const cur: SetupAnswers = current ?? { plans: {} };
  const out: SetupAnswers = { plans: { ...preset.plans } };
  if (!p.rich) p.info("Dispatch setup: four questions, then the host integrations.");

  const found = await deps.detect(["claude", "codex"]);
  if (p.rich) p.note("Detected CLIs", found.map(detectedLine).join("\n"));
  else p.info(`Detected: ${found.map(describeFound).join("; ")}`);

  // 1. Main client.
  out.mainHost =
    preset.mainHost ??
    (await p.select(
      step(1, "Which client do you mainly work in?"),
      MAIN_HOSTS.map((h) => ({ value: h, label: HOST_LABEL[h] })),
      cur.mainHost ?? guessHost(deps.env, found),
    ));

  // 2. Plans of the installed providers.
  for (const c of found) {
    if (preset.plans[c.id] !== undefined) continue;
    if (!c.installed) continue;
    out.plans[c.id] = await askPlan(p, c.id, c, cur.plans[c.id] ?? UNKNOWN_PLAN);
  }
  await askAntigravity(deps, p, preset, cur, out);

  // 3. Strategy.
  const customProfile =
    cur.profile !== undefined && !(STRATEGIES as readonly string[]).includes(cur.profile);
  if (preset.profile !== undefined) out.profile = preset.profile;
  else if (!customProfile) {
    out.profile = await p.select(
      step(3, "Which strategy should Dispatch start with?"),
      STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABEL[s] })),
      (cur.profile as (typeof STRATEGIES)[number] | undefined) ?? "balance",
    );
  }

  // 4. Autonomy of delegated agents.
  const autonomy =
    preset.autonomy ??
    (await p.select(
      step(4, "How much may delegated agents do on their own?"),
      AUTONOMIES.map((a) => ({ value: a, label: AUTONOMY_LABEL[a] })),
      cur.autonomy ?? "worktree",
    ));
  out.autonomy = autonomy;
  if (autonomy === "direct" && cur.autonomy !== "direct") {
    const sure = (
      await p.text('Direct lets agents change your working tree. Type "direct" to confirm: ')
    )
      .trim()
      .toLowerCase();
    if (sure !== "direct") {
      p.info("Not confirmed: using worktree.");
      out.autonomy = "worktree";
    }
  }

  // Trust grant: MCP forwarding (default yes, as the owner approved; consent is asked once).
  if (preset.forwardMcp !== undefined) out.forwardMcp = preset.forwardMcp;
  else {
    p.note(`Trust grant · ${FORWARD_MCP_GRANT}`, FORWARD_MCP_DETAIL);
    const choice = await p.select(
      `${FORWARD_MCP_GRANT}?`,
      [
        { value: "yes", label: `yes, with \${VAR} secrets passed by name only` },
        { value: "no", label: "no, agents that use MCP tools stay on Claude" },
      ],
      cur.forwardMcp === false ? "no" : "yes",
    );
    out.forwardMcp = choice === "yes";
  }

  // Trust grant: the isolated browser (default yes, as the owner approved; it downloads ~19 MB).
  if (preset.browser !== undefined) out.browser = preset.browser;
  else {
    p.note(`Trust grant · ${BROWSER_GRANT}`, BROWSER_DETAIL);
    const choice = await p.select(
      `${BROWSER_GRANT}?`,
      [
        { value: "yes", label: "yes, download it now (temporary profile, localhost only)" },
        { value: "no", label: "no, agents that use the desktop browser tools stay on Claude" },
      ],
      cur.browser === false ? "no" : "yes",
    );
    out.browser = choice === "yes";
  }
  return out;
}

/**
 * Antigravity is experimental and restricted by Google's terms: it is only probed, asked about
 * and written after an explicit opt-in and a typed "yes" to the terms.
 */
async function askAntigravity(
  deps: WizardDeps,
  p: Prompter,
  preset: SetupAnswers,
  cur: SetupAnswers,
  out: SetupAnswers,
): Promise<void> {
  const already = cur.enableAntigravity === true;
  let warned = false;
  const warn = (): void => {
    if (!warned) p.warn(AGY_WARNING);
    warned = true;
  };
  let enable = preset.enableAntigravity;
  if (enable === undefined && !already) {
    warn();
    enable = await p.confirm("Do you want to enable Antigravity anyway?");
  }
  if (enable === true && !already) {
    let accepted = preset.acceptAgyTerms === true;
    if (!accepted) {
      warn();
      const typed = await p.text('Type "yes" to confirm you accept the risk and Google\'s terms: ');
      accepted = typed.trim().toLowerCase() === "yes";
    }
    if (!accepted) {
      p.info("Terms not accepted: Antigravity stays off.");
      return;
    }
    const [agy] = await deps.detect(["antigravity"]);
    if (!agy?.installed) {
      p.info(
        "agy was not found on PATH: Antigravity stays off (install it, then run `dispatch setup --reconfigure`).",
      );
      return;
    }
    out.enableAntigravity = true;
    out.acceptAgyTerms = true;
  }
  if ((enable === true || already) && preset.plans.antigravity === undefined) {
    out.plans.antigravity = await askPlan(
      p,
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
  if (a.forwardMcp !== undefined) {
    lines.push(`trust grant · ${FORWARD_MCP_GRANT}: ${a.forwardMcp ? "yes" : "no"}`);
  }
  if (a.browser !== undefined) {
    lines.push(`trust grant · ${BROWSER_GRANT}: ${a.browser ? "yes" : "no"}`);
  }
  return lines;
}
