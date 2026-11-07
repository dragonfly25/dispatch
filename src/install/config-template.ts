/** The commented `.dispatch/config.yaml` written by `dispatch install` (spec §10). */
import { CURRENT_VERSION } from "../config/schema.js";

/** Values the user chose at install time; `undefined` keeps the commented default. */
export interface TemplateChoices {
  profile?: string;
  unspecifiedModel?: string;
}

/** Renders one option: the explanation, then either the active value or a commented example. */
function option(lines: string[], key: string, chosen: string | undefined, example: string): string {
  const body = lines.map((l) => `# ${l}`);
  body.push(chosen === undefined ? `# ${key}: ${example}` : `${key}: ${chosen}`);
  return body.join("\n");
}

/**
 * Renders the repo config. Every option is explained and commented out (an empty policy), except
 * the ones passed in `choices`. Security keys are tighten-only here: the global config wins.
 */
export function renderRepoConfig(choices: TemplateChoices = {}): string {
  const sections = [
    [
      "# Dispatch policy for this repository (committed; shared by the whole team).",
      "#",
      "# Nothing in this file applies until it is trusted: run `dispatch trust` after every edit",
      "# (`dispatch install` did it once). Check your changes with `dispatch validate`, and see what",
      '# they do with `dispatch explain --task "..."`.',
      "#",
      "# Precedence for ordinary keys: flags > this file > ~/.dispatch/config.yaml > defaults.",
      "# Keys marked SECURITY can only be tightened here, never loosened.",
      `version: ${CURRENT_VERSION}`,
    ].join("\n"),
    option(
      [
        "Tier used when the host (your main agent) names no model for a task.",
        "inherit = the host's own tier, classify = guess it from the task, or a tier name",
        "(fast | balanced | max). Default: balanced.",
      ],
      "unspecified_model",
      choices.unspecifiedModel,
      "balanced",
    ),
    option(
      [
        "Routing profile: the rules that choose which provider takes a task. Shipped profiles",
        "live in .dispatch/profiles/: balance (most quota left), preserve (spare the host),",
        "specialize (task type decides), off (never delegate). Add your own file there.",
        "Default: balance.",
      ],
      "profile",
      choices.profile,
      "balance",
    ),
    [
      "# Pins: rules evaluated before anything else, whatever the profile. Same shape as the",
      "# rules in profiles/*.yaml; the first match wins. Example: keep migrations on the host.",
      "# pins:",
      "#   - id: migrations-stay-on-host",
      "#     description: Never delegate database migrations.",
      '#     match: { paths: ["db/migrations/**"] }',
      "#     action: { type: host }",
    ].join("\n"),
    [
      "# Tier presets (mappings/*.yaml): how the host's model and effort map onto each provider.",
      "# mappings.preset picks one: mirror (same tier everywhere, default), economy (effort -1),",
      "# or your own file. mappings.direct pins one host model to a specific provider model.",
      "# mappings:",
      "#   preset: mirror",
      "#   direct:",
      "#     - { from_model: claude-opus-*, instance: codex, model: gpt-5, effort: high }",
    ].join("\n"),
    [
      "# Quota thresholds per provider instance, in remaining %. Below `soft` the instance is",
      "# avoided when possible; below `hard` it is never used. Defaults: soft 20, hard 5.",
      "# thresholds:",
      "#   codex: { soft: 30, hard: 10 }",
    ].join("\n"),
    [
      "# Profiles evaluated in shadow mode next to the active one, to compare decisions",
      "# (`dispatch status --compare`). They never change what runs.",
      "# shadow_profiles: [preserve]",
    ].join("\n"),
    [
      "# Timeouts for delegated tasks, in milliseconds. Default: 600000 (10 minutes).",
      "# timeouts:",
      "#   default_task_ms: 600000",
    ].join("\n"),
    [
      "# SECURITY (tighten-only): limits for delegated tasks. The strictest of this file and",
      "# ~/.dispatch/config.yaml wins.",
      "#   autonomy           ceiling for delegated tasks: read-only < worktree < direct",
      "#   allowed_providers  instance ids that may be used (absent = every enabled instance)",
      "#   concurrency        max concurrent runs per instance and in total",
      "#   max_depth          `run` refuses when DISPATCH_DEPTH >= max_depth (default 1)",
      "#   network            network access for child agents: off | on (default off)",
      "#   worktree           bootstrap: none | symlink-readonly, symlink_paths, keep",
      "#   providers          per instance: enabled, binary, max_autonomy, concurrency, effort_shift",
      "# autonomy: worktree",
      "# allowed_providers: [codex, claude]",
      "# concurrency: { per_provider: 2, total: 4 }",
      "# max_depth: 1",
      "# network: off",
      "# worktree: { bootstrap: none, symlink_paths: [], keep: false }",
      "# providers:",
      "#   codex: { max_autonomy: worktree }",
    ].join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}
