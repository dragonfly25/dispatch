/**
 * Generates `docs/configuration.md` from the zod schemas in `src/config/schema.ts` (types, allowed
 * values and descriptions come from `z.toJSONSchema` of those schemas) and from the built-in
 * defaults in `src/config/defaults.ts`.
 *
 *   pnpm docs:config                  # rewrites docs/configuration.md
 *   test/unit/docs-config.test.ts     # fails when the committed file is stale
 *
 * The prose around the tables, the notes and the annotated examples live in this file. The
 * examples are exported and validated against the real schemas by the test, so they cannot rot.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defaultSettings } from "../src/config/defaults.js";
import { newProvider } from "../src/config/merge.js";
import {
  GlobalConfigFileSchema,
  MappingFileSchema,
  ProfileFileSchema,
  RepoConfigFileSchema,
  RuleFileSchema,
} from "../src/config/schema.js";
import { DEFAULT_EFFORTS, DEFAULT_TIERS } from "../src/core/contracts.js";

type Json = Record<string, unknown>;

/** One documented key. */
interface Row {
  /** Dotted path with `<id>` for map keys and `[]` for list items. */
  path: string;
  type: string;
  allowed: string;
  required: boolean;
  /** The key (or one of its parents) is a SECURITY key. */
  security: boolean;
  description: string;
}

const SECURITY_PREFIX = /^SECURITY\.\s*/;
/** Zod emits the safe-integer bounds for `.int()`; they are noise in a reference. */
const HUGE = 1e15;

/** Placeholder for the free-form key of a map, by the name of the map. */
const KEY_NAME: Record<string, string> = {
  providers: "<instance>",
  thresholds: "<instance>",
  readers: "<instance>",
  models: "<adapter>",
  tiers: "<tier>",
  trusted_repos: "<repo-id>",
};
const keyName = (mapPath: string): string => KEY_NAME[mapPath.split(".").pop() ?? ""] ?? "<id>";

const schemaOf = (s: z.ZodType): Json => z.toJSONSchema(s, { io: "input" }) as Json;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const code = (v: unknown): string => `\`${typeof v === "string" ? v : JSON.stringify(v)}\``;

// ---------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------

function numberRange(n: Json): string {
  const isInt = n.type === "integer";
  const min = typeof n.minimum === "number" && Math.abs(n.minimum) < HUGE ? n.minimum : undefined;
  const xmin = typeof n.exclusiveMinimum === "number" ? n.exclusiveMinimum : undefined;
  const max = typeof n.maximum === "number" && Math.abs(n.maximum) < HUGE ? n.maximum : undefined;
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  if (min !== undefined) return `at least ${min}`;
  if (xmin !== undefined) return isInt ? `at least ${xmin + 1}` : `greater than ${xmin}`;
  if (max !== undefined) return `at most ${max}`;
  return "";
}

function typeOf(n: Json): string {
  if (n.oneOf) return "object";
  if (n.anyOf) return "string";
  if (n.enum) return "enum";
  if (n.type === "array") {
    const items = obj(n.items);
    return items ? `list of ${typeOf(items)}` : "list";
  }
  if (n.type === "object") {
    const values = obj(n.additionalProperties);
    return values && !n.properties ? `map of ${typeOf(values)}` : "object";
  }
  return typeof n.type === "string" ? n.type : "any";
}

function allowedOf(n: Json): string {
  if (Array.isArray(n.oneOf)) {
    return `\`type\`: ${(n.oneOf as Json[]).map((v) => code(obj(obj(v.properties)?.type)?.const)).join(" | ")}`;
  }
  if (Array.isArray(n.enum)) return n.enum.map(code).join(" | ");
  if (n.const !== undefined) return code(n.const);
  if (Array.isArray(n.anyOf)) {
    const consts = (n.anyOf as Json[]).filter((a) => a.const !== undefined).map((a) => a.const);
    return [...consts.map(code), "any other non-empty string"].join(" | ");
  }
  if (n.type === "array") {
    const items = obj(n.items) ?? {};
    const inner = Array.isArray(items.enum) ? `items: ${allowedOf(items)}` : "";
    const min = typeof n.minItems === "number" ? `at least ${n.minItems} item(s)` : "";
    return [inner, min].filter(Boolean).join("; ");
  }
  if (n.type === "object") {
    const values = obj(n.additionalProperties);
    if (!values || n.properties) return "";
    const inner = allowedOf(values);
    return inner ? `values: ${inner}` : "";
  }
  return numberRange(n);
}

/** Parent `SECURITY.` flags propagate to children (a child key of a security key is one too). */
function walk(
  node: Json,
  path: string,
  inheritedSecurity: boolean,
  rows: Row[],
  stop: ReadonlySet<string>,
): void {
  const props = obj(node.properties);
  if (!props) return;
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  for (const [key, raw] of Object.entries(props)) {
    const child = obj(raw) ?? {};
    const childPath = path === "" ? key : `${path}.${key}`;
    const rawDescription = typeof child.description === "string" ? child.description : "";
    const security = inheritedSecurity || SECURITY_PREFIX.test(rawDescription);
    rows.push({
      path: childPath,
      type: typeOf(child),
      allowed: allowedOf(child),
      required: required.has(key),
      security,
      description: rawDescription.replace(SECURITY_PREFIX, ""),
    });
    if (stop.has(childPath)) continue;
    descend(child, childPath, security, rows, stop);
  }
}

function descend(
  child: Json,
  childPath: string,
  security: boolean,
  rows: Row[],
  stop: ReadonlySet<string>,
): void {
  if (child.properties) walk(child, childPath, security, rows, stop);
  const values = obj(child.additionalProperties);
  if (child.type === "object" && values?.properties) {
    walk(values, `${childPath}.${keyName(childPath)}`, security, rows, stop);
  }
  const items = obj(child.items);
  if (child.type === "array" && items?.properties)
    walk(items, `${childPath}[]`, security, rows, stop);
  if (Array.isArray(child.oneOf)) unionRows(child.oneOf as Json[], childPath, rows);
}

/** Fields of the variants of a discriminated union (`action`), one row per field. */
function unionRows(variants: Json[], path: string, rows: Row[]): void {
  const fields = new Map<string, { node: Json; types: string[]; required: boolean }>();
  rows.push({
    path: `${path}.type`,
    type: "enum",
    allowed: variants.map((v) => code(obj(obj(v.properties)?.type)?.const)).join(" | "),
    required: true,
    security: false,
    description: "What the rule does with a matching task.",
  });
  for (const v of variants) {
    const props = obj(v.properties) ?? {};
    const tag = String(obj(props.type)?.const ?? "?");
    const req = new Set(Array.isArray(v.required) ? (v.required as string[]) : []);
    for (const [name, raw] of Object.entries(props)) {
      if (name === "type") continue;
      const prev = fields.get(name);
      const node = obj(raw) ?? {};
      fields.set(name, {
        node: prev?.node ?? node,
        types: [...(prev?.types ?? []), tag],
        required: (prev?.required ?? true) && req.has(name),
      });
    }
  }
  for (const [name, f] of fields) {
    // A bound that differs between variants (fallback: >= 1, fanout: >= 2) is explained in a note.
    const allowed = new Set(
      variants.flatMap((v) => {
        const node = obj(obj(v.properties)?.[name]);
        return node ? [allowedOf(node)] : [];
      }),
    );
    rows.push({
      path: `${path}.${name}`,
      type: typeOf(f.node),
      allowed: allowed.size === 1 ? allowedOf(f.node) : "",
      required: f.required,
      security: false,
      description: `Used by action type ${f.types.map(code).join(", ")}.`,
    });
  }
}

function collect(schema: z.ZodType, stop: readonly string[] = []): Row[] {
  const rows: Row[] = [];
  walk(schemaOf(schema), "", false, rows, new Set(stop));
  return rows;
}

// ---------------------------------------------------------------------------
// Defaults and hand-written notes
// ---------------------------------------------------------------------------

function fmtDefault(v: unknown): string {
  if (typeof v === "string") return code(v);
  if (v === null) return "`null`";
  return `\`${JSON.stringify(v)}\``;
}

/** Defaults by row path, derived from `defaultSettings()` and `newProvider()`. */
function buildDefaults(): Map<string, string> {
  const out = new Map<string, string>();
  const flatten = (value: unknown, path: string) => {
    const o = obj(value);
    if (o && Object.keys(o).length > 0) {
      for (const [k, v] of Object.entries(o)) flatten(v, path === "" ? k : `${path}.${k}`);
    } else out.set(path, fmtDefault(value));
  };
  const { providers: _providers, ...settings } = defaultSettings();
  flatten(settings, "");
  out.set("allowed_providers", "every enabled instance");
  const p = newProvider("x");
  out.set("thresholds.<instance>.soft", fmtDefault(p.thresholds.soft));
  out.set("thresholds.<instance>.hard", fmtDefault(p.thresholds.hard));
  out.set("providers.<instance>.adapter", "the instance id");
  out.set("providers.<instance>.enabled", `\`${p.enabled}\` (\`antigravity\`: \`false\`)`);
  out.set("providers.<instance>.pool", fmtDefault(p.pool));
  out.set(
    "providers.<instance>.max_autonomy",
    `${fmtDefault(p.max_autonomy)} (\`antigravity\`: \`read-only\`)`,
  );
  out.set("providers.<instance>.thresholds.soft", fmtDefault(p.thresholds.soft));
  out.set("providers.<instance>.thresholds.hard", fmtDefault(p.thresholds.hard));
  out.set("providers.<instance>.effort_shift", fmtDefault(p.effort_shift));
  out.set("providers.<instance>.env_passthrough", fmtDefault(p.env_passthrough));
  out.set("providers.<instance>.tos_acknowledged", fmtDefault(p.tos_acknowledged));
  out.set("providers.<instance>.concurrency", "`concurrency.per_provider`");
  return out;
}

/** Notes appended to a row's description. Every key must be a real row (checked on generation). */
const NOTES: Record<string, string> = {
  "match.task_type":
    "Free-form; the shipped profiles use test, docs, refactor, review, feature and bugfix.",
  "action.instance": "Instance id that takes the task.",
  "action.instances":
    "`fallback` needs at least one instance, `fanout` at least two. For `fanout`, instances that are filtered out are dropped; with fewer than two left it degrades to one instance or the host.",
  "action.strategy":
    "`ordered` tries the instances as written; `most_remaining` sorts them by remaining quota first. Default `ordered`.",
  "action.reason": "Why the task is refused; shown to the caller and in `explain`.",
  providers:
    "Keys are instance ids. The built-in instances are `claude`, `codex` and `antigravity`; add more such as `claude-alt` (a second account, see `config_dir`). A repo file can only tighten instances that exist here; it cannot add one.",
  "providers.<instance>.adapter":
    "Must name a shipped adapter: `claude`, `codex` or `antigravity`.",
  "providers.<instance>.binary":
    "A repo or flag value that differs from the global one is rejected. Without it Dispatch resolves the CLI via PATH and the usual install directories.",
  "providers.<instance>.max_autonomy":
    "The effective ceiling is the lower of this and the top-level `autonomy`. `antigravity` is always capped to `read-only`; the claude and codex adapters refuse `direct`.",
  "providers.<instance>.concurrency":
    "Capped by `concurrency.per_provider`; a repo can only lower it.",
  "providers.<instance>.tos_acknowledged":
    "Without it a consumer-login `antigravity` stays disabled with a warning.",
  "providers.<instance>.env_passthrough":
    "Names matching host markers, API keys or tokens are dropped even when listed. A repo can only shrink the list.",
  "providers.<instance>.config_dir":
    "For `claude` it becomes `CLAUDE_CONFIG_DIR` of the child (must be absolute, `~/` allowed); for `codex` `CODEX_HOME`.",
  unspecified_model: `Valid tiers: ${DEFAULT_TIERS.map(code).join(", ")}. \`classify\` is not implemented in v0.1 and behaves like \`balanced\`; \`inherit\` needs an observed host model and otherwise also falls back to \`balanced\`.`,
  allowed_providers:
    "A repo or flag list can only remove ids (it is intersected with the global one); adding an id is rejected.",
  max_depth:
    "Delegated children run with `DISPATCH_DEPTH` set, so at the default of 1 a child cannot start another run.",
  "worktree.bootstrap":
    "`symlink-readonly` links `symlink_paths` into the worktree read-only; a repo can only choose `none` when the global value is `symlink-readonly`.",
  "worktree.symlink_paths": "A repo list must be a subset of the global one.",
  "worktree.keep": "A repo or flag cannot turn this on when it is off.",
  profile: "A profile with this name must exist: shipped, global or (trusted) repo.",
  "mappings.preset": "A preset with this name must exist: shipped, global or (trusted) repo.",
  pins: "Same rule shape as in a profile; see [Rules](#rules-pins-and-profile-rules).",
  thresholds:
    "Keys must be existing instance ids; an unknown id is a warning. Equivalent to `providers.<instance>.thresholds`.",
  shadow_profiles:
    "Profiles must exist. They are evaluated next to the active one (`status --compare`) and never change what runs.",
  trusted_repos:
    "Do not edit by hand. Not allowed in repo files or flags (they are rejected as unknown keys).",
  "quota.readers": "Routing works with every reader disabled (the estimator takes over).",
  rules:
    "Same rule shape as `pins`; see [Rules](#rules-pins-and-profile-rules). Put a rule without `match` last: it matches every task.",
  "preset.tier_by_task_type": `Tiers: ${DEFAULT_TIERS.map(code).join(", ")}.`,
  "preset.effort_shift": `The shift moves along ${DEFAULT_EFFORTS.map(code).join(" < ")} and is clamped at both ends.`,
  models:
    "Keys are adapter ids (`claude`, `codex`, `antigravity`). A table replaces the adapter's whole shipped table; copy the shipped one first.",
  "models.<adapter>.reverse":
    "Ordered; the first glob that matches the model name the host asked for decides its tier.",
  "models.<adapter>.tiers.<tier>.effort": `Keys are Dispatch efforts (${DEFAULT_EFFORTS.map(code).join(", ")}); values are what the CLI is given.`,
};

/** Where a key may appear, when the schema alone cannot say. */
const WHERE_OVERRIDES: Record<string, string> = {
  version: "every file",
  "providers.<instance>.binary": "global only",
  providers: "global; repo and flags only tighten existing instances",
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escapes a table cell; text inside backtick spans is left alone. */
const cell = (s: string): string =>
  s
    .split("`")
    .map((part, i) =>
      i % 2 === 1
        ? part.replaceAll("|", "\\|")
        : part
            .replaceAll("|", "\\|")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("*", "\\*"),
    )
    .join("`")
    .replaceAll("\n", " ");

function describe(row: Row): string {
  return [row.description, NOTES[row.path]].filter(Boolean).join(" ");
}

function whereOf(row: Row, inRepo: boolean): string {
  const override = WHERE_OVERRIDES[row.path];
  if (override) return override;
  if (!inRepo) return "global only";
  return row.security ? "global; repo and flags only tighten" : "global, repo, flags";
}

function table(header: string[], lines: string[][]): string {
  const head = `| ${header.join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  return [head, sep, ...lines.map((l) => `| ${l.map(cell).join(" | ")} |`)].join("\n");
}

const keyCell = (r: Row): string => `\`${r.path}\``;
const typeCell = (r: Row): string => (r.required ? `${r.type}, required` : r.type);

function configTable(defaults: Map<string, string>): { text: string; paths: Set<string> } {
  const global = collect(GlobalConfigFileSchema, ["pins"]);
  const repoPaths = new Set(collect(RepoConfigFileSchema, ["pins"]).map((r) => r.path));
  const lines = global.map((r) => [
    keyCell(r),
    typeCell(r),
    defaults.get(r.path) ?? "",
    r.allowed,
    whereOf(r, repoPaths.has(r.path)),
    describe(r),
  ]);
  return {
    text: table(["Key", "Type", "Default", "Allowed values", "Where", "Description"], lines),
    paths: new Set(global.map((r) => r.path)),
  };
}

function plainTable(rows: Row[], defaults: Map<string, string>): string {
  const lines = rows.map((r) => [
    keyCell(r),
    typeCell(r),
    defaults.get(r.path) ?? "",
    r.allowed,
    describe(r),
  ]);
  return `${table(["Key", "Type", "Default", "Allowed values", "Description"], lines)}\n`;
}

// ---------------------------------------------------------------------------
// Annotated examples (validated against the real schemas by test/unit/docs-config.test.ts)
// ---------------------------------------------------------------------------

/** Annotated example files; each parses with the schema of its kind. */
export const EXAMPLES = {
  global: `# ~/.dispatch/config.yaml  (or $DISPATCH_HOME/config.yaml)
version: 1

main_host: claude-code                   # informational: the client you mainly work in

# Provider instances. claude, codex and antigravity exist without being listed; list one to
# describe your account (plan) or to change a setting. Add instances for extra accounts.
providers:
  claude:
    plan: max
  codex:
    plan: plus
    thresholds: { soft: 30, hard: 10 }   # avoid below 30% remaining, never use below 10%
  claude-alt:                            # a second Claude account of the same adapter
    adapter: claude
    config_dir: ~/.claude-alt            # becomes CLAUDE_CONFIG_DIR of the child
    plan: pro
    max_autonomy: read-only              # this account only reviews
  antigravity:                           # experimental, read-only, off by default
    enabled: true
    tos_acknowledged: true               # required for a consumer login (see the README)

# SECURITY keys: you may set anything here; a repo or flag can only tighten them.
autonomy: worktree                       # ceiling: read-only < worktree < direct
concurrency: { per_provider: 2, total: 4 }
max_depth: 1
network: off
worktree: { bootstrap: none, symlink_paths: [], keep: false }

# Ordinary keys: flags > trusted repo > this file > defaults.
profile: balance
unspecified_model: balanced
mappings:
  preset: mirror
timeouts:
  default_task_ms: 600000
shadow_profiles: [preserve]              # evaluated next to the active profile, never executed
quota:
  cache_minutes: 5
  readers:
    codex: { enabled: true }

# Written by \`dispatch trust\`; do not edit by hand.
# trusted_repos:
#   /home/me/src/app/.git:
#     hash: <sha256>
#     files: { .dispatch/config.yaml: <sha256> }
#     trusted_at: "2026-11-07T09:00:00.000Z"
`,
  repo: `# <repo>/.dispatch/config.yaml  (committed; applies only after \`dispatch trust\`)
version: 1

# Ordinary keys override the global file.
profile: preserve
unspecified_model: balanced
pins:                                    # evaluated before anything else, whatever the profile
  - id: migrations-stay-on-host
    description: Never delegate database migrations.
    match: { paths: ["db/migrations/**"] }
    action: { type: host }
mappings:
  preset: economy
  direct:                                # explicit model mappings; the first match wins
    - { from_model: "claude-opus-*", from_effort: high, instance: codex, model: gpt-6.1-sol, effort: high }
thresholds:
  codex: { soft: 40, hard: 15 }
timeouts:
  default_task_ms: 900000

# SECURITY keys: these can only be tightened. A looser value is ignored and reported as an error.
autonomy: worktree
allowed_providers: [codex, claude]
concurrency: { per_provider: 1, total: 2 }
network: off
worktree: { keep: false }
providers:
  codex: { max_autonomy: worktree }      # lower than the global ceiling is fine
`,
  profile: `# <home or repo>/profiles/team-review.yaml  (the profile name is the file name)
version: 1
description: Reviews on two providers, docs on codex, everything else by remaining quota.
rules:                                   # evaluated top to bottom; the first match wins
  - id: never-delegate-secrets
    match: { paths: ["secrets/**"] }
    action: { type: reject, reason: "secrets/ is never delegated" }

  - id: second-opinion                   # runs on both and returns both results
    description: Reviews run on two accounts.
    match: { task_type: [review], autonomy: [read-only] }
    action: { type: fanout, instances: [codex, claude-alt] }

  - id: docs-on-codex
    match: { task_type: [docs, test] }
    action: { type: provider, instance: codex }

  - id: codex-while-plenty
    match:
      min_remaining_pct: { codex: 30 }   # unknown usage never satisfies this
      reliability: [real, estimated]
    action: { type: provider, instance: codex }

  - id: after-a-quota-hit
    match: { prior_outcome: [quota_exhausted] }
    action: { type: host }

  - id: default                          # no match: takes every task, so keep it last
    action: { type: fallback, instances: [claude, codex], strategy: most_remaining }
`,
  mapping: `# <home or repo>/mappings/thrifty.yaml  (the preset name is the file name)
version: 1
description: Cheap tests and docs, strongest model for reviews.
preset:
  description: One effort level lower; tests and docs on the fast tier, reviews on max.
  effort_shift: -1
  tier_by_task_type: { test: fast, docs: fast, review: max }

# Optional: replace an adapter's model table (this one replaces the whole codex table).
models:
  codex:
    tiers:
      fast: { model: gpt-6-luna, effort: { low: low, medium: medium, high: high }, relative_cost: 1 }
      balanced: { model: gpt-6-sol, effort: { low: low, medium: medium, high: high }, relative_cost: 3 }
      max: { model: gpt-6.1-sol, effort: { low: medium, medium: high, high: xhigh }, relative_cost: 6 }
    reverse:
      - { pattern: "*luna*", tier: fast }
      - { pattern: "*sol*", tier: max }
`,
} as const;

const fence = (yaml: string): string => `\`\`\`yaml\n${yaml.trimEnd()}\n\`\`\``;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const INTRO = `# Configuration reference

> Generated by \`pnpm docs:config\` from \`src/config/schema.ts\` and \`src/config/defaults.ts\`.
> Do not edit by hand: change the schema (every key has a \`.describe()\`) or the generator
> (\`scripts/gen-config-reference.ts\`) and regenerate. \`test/unit/docs-config.test.ts\` fails when this file is stale.

Dispatch is configured with four kinds of YAML file. Every file starts with \`version: 1\`, is
validated strictly (an unknown key is an error, not ignored), and an empty file is the same as
\`version: 1\`. A file with a newer version than this Dispatch supports is refused with a request to
upgrade.

| File | Global location | Repo location | What it holds |
| --- | --- | --- | --- |
| Config | \`~/.dispatch/config.yaml\` (or \`$DISPATCH_HOME/config.yaml\`) | \`<repo>/.dispatch/config.yaml\` | Providers, security limits, active profile and preset, pins, thresholds |
| Profile | \`~/.dispatch/profiles/<name>.yaml\` | \`<repo>/.dispatch/profiles/<name>.yaml\` | A named routing strategy: an ordered list of rules |
| Mapping | \`~/.dispatch/mappings/<name>.yaml\` | \`<repo>/.dispatch/mappings/<name>.yaml\` | A tier preset (named after the file) and/or model tables |
| Shipped | \`assets/profiles\`, \`assets/mappings\`, \`assets/models\` in the package | | \`balance\`, \`preserve\`, \`specialize\`, \`off\`; \`mirror\`, \`economy\`, \`custom\`; one model table per adapter |

A broken **global** config stops the command (exit 2). A broken **repo**, profile or mapping file is
skipped and reported as an error by \`dispatch validate\`; \`run\` then exits 2 instead of routing with a
policy you did not intend.

## Creating the global config: \`dispatch setup\`

\`dispatch setup\` (and \`dispatch install\` the first time) writes a fully commented
\`~/.dispatch/config.yaml\` when none exists, after four questions: the client you mainly use
(\`main_host\`), the plan of each CLI it finds (\`providers.<id>.plan\`), the starting strategy
(\`profile\`: balance, preserve or specialize) and the autonomy of delegated agents (\`autonomy\`,
default \`worktree\`; \`direct\` asks for a typed confirmation). It never overwrites an existing
config; \`dispatch setup --reconfigure\` changes the answers in place and keeps your comments and any
key it does not know. The file is written atomically with mode 0600.

Antigravity is only asked about, probed and written after an explicit opt-in that accepts the
risk and Google's terms (\`enabled: true\` and \`tos_acknowledged: true\`).

For scripts and CI, \`--non-interactive --yes\` takes every answer from flags or a YAML file and
uses the defaults (profile \`balance\`, autonomy \`worktree\`, plans unknown, Antigravity off) for the
rest. Without \`--yes\` it only prints what it would do:

| Flag | Meaning |
| --- | --- |
| \`--answers <file>\` | YAML with \`main_host\`, \`profile\`, \`autonomy\`, \`plans: { claude: max5x }\`, \`antigravity: { enable: true, accept_terms: true }\`; flags win over the file |
| \`--host <id>\` | \`claude-code\`, \`codex\` or \`none\` |
| \`--profile <name>\` | \`balance\`, \`preserve\`, \`specialize\` (or any other profile that exists) |
| \`--autonomy <level>\` | \`read-only\`, \`worktree\` or \`direct\` |
| \`--plan <provider>=<plan>\` | Repeatable, e.g. \`--plan claude=max5x --plan codex=plus\`; \`unknown\` skips the provider |
| \`--enable-antigravity --accept-agy-terms\` | Both are required to enable Antigravity |
| \`--reconfigure\` | Change an existing config instead of keeping it |

## Precedence

For ordinary keys the layers are applied in this order, the later one winning:

1. built-in defaults
2. the global config
3. the repo config, only when trusted (see [Trust](#trust))
4. command-line flags (the same keys as the repo config, no \`version\`)

Profiles and mappings are looked up by name: a file in \`~/.dispatch/profiles/\` replaces a shipped
profile of the same name, and a trusted repo file replaces both. A mapping file's
\`models.<adapter>\` block replaces that adapter's whole table.

### Security keys

Security keys (the ones whose **Where** column says "only tighten") cannot be loosened by a repo or by
flags. The global file is yours and may set anything; the effective value is the **most restrictive**
of global, repo and flags:

| Key | Tighter means |
| --- | --- |
| \`autonomy\`, \`providers.<instance>.max_autonomy\` | lower: \`read-only\` < \`worktree\` < \`direct\` |
| \`allowed_providers\` | a subset (the lists are intersected) |
| \`concurrency.*\`, \`providers.<instance>.concurrency\`, \`max_depth\` | a smaller number |
| \`network\` | \`off\` rather than \`on\` |
| \`worktree.bootstrap\` | \`none\` rather than \`symlink-readonly\`; \`symlink_paths\` a subset; \`keep\` cannot be turned on |
| \`providers.<instance>.enabled\` | a repo can disable an instance, never enable one |
| \`providers.<instance>.env_passthrough\` | a subset |
| \`providers.<instance>.binary\` | global only |

A looser value is **ignored** and reported as an error (\`dispatch validate\` lists it and \`run\` exits
2). A repo can never add a provider instance. Two caps nobody can lift: \`antigravity\` is always
\`read-only\`, and an \`antigravity\` instance on a subscription pool stays disabled until
\`tos_acknowledged: true\`. The effective ceiling of an instance is the lower of its \`max_autonomy\` and
the top-level \`autonomy\`; its concurrency is capped by \`concurrency.per_provider\`.

### Trust

Repo policy is code: it can change where your tasks go. Dispatch therefore ignores the whole
\`.dispatch/\` folder of a repository (\`config.yaml\`, \`profiles/*.yaml\`, \`mappings/*.yaml\`) until you run
\`dispatch trust\` in it (\`dispatch install\` offers this once).

- The repo identity is the real path of its git common directory, so every linked worktree and every symlinked path of one repo share it.
- \`trusted_repos\` in the global config stores a sha256 over the relative path and bytes of every policy file, plus one hash per file.
- Any change (an edited, added or removed file) makes the repo untrusted again: the policy is ignored with a warning that names the files, until you review and run \`dispatch trust\` again.
- A symlink anywhere inside \`.dispatch/\` makes the repo untrusted, and \`dispatch trust\` refuses to record it.
- The bytes that were hashed are the bytes that are parsed (each file is read once), so a file swapped in between cannot change what is applied.

## How a task is routed

The router is a pure function of the stored decision input; \`dispatch explain\` prints the rule chain
it walked and \`explain --replay <id>\` reproduces any logged decision.

1. **Tier and effort are resolved first**, because rules can match on the tier. A model the host asked for is classified through the \`reverse\` tables; otherwise the task's own tier; otherwise \`unspecified_model\`. The active preset then applies \`tier_by_task_type\` and shifts the effort by \`effort_shift\` (clamped to ${DEFAULT_EFFORTS.map(code).join(" < ")}).
2. **Layers, in this fixed order; the first match in a layer ends routing:**
   1. \`pins\` of the config files (whatever the profile)
   2. \`mappings.direct\`: the first entry whose \`from_model\` glob (and \`from_effort\`, if set) matches the model the host asked for; it bypasses tiers
   3. the \`rules\` of the active \`profile\`, top to bottom
   4. the tier preset (it only decides tier and effort, as in step 1)
   5. the default: the task stays on the host
3. **Filters apply to every candidate** of a \`provider\`, \`fallback\` or \`fanout\` action: the host itself is never chosen; disabled instances, instances whose autonomy ceiling is below the task's, and instances marked unavailable after a quota hit are dropped; so is an instance below its \`hard\` threshold. An instance below its \`soft\` threshold is dropped only when another candidate is not. Unknown quota never blocks a candidate.
4. **Actions:** \`provider\` (one instance), \`host\` (stay on the host), \`fallback\` (try the instances in order or by most remaining quota; the host is always the implicit last step), \`fanout\` (run on every listed instance, at least two; fewer survivors degrade to one instance or to the host), \`reject\` (refuse with a reason).

Tiers are ${DEFAULT_TIERS.map(code).join(", ")} and efforts ${DEFAULT_EFFORTS.map(code).join(", ")} in v0.1.

## Config file (\`config.yaml\`)

The same schema serves the global and the repo file. The **Where** column says which layers may set a key.

`;

const RULES_INTRO = `
## Rules: pins and profile rules

A rule is \`id\` + optional \`match\` + \`action\`. All fields present in \`match\` must hold (logical AND);
an empty or missing \`match\` matches every task. List-valued fields match when the task's value is one
of the listed values. \`id\` is what \`explain\` shows in the rule chain.

`;

const PROFILE_INTRO = `
## Profile file (\`profiles/<name>.yaml\`)

The profile name is the file name without \`.yaml\`. Activate one with \`profile:\` in a config file or
\`dispatch use <name>\`. Shipped: \`balance\` (default; most remaining quota), \`preserve\` (the host only
orchestrates), \`specialize\` (task type picks the provider) and \`off\` (never delegate). They are plain
YAML in \`assets/profiles/\`: read and copy them.

`;

const MAPPING_INTRO = `
## Mapping file (\`mappings/<name>.yaml\`)

A mapping file can define a **tier preset** (the preset name is the file name) and/or **model tables**
that replace an adapter's shipped table. Activate a preset with \`mappings.preset\` in a config file.
Shipped presets: \`mirror\` (default; same tier and effort everywhere), \`economy\` (effort -1) and \`custom\`
(an empty template). The shipped model tables are in \`assets/models/<adapter>.yaml\`, which use this same
format with only the \`models:\` block. Explicit \`model -> instance:model:effort\` mappings are not part of
a mapping file: they are \`mappings.direct\` in the config file.

`;

const TAIL = `
## Checking your configuration

- \`dispatch validate\` loads the effective configuration and reports unknown instances, undefined tiers or efforts, models missing from a table, duplicate or contradictory mappings, rules that can never fire (after a catch-all or shadowed by an earlier rule), fanouts without two usable instances, and \`soft\` below \`hard\`. It exits 2 on any error.
- \`dispatch explain --task "..."\` shows which layer and rule decided a task and which candidates were filtered.
- \`dispatch trust\` (re)trusts the repo policy after you reviewed it.
`;

/** Renders the full document. Throws when a hand-written note names a key that no longer exists. */
export function renderConfigReference(): string {
  const defaults = buildDefaults();
  const config = configTable(defaults);
  const rule = collect(RuleFileSchema);
  const profile = collect(ProfileFileSchema, ["rules"]);
  const mapping = collect(MappingFileSchema);
  const known = new Set([
    ...config.paths,
    ...rule.map((r) => r.path),
    ...profile.map((r) => r.path),
    ...mapping.map((r) => r.path),
  ]);
  for (const key of [...Object.keys(NOTES), ...Object.keys(WHERE_OVERRIDES)]) {
    if (!known.has(key)) throw new Error(`gen-config-reference: note for unknown key "${key}"`);
  }

  const parts = [
    INTRO,
    config.text,
    "\n\n### Example: global config\n\n",
    fence(EXAMPLES.global),
    "\n\n### Example: repo config\n\n",
    fence(EXAMPLES.repo),
    "\n",
    RULES_INTRO,
    plainTable(rule, defaults),
    PROFILE_INTRO,
    plainTable(profile, defaults),
    "\nEach entry of `rules` has the shape described under [Rules](#rules-pins-and-profile-rules).\n\n### Example: profile\n\n",
    fence(EXAMPLES.profile),
    "\n",
    MAPPING_INTRO,
    plainTable(mapping, defaults),
    "\n### Example: mapping\n\n",
    fence(EXAMPLES.mapping),
    "\n",
    TAIL,
  ];
  return `${parts.join("")}`;
}

// Run as a script: `pnpm docs:config` writes docs/configuration.md under the current directory.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = resolve(process.cwd(), "docs", "configuration.md");
  writeFileSync(target, renderConfigReference());
  process.stdout.write(`wrote ${target}\n`);
}
