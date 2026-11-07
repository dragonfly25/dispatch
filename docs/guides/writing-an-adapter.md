# Writing an adapter

An adapter teaches Dispatch to drive one provider CLI headlessly: how to probe it, how to build its
command line, how to read its output, and how to decide how a run ended. The three shipped adapters
are worked examples of everything below:

| Adapter id | CLI | Code | Why read it |
| --- | --- | --- | --- |
| `claude` | `claude -p` | `src/adapters/claude/` | Passive quota from the stream, fail-closed OS sandbox, credential deny rules |
| `codex` | `codex exec` | `src/adapters/codex/` | Side-effect guards, feature probing, output file, quota from an out-of-band reader |
| `antigravity` | `agy` | `src/adapters/agy/` | Experimental and read-only, prompt in argv, no isolation switches |

The running example in this guide is a fictional CLI called `acme`. Its flags and event names are
placeholders: **every flag, event and message you put in a real adapter must come from a spike on the
real CLI** (step 1), never from this page.

Read first: [`docs/PLAN.md`](../PLAN.md) (section 2), [ADR 0002](../adr/0002-wp1-contract-freeze.md) and
the spikes in [`docs/spikes/`](../spikes/README.md). The contracts live in `src/core/contracts.ts` and
are frozen: this guide only uses them, and says where a change would need a new ADR.

## 0. The shape of an adapter

```ts
interface Adapter {
  readonly caps: AdapterCapabilities;
  probe(instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult>;
  buildInvocation(args: BuildInvocationArgs): Invocation;
  parseLine(stream: "stdout" | "stderr", line: string, ctx: AdapterRunContext): NormalizedEvent[];
  finalize(result: SpawnResult & { durationMs: number }, ctx: AdapterRunContext): AdapterOutcome;
  readQuota?(instance: ProviderInstance, deps: AdapterDeps): Promise<QuotaWindow[]>;
}
```

The life of one delegated task:

```text
probe()            what is installed? (version, flags, features, login)       no quota spent
buildInvocation()  pure: argv + env + cwd + stdin, from the router's target
   runner spawns   (only src/runner may import child_process) ...
parseLine()        once per output line -> NormalizedEvent[]; state in ctx.scratch
finalize()         once, after the child ended -> AdapterOutcome (success | failed | timeout |
                   quota_exhausted | rejected)
```

Rules that follow from the architecture:

- **Adapters never spawn processes.** Everything goes through the injected `AdapterDeps.spawner`
  (`scripts/check-boundaries.mjs` fails the build on `child_process` outside `src/runner/`). That is
  also what makes adapters testable with `ScriptedSpawner`.
- **`buildInvocation`, `parseLine` and `finalize` are pure** apart from reading `ctx`. No filesystem,
  no `process.env`, no clock other than the one in `ctx.scratch`.
- **Fail closed.** If isolation cannot be enforced, throw; do not run with less than you promised.
- **Never read, copy, log or forward credentials.** The CLI finds its own login through `HOME` or its
  config-dir variable.

## 1. Run a spike first

Do not write code until you have recorded how the real CLI behaves. The WP1 spike did this for the
three shipped CLIs ([`docs/spikes/`](../spikes/README.md)); copy its method into
`docs/spikes/<cli>.md` and answer, with evidence (a recorded fixture or a quoted source line):

| Question | Decides |
| --- | --- |
| How does a headless, non-interactive run start, and does it stream machine-readable events? | `streaming`, `parseLine` |
| Can the prompt come from stdin? (agy cannot: `-p -` is taken literally.) | `promptChannel` |
| Which flags switch off the user's hooks, plugins, MCP servers and project config? | `isolation`, side-effect guards |
| What enforces "read-only" and "workspace-write"? An OS sandbox, or only permission prompts auto-denied in headless mode? | `autonomy`, `sandbox` |
| Can the child reach the network? | `childNetwork` |
| Does a run write to the user's global files (codex persists project trust into `~/.codex/config.toml`)? | `sideEffectGuards` |
| What does a refused tool action look like, and what exit code does the CLI use when it was refused? (agy ends `SUCCESS`, exit 0.) | `deniedActions`, `finalize` |
| How is quota exhaustion signalled: an event, an error, a message, an exit code? | `finalize`, `QuotaSignal` |
| Is there an official, quota-free way to read usage, or is it only visible in the run's own stream? | quota channel |
| How do you ask for the version, the flags and the login state without spending quota? | `probe` |
| How does a second account work (config dir variable)? | `ProviderInstance.configDir` |

Record real runs as fixtures (step 11) while you are at it. Use tiny prompts and the cheapest model.

## 2. Capabilities

`caps` is static and validated by `AdapterCapabilitiesSchema`. Every field is a claim `doctor`
discloses to the user, so it must be true:

| Field | Meaning | claude | codex | antigravity |
| --- | --- | --- | --- | --- |
| `id` | Adapter id; what `providers.<id>.adapter` names | `claude` | `codex` | `antigravity` |
| `version` | Adapter version | `0.1.0` | `0.1.0` | `0.1.0` |
| `cliRange` | Semver range of the CLI you have fixtures for | `>=2.1.301 <2.2` | `>=0.167.0 <0.168` | `>=1.5.2 <1.6` |
| `streaming` | Output arrives line by line while it runs | yes | yes | yes |
| `autonomy` | Levels you can **enforce** | read-only, worktree | read-only, worktree | read-only |
| `quotaChannel` | `passive` (from the run's stream), `reader` (out-of-band), `passive+reader`, `none` | passive+reader | reader | reader |
| `pool` | Billing pool: `subscription`, `api_credit`, `unknown` | subscription | subscription | subscription |
| `experimental` | Off by default and flagged | no | no | yes |
| `promptChannel` | `stdin` or `argv` | stdin | stdin | argv |
| `isolation.userHooks` / `userPlugins` / `userMcp` / `projectConfig` | `disabled`, `not_disableable`, or (plugins only) `builtin_only` | disabled / builtin_only / disabled / disabled | disabled in all four | `not_disableable` in all four |
| `sandbox` | Who enforces the filesystem boundary: `os` or `permission-only` | os | os | permission-only |
| `childNetwork` | `none`, `allowlist`, `open` for the child's shell commands | none | none | none |

Never list a level in `autonomy` that you cannot enforce: `direct` is refused by all three shipped
adapters. `createClaudeAdapter({ pool })` shows how an adapter reports the pool of the instance it
serves (`ProviderInstance.pool`) when that differs from the default.

## 3. `probe`

```ts
probe(instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult>
```

`ProbeResult` is `{ binaryPath, realpath, version, flags, features, loggedIn, outsideCliRange }`.

- Resolve the binary with `deps.resolveBinary(name, instance)` (config `binary:`, then PATH, then the
  usual install directories). Not found: return all `null`/empty, `outsideCliRange: false`.
- Run `--version`, `--help` (collect flags) and, if the CLI has one, a **quota-free** login check
  (`codex login status`; `agy -p=/usage --output-format json`) through `deps.spawner`, each with a
  timeout (the shipped probes use 15 s) and an allow-listed environment (`PATH HOME USER LANG TMPDIR
  SHELL LC_*`, `TERM=dumb`, plus the instance's config-dir variable).
- **Never throw.** Wrap each spawn; a failed probe reports what it could not learn (`null`).
- `realpath` is `realpathSync(binaryPath)`; Homebrew Caskroom paths carry the version.
- `features` is for CLIs that list their feature flags (codex: `codex features list`). Otherwise `[]`.
- `outsideCliRange` is `true` when the version cannot be read or is outside `caps.cliRange`. The run
  is still allowed; `doctor` warns, because a CLI that auto-updates (agy) can change its output format
  under you. The shipped helpers: `satisfiesRange` in `src/adapters/agy/version.ts` and in
  `src/adapters/claude/probe.ts` (comparators such as `>=1.5.2 <1.6`). Reuse or copy one; do not add a
  dependency for it.

## 4. `buildInvocation`

```ts
buildInvocation(args: BuildInvocationArgs): Invocation
```

`args` carries `task`, the router's `target` (`instance`, `tier`, `model`, `effort`, already native),
the granted `autonomy`, `worktree`, `repoRoot`, `runDir`, `instance`, the `probe` result and the
runner's allow-listed `baseEnv`. Return an `Invocation` (validated by `InvocationSchema`).

**Isolation and autonomy**

- Build the command so the child is isolated to the degree your `caps.isolation` claims, using the
  flags the spike proved (claude `--safe-mode`; codex `--ignore-user-config --ignore-rules
  --disable hooks --disable plugins`).
- Map `autonomy` to the CLI's own boundary: `read-only` and `worktree` only. For anything else throw a
  `DispatchError` (`ExitCode.REJECTED`, a stable code such as `adapter.autonomy_unsupported`).
- **Never pass `--dangerously-*` flags or anything else that disables permission prompts**
  (`--dangerously-skip-permissions`, `--dangerously-bypass-...`) unless the CLI enforces a native OS
  sandbox that you verified fails closed. agy never gets them; claude relies on `acceptEdits` plus a
  sandbox with `failIfUnavailable: true`. Add a golden-argv test that asserts no `--dangerously-`
  argument can appear for any input.
- **Fail closed on missing capabilities**: if the flag or feature you rely on is not in `probe.flags`
  or `probe.features`, throw (claude requires `--safe-mode`; codex requires the `hooks` and `plugins`
  features).
- Validate every value that becomes an argument and could be read as a flag or break a config syntax:
  model and effort must match a plain-token pattern (`/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/`); a path
  embedded in a TOML override goes through a proper encoder (`tomlString` in the codex adapter).

**Process and environment**

- `binary` is the absolute `probe.binaryPath`; never a bare name. `cwd` is the worktree (load-bearing
  for CLIs without a cwd flag).
- `env` starts from `{ ...args.baseEnv }`. Add only what the instance needs: the config-dir variable
  of the instance (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Remove a variable another instance could have
  put there. Do not add credential or host-marker variables.
- `redactArgvIndexes` lists argv positions that hold the prompt or settings JSON, so the runner
  redacts them in logs and the state store. Empty when the prompt travels on stdin.

**Prompt channel**

- `stdin`: set `stdin` to the wrapped prompt and make the CLI read it (`-` as the prompt argument).
- `argv`: set `stdin: null` and put the prompt in argv (agy: `-p=<prompt>`, index 0 redacted).
- Always wrap the prompt in a header that marks it as task data and forbids recursion (see
  `wrapPrompt` in each adapter): *work only in the current directory; do not run `dispatch`; end with
  a short summary*. This is a convenience, not a security boundary; the boundary is the sandbox and
  `DISPATCH_DEPTH`, which the runner puts in `baseEnv`.

**Side-effect guards**

`sideEffectGuards` names each protection against a side effect of the CLI that the spike found, and a
golden-argv test asserts it. Examples: `codex-project-trust-untrusted` (without the `projects=`
override, `codex exec` writes `trust_level = "trusted"` for the main repo into `~/.codex/config.toml`),
`claude-credential-deny`, `agy-read-only`. If your spike found none, say so in the adapter's header
comment rather than leaving the list empty by accident.

**Credentials**

If the child can read the user's files (claude's `Read` tool, its shell), deny the credential
directories explicitly (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.dispatch`, `~/.ssh`, `~/.aws`,
`~/.config/gh`, `.env*`): see `childSettings` in `src/adapters/claude/invocation.ts`. If it cannot
enforce that, say so in `caps.sandbox` (`permission-only`).

## 5. `parseLine`

```ts
parseLine(stream, line, ctx): NormalizedEvent[]
```

Called for every complete stdout or stderr line. It **must never throw**: unknown lines, malformed
JSON and new event types return `[]` (the shipped adapters wrap the body in `try/catch` and have
property tests with arbitrary strings). Map what you understand to the provider-neutral kinds:

| `kind` | Use for |
| --- | --- |
| `reading` | The agent reads files (`path`: worktree-relative) |
| `editing` | The agent edits files (`path`: worktree-relative) |
| `running` | A shell command (`detail`: the command, clipped to ~200 chars) |
| `thinking` | Model text or reasoning (`detail`, clipped) |
| `denied` | The CLI refused a tool action (permission rule, sandbox, headless auto-deny) |
| `done` | The CLI reported completion |
| `error` | The CLI reported an error |

Every event has an ISO-UTC `ts`. Absolute paths become worktree-relative with `ctx.worktree` (codex
`file_change` items are absolute).

**State lives in `ctx.scratch`.** Namespace your own state under your adapter id
(`ctx.scratch.acme`, created on first use, as `runState`/`state` do in the shipped adapters). Keys the
runner conventionally provides or reads:

| Key | Direction | Meaning |
| --- | --- | --- |
| `instanceId` (string) | runner to adapter | Needed to emit quota observations (claude) |
| `clock` (`Clock`) or `now` (`() => Date`) | runner to adapter | Stamps events and resolves relative resets; fall back to the system clock |
| `outputFileContent` (string) | runner to adapter | Content of `Invocation.outputFile` after exit (codex `-o last.txt`); `finalize` stays pure |
| `endedAt` (ISO string) | runner to adapter | When the child ended; resolves "Resets in 2h39m" (agy) |
| `quotaObservations` (`QuotaObservation[]`) | adapter to runner | Passive quota readings (step 8) |
| `model` (string) | adapter to runner | The model the CLI reports it used |

Keep tails of stderr and non-JSON stdout (the shipped adapters keep the last 20 lines) so `finalize`
can explain a failure and spot a quota message that arrived as plain text.

## 6. `finalize`

```ts
finalize(result: SpawnResult & { durationMs: number }, ctx): AdapterOutcome
```

Called once after the child ended. `result` has `exitCode`, `signal`, `timedOut` (the runner's
timeout) and `durationMs`. Return an `AdapterOutcome` (validated by `AdapterOutcomeSchema`):
`outcome`, `summary`, `deniedActions`, `durationMs`, and optionally `usage`, `resetAt`, `nativeError`
and `quotaSignal`.

Classify in an order you document and test; the shipped adapters differ in details (claude and agy
check quota first, codex checks the timeout first), but all follow this decision list:

1. **`quota_exhausted`**: the CLI told you the plan's quota is gone. This is the outcome the router
   and the quota core act on (`unavailableUntil`), so a missed quota message turns into a plain
   `failed` and the same instance is tried again. Collect every channel the CLI uses: a structured
   event (claude `rate_limit_event` with `status: "rejected"`), an error type (`rate_limit`), an HTTP
   status (`429`), an error message (codex `You've hit your usage limit`, with a typographic
   apostrophe; match on the stable prefix), or an error line on stderr (agy `AGY_ERROR` with
   `exhausted your quota`). Set `resetAt` (ISO) when the CLI announces one, `nativeError` to the raw
   evidence, and `quotaSignal` to `{ source, raw }`. Be careful with false positives: a message that
   merely mentions the word "quota" inside file content is not a signal (claude only trusts the
   text of synthetic assistant messages).
2. **`timeout`**: `result.timedOut`, or the CLI's own timeout message (agy `--print-timeout`).
3. **`rejected`**: the CLI refused to start for a reason Dispatch wants to surface rather than retry
   (claude: its OS sandbox is unavailable and `failIfUnavailable` made it exit).
4. **`failed`**: a non-zero exit, a signal, an error result, **or a run that denied actions and
   produced nothing**. agy reports `status: "SUCCESS"`, exit 0, when it denied the only useful
   action; map "denied actions and an empty summary" to `failed`.
5. **`success`**.

Details that matter:

- `deniedActions` lists what the CLI refused (claude `permission_denials`, agy `denied_actions`).
- `summary` is the agent's final message. Prefer the CLI's authoritative final field over the last
  streamed text. It is untrusted output; the runner marks it `EXTERNAL_AGENT_OUTPUT` for the host.
- `usage` maps token counts when the CLI reports them (every field optional; keep the native payload
  in `raw`). Do not invent numbers.
- `quotaSignal.source` is a **closed enum** in `src/core/contracts.ts`
  (`claude.rate_limit_event.rejected`, `claude.assistant.error`, `claude.api_error_status_429`,
  `claude.text`, `codex.turn_failed.usage_limit`, `agy.agy_error.quota`). Adding a value is a contract
  change and needs a new ADR (see [ADR 0001](../adr/0001-frozen-contracts.md)). `quotaSignal` is
  optional, so an adapter can ship without it and still return `outcome: "quota_exhausted"`, as the
  skeleton below does.

## 7. The model table

Routing never hard-codes a model name. Each adapter ships `assets/models/<adapter id>.yaml`, a
mapping file with a `models.<adapter id>` block (format and field meanings: the
[mapping file reference](../configuration.md#mapping-file-mappingsnameyaml)):

```yaml
version: 1
models:
  acme:
    tiers:
      fast:     { model: acme-small, effort: { low: low, medium: medium, high: high }, relative_cost: 1 }
      balanced: { model: acme-mid,   effort: { low: low, medium: medium, high: high }, relative_cost: 3 }
      max:      { model: acme-large, effort: { low: low, medium: medium, high: high }, relative_cost: 8 }
    reverse:
      - { pattern: "*small*", tier: fast }
      - { pattern: "*mid*", tier: balanced }
      - { pattern: "*large*", tier: max }
```

- Define **all three tiers** (`fast`, `balanced`, `max`) and the three efforts. A missing tier or
  effort filters the instance out for that task (`no model for tier ...` in `explain`).
- `model` and the effort values are what your `buildInvocation` passes to the CLI. Take them from the
  CLI's own catalog (`codex debug models`, `agy models`), never from memory.
- `reverse` classifies the model name the *host* asked for. Order matters; first match wins. Include
  aliases (`sonnet`) if hosts use them.
- The file is picked up automatically: `loadEffectiveConfig` reads every `*.yaml` in
  `assets/models/`. Users override it in `~/.dispatch/mappings/` (a `models.acme` block replaces your
  whole table). `assets/` ships in the package (`files` in `package.json`).
- `relative_cost` is indicative (1 = cheapest); it feeds the estimator and `status --compare`, never
  routing.

## 8. Quota

Routing never blocks for lack of quota data, so a quota channel is optional (`quotaChannel: "none"` is
legal). When the provider offers one, there are two ways, and an adapter may use both
(`passive+reader`).

### Passive observations (claude)

If the run's own stream carries usage (claude's `rate_limit_event`), `parseLine` appends
`QuotaObservation`s to `ctx.scratch.quotaObservations`, but only when the runner put the instance id
in `ctx.scratch.instanceId`. A reading is `{ instanceId, at, window: { kind, usedPct, resetAt, source,
readAt, reliability } }`; use `reliability: "real"` for values the provider reported. Window `kind`
labels (`5h`, `7d`, `weekly`) must match the windows of the plan table in `src/quota/plans.ts`.
`ingestClaudeObservations` (in `src/quota/readers/claude-passive.ts`) validates and stores them;
`ClaudePassiveReader` serves the latest stored reading as a `QuotaReader`. Copy that pair for a new
passive channel.

### A reader (codex, agy, claude)

A reader is a separate object, not part of the adapter, implementing `QuotaReader`
(`src/quota/reader.ts`):

```ts
interface QuotaReader {
  readonly id: string;       // stable; also the QuotaWindow.source and the key in quota.readers
  readonly version: string;  // shown by doctor
  readonly channel: string;  // e.g. "app-server", "cli:/usage"
  read(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<QuotaWindow[]>;
}
```

- Every returned window has `reliability: "real"`, `source: this.id` and `readAt` = when the data was
  produced. `usedPct` is 0-100 or `null`; `resetAt` an ISO time or `null`.
- Use credentials **read-only and in place**: run the CLI's official command (`agy -p=/usage`, `codex
  app-server`) with `buildReaderEnv(base, instance, configVar)` from `src/quota/readers/env.ts`
  (allow-listed env plus the instance's config dir). Never open a credential file, never call a
  private endpoint with the user's token.
- Honour `ctx.signal` and `ctx.timeoutMs`; the core wraps every call in a timeout (5 s by default)
  and a `catch`, so a slow or broken reader never blocks routing.
- Throw the typed errors of `src/quota/readers/errors.ts`: `QuotaFormatError` when the answer no
  longer has the shape you understand, `QuotaAuthError` when the CLI is logged out.
- Register it in `defaultReaders` (`src/quota/readers/index.ts`):
  `.register("acme", new AcmeUsageReader({ spawner, clock }))`. The first argument is the adapter id.
- If the adapter has a plan-based allowance, add the plans to `DEFAULT_PLANS` in
  `src/quota/plans.ts` (keyed `adapter:plan`, window kinds equal to what your channel reports) so the
  estimator can fill the gaps. Those capacities are estimates; say so in the comment.

`Adapter.readQuota?` exists in the contract but the shipped adapters leave it unset and use readers.

## 9. Register the adapter

1. **Adapter registry**, `src/app/adapters.ts`: add the capabilities to `ADAPTER_CAPABILITIES` and a
   `case "acme"` to `createAdapter`. The registry is keyed by the adapter id; a provider instance
   uses an adapter through `providers.<instance>.adapter` in the config. (The registry is introduced
   by the composition root, WP20; read-only commands use the static capabilities, the runner calls
   `createAdapter`.)
2. **Default instance** (only when the adapter should exist without any configuration):
   `defaultSettings().providers` in `src/config/defaults.ts`. Otherwise users add
   `providers: { acme: { plan: pro } }` to `~/.dispatch/config.yaml`. An experimental adapter should
   default to `enabled: false` there, as `antigravity` does. Update the `adapter` description in
   `ProviderFileSchema` (`src/config/schema.ts`) and regenerate the config reference with
   `pnpm docs:config`.
3. **Model table**: `assets/models/acme.yaml` (step 7).
4. **Quota reader and plans** (step 8), if any.
5. **Coverage gate**: add `"src/adapters/acme/**": { lines: 90, functions: 90, branches: 90,
   statements: 90 }` to `vitest.config.ts`, like the other adapters.
6. **Billing and terms of use**: if the provider restricts third-party wrappers on some plans (the
   reason `antigravity` is experimental and needs `tos_acknowledged`), add the same gate and say so
   in the README.

## 10. Minimal skeleton

A compilable skeleton for the fictional `acme` CLI, as it would look at `src/adapters/acme/index.ts`.
It lives in [`docs/guides/examples/acme-adapter.ts`](examples/acme-adapter.ts), is type-checked by
`pnpm typecheck` and exercised by `test/unit/docs-guides.test.ts`, which also fails when this page
drifts from the file. Split it into `probe.ts`, `invocation.ts`, `parse.ts` and `finalize.ts` as it
grows, like the shipped adapters.

```ts
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  type Adapter,
  type AdapterCapabilities,
  type AdapterDeps,
  type AdapterOutcome,
  type AdapterRunContext,
  type BuildInvocationArgs,
  ExitCode,
  type Invocation,
  type NormalizedEvent,
  type ProbeResult,
  type ProviderInstance,
  type SpawnResult,
} from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { satisfiesRange } from "../agy/version.js";

// 1. Capabilities: static facts, each one verified by your spike.
export const ACME_CAPABILITIES: AdapterCapabilities = {
  id: "acme",
  version: "0.1.0",
  cliRange: ">=1.0.0 <1.1",
  streaming: true,
  autonomy: ["read-only", "worktree"],
  quotaChannel: "none",
  pool: "subscription",
  experimental: true,
  promptChannel: "stdin",
  isolation: {
    userHooks: "not_disableable",
    userPlugins: "not_disableable",
    userMcp: "not_disableable",
    projectConfig: "not_disableable",
  },
  sandbox: "permission-only",
  childNetwork: "none",
};

const NATIVE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

// 2. Probe: never throws, spends no quota, reports facts.
async function probe(instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult> {
  const binaryPath = await deps.resolveBinary("acme", instance);
  if (!binaryPath) {
    return {
      binaryPath: null,
      realpath: null,
      version: null,
      flags: [],
      features: [],
      loggedIn: null,
      outsideCliRange: false,
    };
  }
  const run = async (argv: string[]): Promise<string[]> => {
    const lines: string[] = [];
    try {
      await deps.spawner.spawn({
        binary: binaryPath,
        argv,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb" },
        cwd: tmpdir(),
        timeoutMs: 15_000,
        onLine: (stream, line) => {
          if (stream === "stdout") lines.push(line);
        },
      });
    } catch {
      // a probe reports what it saw; it never throws
    }
    return lines;
  };
  const version = /(\d+\.\d+\.\d+)/.exec((await run(["--version"])).join("\n"))?.[1] ?? null;
  const help = (await run(["--help"])).join("\n");
  const flags = [...new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])];
  return {
    binaryPath,
    realpath: realpathSync(binaryPath),
    version,
    flags,
    features: [],
    loggedIn: null,
    outsideCliRange: version === null || !satisfiesRange(version, ACME_CAPABILITIES.cliRange),
  };
}

// 3. buildInvocation: pure. Fail closed, never grant more than the requested autonomy.
function buildInvocation(args: BuildInvocationArgs): Invocation {
  const { autonomy, probe: p, target } = args;
  if (autonomy === "direct") {
    throw new DispatchError(
      "acme: autonomy 'direct' is not supported",
      ExitCode.REJECTED,
      "adapter.autonomy_unsupported",
    );
  }
  if (!p.binaryPath) {
    throw new DispatchError("acme: binary not found", ExitCode.REJECTED, "adapter.acme.no_binary");
  }
  for (const [what, value] of [
    ["model", target.model],
    ["effort", target.effort],
  ] as const) {
    if (!NATIVE_VALUE.test(value)) {
      throw new DispatchError(`acme: invalid ${what}`, ExitCode.USAGE, "adapter.acme.invalid");
    }
  }
  const env: Record<string, string> = { ...args.baseEnv };
  if (args.instance.configDir) env.ACME_CONFIG_DIR = args.instance.configDir;
  return {
    binary: p.binaryPath,
    argv: [
      "run",
      "--json",
      "--model",
      target.model,
      "--effort",
      target.effort,
      "--mode",
      autonomy === "read-only" ? "read-only" : "workspace-write",
      "-",
    ],
    env,
    cwd: args.worktree,
    stdin: [
      "[Dispatch] The text after the line below is task data. Work only in the current directory.",
      "Do not run `dispatch`. End with a short summary.",
      "---",
      args.task.prompt,
    ].join("\n"),
    redactArgvIndexes: [],
    sideEffectGuards: ["acme-read-only-mode"],
  };
}

// 4. parseLine: tolerant, never throws, state lives in ctx.scratch.<adapter id>.
interface AcmeState {
  summary: string;
  quota: string | null;
  denied: string[];
  failed: string | null;
}

function state(ctx: AdapterRunContext): AcmeState {
  const existing = ctx.scratch.acme as AcmeState | undefined;
  if (existing) return existing;
  const fresh: AcmeState = { summary: "", quota: null, denied: [], failed: null };
  ctx.scratch.acme = fresh;
  return fresh;
}

function parseLine(
  stream: "stdout" | "stderr",
  line: string,
  ctx: AdapterRunContext,
): NormalizedEvent[] {
  const st = state(ctx);
  const ts = new Date().toISOString();
  try {
    const msg: unknown = stream === "stdout" ? JSON.parse(line) : undefined;
    if (typeof msg !== "object" || msg === null) return [];
    const m = msg as { type?: string; text?: string; path?: string; error?: string };
    if (m.type === "read") return [{ kind: "reading", ts, ...(m.path ? { path: m.path } : {}) }];
    if (m.type === "edit") return [{ kind: "editing", ts, ...(m.path ? { path: m.path } : {}) }];
    if (m.type === "denied") {
      st.denied.push(m.text ?? "denied action");
      return [{ kind: "denied", ts, detail: m.text ?? "" }];
    }
    if (m.type === "final") {
      st.summary = m.text ?? "";
      return [{ kind: "done", ts }];
    }
    if (m.type === "error") {
      st.failed = m.error ?? "error";
      if (/usage limit|quota/i.test(st.failed)) st.quota = st.failed;
      return [{ kind: "error", ts, detail: st.failed }];
    }
    return [];
  } catch {
    return [];
  }
}

// 5. finalize: classify. Quota first, so a quota failure is never reported as a plain failure.
function finalize(
  result: SpawnResult & { durationMs: number },
  ctx: AdapterRunContext,
): AdapterOutcome {
  const st = state(ctx);
  const base = { summary: st.summary, deniedActions: st.denied, durationMs: result.durationMs };
  if (st.quota !== null) {
    return { ...base, outcome: "quota_exhausted", nativeError: st.quota };
  }
  if (result.timedOut) return { ...base, outcome: "timeout" };
  if (st.failed !== null || result.exitCode !== 0 || result.signal) {
    return { ...base, outcome: "failed", nativeError: st.failed ?? `exit ${result.exitCode}` };
  }
  if (st.denied.length > 0 && st.summary === "") {
    return { ...base, outcome: "failed", nativeError: "all useful actions were denied" };
  }
  return { ...base, outcome: "success" };
}

/** Creates the acme adapter. */
export function createAcmeAdapter(): Adapter {
  return { caps: ACME_CAPABILITIES, probe, buildInvocation, parseLine, finalize };
}
```

## 11. Tests, fixtures and a fake CLI

Tests never touch the real CLI, the real HOME, `~/.claude`, `~/.codex`, `~/.gemini` or `~/.agents`,
and tag their names with `[UCn]`, `[ACn]` or `[SEC-x]`.

**Recorded fixtures** are the ground truth for `parseLine` and `finalize`:

```text
test/fixtures/<cli>/<cli version>/<scenario>.stdout.jsonl   (or .json for a single JSON document)
test/fixtures/<cli>/<cli version>/<scenario>.stderr.txt
test/fixtures/<cli>/<cli version>/<scenario>.meta.json
```

`meta.json` records `cli`, `cliVersion`, `scenario`, `date`, the `argv` used, `exitCode`, `synthetic`,
`files`, and `notes`; a synthetic fixture (one you could not provoke live, such as quota exhaustion)
sets `synthetic: true` and lists its `source` (the code or documentation it was derived from). There is
no recording script on `main` yet (`scripts/record-fixtures` is planned), so record by hand and
sanitize: replace the worktree with `<WT>` and the temp dir with `<TMP>` (the fake CLI substitutes
both when it replays a fixture), the home with `<HOME>`, and remove tokens, emails, account names and
session ids. Check the diff for secrets before committing. Fixtures are excluded from biome so they
stay byte-identical. Keep one directory per CLI version; when the CLI updates, add the new version
next to the old one.

**Tests to write** (`test/unit/adapters/acme.test.ts`; copy the structure of `agy.test.ts` or
`codex.test.ts`, and reuse `test/unit/adapters/helpers.ts`: `replay`, `fixtureLines`, `runCtx`):

| Test | Asserts |
| --- | --- |
| Capabilities | `AdapterCapabilitiesSchema.parse(caps)`; the claims you made |
| Golden argv | The exact argv for each autonomy level, the env, `cwd`, `stdin`, `redactArgvIndexes`, `sideEffectGuards`; `direct` and a missing binary throw; **no `--dangerously-` argument for any input** (fast-check) |
| Native values | Model/effort that look like flags are rejected |
| Fixtures | `parseLine` over each recorded fixture gives events that pass `NormalizedEventSchema`; `finalize` gives the expected outcome (success, denied then `failed`, **quota then `quota_exhausted` with the right `resetAt`**, timeout) |
| Tolerance | `parseLine` never throws on junk, on arbitrary strings and on arbitrary JSON values |
| Probe | With `ScriptedSpawner` (`test/stubs`): version, flags, login; not installed; spawner that throws; a version outside `cliRange` sets `outsideCliRange` |
| Reader | If you wrote one: the format-changed, unauthenticated and hang variants (see `test/unit/quota-readers.test.ts`) |

**A fake CLI scenario.** `test/fakes/` holds a fake `claude`, `codex` and `agy` that replay fixtures
(`replay`, `success_edit`, `slow`, `quota_exhausted`, `malformed`, `crash`, `hang_ignore_term`, ...;
the typed scenarios are in `test/support/fakes.ts`). The harness knows exactly three CLIs, so a fourth
touches test code in four places:

1. `FAKE_CLIS` in `test/support/guard.ts` (the guard then also proves your CLI cannot resolve to a real
   binary, and `FakeCli` and the scenario types follow).
2. A shim `test/fakes/bin/acme`, a copy of `test/fakes/bin/codex` with the name changed
   (executable bit set).
3. The version tables at the top of `test/fakes/fake-cli.mjs` (`VERSION_TEXT`, `FIXTURE_VERSION`,
   `DEFAULT_SUCCESS_FIXTURE`) and, if your CLI has subcommands or needs a synthetic stream, its
   `classify()` and `textStream()` branches.
4. Subcommand configs (`acme:version`, ...) in `FakeSubKey`/`FakeScenarioMap` in `test/support/fakes.ts`
   if probes need them.

Then `withFakes({ acme: [{ scenario: "quota_exhausted" }] }, ...)` gives you a PATH with a fake
`acme` first, and `readLog()` returns the argv, env and cwd it was started with. Use it for one
end-to-end test that feeds a fake run through `parseLine` and `finalize`.

## 12. `cliRange` and `doctor`

- `cliRange` is the range of CLI versions **you have fixtures for**. Keep it narrow (a minor line)
  and widen it only after re-recording. A CLI outside the range still runs; `probe` reports
  `outsideCliRange` and `doctor` warns, because a changed output format makes parsing wrong rather
  than loud.
- `doctor` reads what you declared and probed: the resolved binary and its real path, the version
  against `cliRange`, whether the version has fixtures, the login state, the flags/features your
  invocation needs, and `caps.isolation`, which it prints so the user knows what the child can still
  load (agy's user hooks, plugins and `.agents/` project config cannot be disabled).
- `doctor` spends no quota by default; `doctor --live` runs one tiny task per provider.

## Checklist

- [ ] Spike notes in `docs/spikes/<cli>.md`, fixtures per version in `test/fixtures/<cli>/<version>/`.
- [ ] `caps` true and minimal; `autonomy` lists only what is enforced.
- [ ] `probe` never throws, spends no quota, reports `outsideCliRange`.
- [ ] `buildInvocation` is pure, throws for unsupported autonomy and missing capabilities, passes no
      `--dangerously-*` flag, redacts the prompt in argv, names its side-effect guards.
- [ ] `parseLine` never throws; relative paths; `denied` events.
- [ ] `finalize` classifies quota exhaustion (with `resetAt`), timeout, denied-only runs; golden
      fixtures for each.
- [ ] `assets/models/<id>.yaml` with all tiers; adapter registered in `src/app/adapters.ts`.
- [ ] Quota reader registered and plans added, or `quotaChannel: "none"` with a comment.
- [ ] Coverage gate for `src/adapters/<id>/**`; `pnpm build && pnpm lint && pnpm typecheck &&
      pnpm test:coverage && pnpm check:boundaries` green.
