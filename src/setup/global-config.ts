/**
 * The global `~/.dispatch/config.yaml` written by `dispatch setup`: a fully commented file (every
 * option explained, like the repo template in `src/install/config-template.ts`) whose active keys
 * are the setup answers, and an in-place update (`--reconfigure`) that keeps comments and keys
 * Dispatch does not know.
 */
import { existsSync, readFileSync } from "node:fs";
import { isMap, isScalar, parse, parseDocument } from "yaml";
import { parseYaml } from "../config/load.js";
import { CURRENT_VERSION, GlobalConfigFileSchema } from "../config/schema.js";
import { writeAtomic } from "../config/trust.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  FORWARD_MCP_GRANT,
  MAIN_HOSTS,
  type MainHost,
  PROVIDER_IDS,
  planChoices,
  type ResolvedAnswers,
  type SetupAnswers,
  UNKNOWN_PLAN,
} from "./answers.js";

const comment = (lines: readonly string[]): string =>
  lines.map((l) => `# ${l}`.trimEnd()).join("\n");

/** Commented example of a provider that has no active keys (relative indentation kept). */
function providerExample(id: string): string[] {
  const plans = planChoices(id);
  return [`${id}:`, `  plan: ${plans[0]}   # ${plans.join(" | ")}`];
}

const INTRO_PROVIDERS = [
  "Provider instances, merged over the built-in claude / codex / antigravity. Per instance:",
  "  plan              subscription plan, feeds the quota estimate when no real reading exists",
  "                    (claude: pro | max5x | max20x, codex: plus | pro | business,",
  "                    antigravity: pro | ultra); leave it out when you do not know it",
  "  enabled           false stops Dispatch from ever starting this instance (default true;",
  "                    antigravity default false)",
  "  adapter, pool     adapter id (default: the key) and billing pool (default subscription)",
  "  config_dir        CLAUDE_CONFIG_DIR / CODEX_HOME of a second account of the same CLI",
  "  binary            absolute path of the CLI when it is not on PATH",
  "  max_autonomy      read-only | worktree | direct ceiling for this instance",
  "  concurrency       max concurrent runs on this instance",
  "  thresholds        { soft: 20, hard: 5 } remaining-% limits for this instance",
  "  effort_shift      effort levels to shift when delegating here (negative = cheaper)",
  "  env_passthrough   extra environment variables handed to the child CLI",
  "  tos_acknowledged  antigravity only: you accepted Google's terms for wrapping `agy`",
];

/** The `providers:` section: active entries for what was answered, commented examples for the rest. */
function providersSection(a: ResolvedAnswers): string {
  const active: string[] = [];
  const inactive: string[] = [];
  for (const id of PROVIDER_IDS) {
    const lines: string[] = [];
    if (id === "antigravity" && a.enableAntigravity) {
      lines.push("enabled: true", "tos_acknowledged: true");
    }
    const plan = a.plans[id];
    if (plan && plan !== UNKNOWN_PLAN) lines.push(`plan: ${plan}`);
    if (lines.length > 0) active.push(`  ${id}:`, ...lines.map((l) => `    ${l}`));
    else inactive.push(...providerExample(id));
  }
  // `providers:` with nothing under it would be null, which the schema rejects: comment it all.
  if (active.length === 0) {
    return comment([...INTRO_PROVIDERS, "providers:", ...inactive.map((l) => `  ${l}`)]);
  }
  const rest = inactive.map((l) => `  # ${l}`);
  return `${comment(INTRO_PROVIDERS)}\nproviders:\n${[...active, ...rest].join("\n")}`;
}

interface Option {
  explain: string[];
  example: string[];
}

/** Documentation of every key setup does not set. Each example is commented out. */
const OTHER_OPTIONS: Option[] = [
  {
    explain: [
      "Tier used when the host (your main agent) names no model for a task.",
      "inherit = the host's own tier, classify = guess it from the task, or a tier name",
      "(fast | balanced | max). Default: balanced.",
    ],
    example: ["unspecified_model: balanced"],
  },
  {
    explain: [
      "Pins: rules evaluated before anything else, whatever the profile. Same shape as the",
      "rules in profiles/*.yaml; the first match wins. Example: keep migrations on the host.",
    ],
    example: [
      "pins:",
      "  - id: migrations-stay-on-host",
      "    description: Never delegate database migrations.",
      '    match: { paths: ["db/migrations/**"] }',
      "    action: { type: host }",
    ],
  },
  {
    explain: [
      "Tier presets (mappings/*.yaml): how the host's model and effort map onto each provider.",
      "mappings.preset picks one: mirror (same tier everywhere, default), economy (effort -1),",
      "or your own file. mappings.direct pins one host model to a specific provider model.",
    ],
    example: [
      "mappings:",
      "  preset: mirror",
      "  direct:",
      "    - { from_model: claude-opus-*, instance: codex, model: gpt-5, effort: high }",
    ],
  },
  {
    explain: [
      "Quota thresholds per provider instance, in remaining %. Below `soft` the instance is",
      "avoided when possible; below `hard` it is never used. Defaults: soft 20, hard 5.",
    ],
    example: ["thresholds:", "  codex: { soft: 30, hard: 10 }"],
  },
  {
    explain: [
      "Profiles evaluated in shadow mode next to the active one, to compare decisions",
      "(`dispatch status --compare`). They never change what runs.",
    ],
    example: ["shadow_profiles: [preserve]"],
  },
  {
    explain: ["Timeouts for delegated tasks, in milliseconds. Default: 600000 (10 minutes)."],
    example: ["timeouts:", "  default_task_ms: 600000"],
  },
  {
    explain: [
      "SECURITY: limits for delegated tasks (a repo can only tighten them, never loosen).",
      "  allowed_providers  instance ids that may be used (absent = every enabled instance)",
      "  concurrency        max concurrent runs per instance and in total (defaults 2 and 4)",
      "  max_depth          `run` refuses when DISPATCH_DEPTH >= max_depth (default 1)",
      "  network            agent shell network (localhost, Docker, internet): off (default) |",
      "                     delegated-agents | all; network_agents: [names] narrows it.",
      "                     RISK: unsupervised agents with network (docs/security.md T15)",
      "  worktree           bootstrap: none | symlink-readonly, symlink_paths, keep",
    ],
    example: [
      "allowed_providers: [claude, codex]",
      "concurrency: { per_provider: 2, total: 4 }",
      "max_depth: 1",
      "network: off",
      "worktree: { bootstrap: none, symlink_paths: [], keep: false }",
    ],
  },
  {
    explain: [
      "How long `dispatch gc` keeps finished runs and their history, in days. Default: 30.",
    ],
    example: ["retention_days: 30"],
  },
  {
    explain: [
      "Quota reading: minutes a real reading stays fresh (default 5); `enabled: false` switches",
      "one instance's reader off.",
    ],
    example: ["quota:", "  cache_minutes: 5", "  readers:", "    codex: { enabled: false }"],
  },
];

/** Active line, or the commented example when the user did not choose. */
const keyed = (explain: readonly string[], line: string | null, example: string): string =>
  `${comment(explain)}\n${line ?? `# ${example}`}`;

/**
 * Renders the global config for `a`. Every option is explained; the answers are active keys, the
 * rest is commented out. The output always passes {@link GlobalConfigFileSchema}.
 */
export function renderGlobalConfig(a: ResolvedAnswers): string {
  const host: MainHost = a.mainHost;
  const sections = [
    comment([
      "Dispatch global configuration: your accounts and preferences, for every repository.",
      "Written by `dispatch setup`; edit it freely, `dispatch validate` checks it and",
      "`dispatch doctor` shows what it does. `dispatch setup --reconfigure` changes the answers",
      "below and keeps your comments.",
      "",
      "Precedence for ordinary keys: flags > trusted repo .dispatch/config.yaml > this file >",
      "defaults. Keys marked SECURITY can only be tightened by a repo, never loosened.",
      "`dispatch trust` records the policies of the repos you trust in `trusted_repos` below.",
    ]),
    `version: ${CURRENT_VERSION}`,
    keyed(
      [
        "Client you mainly work in (claude-code | codex). Informational: host-independent",
        "commands may use it as a default. Remove the line for no preference.",
      ],
      host === "none" ? null : `main_host: ${host}`,
      "main_host: claude-code",
    ),
    keyed(
      [
        "Routing strategy = profile: balance (most quota left), preserve (spare the host),",
        "specialize (task type decides), off (never delegate). Your own file in",
        "~/.dispatch/profiles/ works too. A trusted repo may choose another one.",
      ],
      `profile: ${a.profile}`,
      "profile: balance",
    ),
    keyed(
      [
        "SECURITY: autonomy ceiling for delegated tasks.",
        "  read-only  they may read the repo and report, never write",
        "  worktree   they edit an isolated git worktree; you review the diff (default)",
        "  direct     they edit your working tree. Opt in only if you accept that.",
      ],
      `autonomy: ${a.autonomy}`,
      "autonomy: worktree",
    ),
    providersSection(a),
    `${comment([
      "Host integrations. hosts.claude-code.forward_mcp is a TRUST GRANT (SECURITY):",
      `"${FORWARD_MCP_GRANT}".`,
      `Only servers whose env/header values are \${VAR} references are forwarded, by variable name;`,
      "a repo or flag can only turn it off. hosts.claude-code.forward_web (default true) gives agents",
      "that use WebSearch/WebFetch web access when delegated; false keeps them on Claude.",
      "hosts.claude-code.browser is a TRUST GRANT (SECURITY): the isolated browser (Playwright MCP,",
      "installed Google Chrome, temporary profile, localhost only) for agents that use the desktop",
      "browser tools; `dispatch setup --refresh --yes` installs it. They also need `network`.",
      "Also: hard (default true), intercept, and hosts.codex.hard.",
    ])}\nhosts:\n  claude-code:\n    forward_mcp: ${a.forwardMcp}\n    browser: ${a.browser}`,
    ...OTHER_OPTIONS.map((o) => `${comment(o.explain)}\n${comment(o.example)}`),
  ];
  const text = `${sections.join("\n\n")}\n`;
  // A bug guard: a generated config that its own loader rejects must never reach the disk.
  parseYaml(text, "generated config", GlobalConfigFileSchema);
  return text;
}

/** Reads the answers already in `text` (lenient: unknown or odd values are skipped). */
export function currentAnswers(text: string): SetupAnswers {
  const out: SetupAnswers = { plans: {} };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return out;
  }
  if (raw === null || typeof raw !== "object") return out;
  const doc = raw as Record<string, unknown>;
  if ((MAIN_HOSTS as readonly unknown[]).includes(doc.main_host)) {
    out.mainHost = doc.main_host as MainHost;
  }
  if (typeof doc.profile === "string") out.profile = doc.profile;
  if (doc.autonomy === "read-only" || doc.autonomy === "worktree" || doc.autonomy === "direct") {
    out.autonomy = doc.autonomy;
  }
  const forward = (doc.hosts as { "claude-code"?: { forward_mcp?: unknown } } | null | undefined)?.[
    "claude-code"
  ]?.forward_mcp;
  if (typeof forward === "boolean") out.forwardMcp = forward;
  const browser = (doc.hosts as { "claude-code"?: { browser?: unknown } } | null | undefined)?.[
    "claude-code"
  ]?.browser;
  if (typeof browser === "boolean") out.browser = browser;
  const providers = doc.providers;
  if (providers && typeof providers === "object") {
    type P = { plan?: unknown; enabled?: unknown; tos_acknowledged?: unknown } | null;
    for (const [id, p] of Object.entries(providers as Record<string, P>)) {
      if (typeof p?.plan === "string") out.plans[id] = p.plan;
      if (id === "antigravity" && p?.enabled === true) {
        out.enableAntigravity = true;
        out.acceptAgyTerms = p.tos_acknowledged === true;
      }
    }
  }
  return out;
}

/**
 * Applies `a` to an existing config text through the YAML document model, so comments, ordering
 * and keys Dispatch does not know all survive. Only what was answered changes.
 */
export function updateGlobalConfig(text: string, a: SetupAnswers, source: string): string {
  const doc = parseDocument(text);
  const bad = (why: string): DispatchError =>
    new DispatchError(`${source}: ${why}`, ExitCode.USAGE, "config.invalid");
  if (doc.errors.length > 0) throw bad(doc.errors[0]?.message ?? "invalid YAML");
  if (!isMap(doc.contents)) throw bad("expected a YAML mapping at the top level");
  const set = (path: string[], value: unknown): void => {
    // `providers:` left empty parses as null; replace it with a mapping so it can hold keys.
    if (path[0] === "providers" && isScalar(doc.get("providers", true))) {
      doc.set("providers", doc.createNode({}));
    }
    doc.setIn(path, value);
  };
  if (a.mainHost === "none") doc.delete("main_host");
  else if (a.mainHost) set(["main_host"], a.mainHost);
  if (a.profile) set(["profile"], a.profile);
  if (a.autonomy) set(["autonomy"], a.autonomy);
  for (const [id, plan] of Object.entries(a.plans)) {
    if (plan === UNKNOWN_PLAN) {
      if (doc.hasIn(["providers", id, "plan"])) doc.deleteIn(["providers", id, "plan"]);
    } else set(["providers", id, "plan"], plan);
  }
  if (a.enableAntigravity === true) {
    set(["providers", "antigravity", "enabled"], true);
    set(["providers", "antigravity", "tos_acknowledged"], a.acceptAgyTerms === true);
  }
  if (a.forwardMcp !== undefined) {
    for (const path of [["hosts"], ["hosts", "claude-code"]]) {
      if (isScalar(doc.getIn(path, true))) doc.setIn(path, doc.createNode({}));
    }
    doc.setIn(["hosts", "claude-code", "forward_mcp"], a.forwardMcp);
  }
  if (a.browser !== undefined) {
    for (const path of [["hosts"], ["hosts", "claude-code"]]) {
      if (isScalar(doc.getIn(path, true))) doc.setIn(path, doc.createNode({}));
    }
    doc.setIn(["hosts", "claude-code", "browser"], a.browser);
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * Writes the config atomically with mode 0600. `create` refuses to replace a file that appeared
 * since the plan was made (setup never overwrites a config).
 */
export function writeGlobalConfig(path: string, text: string, mode: "create" | "update"): void {
  if (mode === "create" && existsSync(path)) {
    throw new DispatchError(
      `${path} already exists; use \`dispatch setup --reconfigure\` to change it`,
      ExitCode.USAGE,
      "setup.config_exists",
    );
  }
  writeAtomic(path, text);
}

/** The text of an existing config, or null. */
export function readConfigText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
