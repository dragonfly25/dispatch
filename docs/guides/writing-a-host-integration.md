# Writing a host integration

A **host** is the agent client the user works in (Claude Code, Codex). A host integration is the small
module that makes a host aware of Dispatch: it plans the user-level files that tell the host how to
delegate, answers the host's hooks, and contributes health checks to `dispatch doctor`. It is the only
host-specific code in Dispatch; routing, quota and execution know nothing about hosts.

The two shipped integrations are the worked examples (the plan puts them in `src/hosts/claude-code/`
and `src/hosts/codex/`; their templates are already in `assets/hosts/`):

| Host id | Mode | What `setup` installs | Hook events |
| --- | --- | --- | --- |
| `claude-code` | soft (`subagentStrategy: "none"`) | A user-scope plugin from a local marketplace (agent `dispatch:dispatch` + a hook), via `claude plugin ...` | `SessionStart` |
| `codex` | hard (`subagentStrategy: "deny_redirect"`) | A skill, entries in `~/.codex/hooks.json`, and `~/.codex/rules/dispatch.rules` (a trust grant) | `SessionStart`, `PreToolUse` |

Read first: [`docs/PLAN.md`](../PLAN.md) ("Host integration" and the amendments),
[ADR 0002](../adr/0002-wp1-contract-freeze.md), [`docs/spikes/hosts.md`](../spikes/hosts.md) and the
real-CLI prototype [`docs/spikes/hosts-prototype.md`](../spikes/hosts-prototype.md).

## 1. Ground rules

These follow from the product promise (nothing leaks to collaborators, everything is reversible) and
are enforced by tests and by `scripts/check-boundaries.mjs`.

1. **User or local scope only.** A host integration writes under the user's home. It never writes into a
   repository and never installs a hook script in `.dispatch/` (scripts in a repo are an execution
   vector). A collaborator who clones a repo must see no trace of Dispatch (AC5).
2. **Never touch the user's instruction files or settings.** No `CLAUDE.md`, no `AGENTS.md`, no
   existing skill, no project `.claude/settings.json`. Add **new files in Dispatch's own folders**
   (`~/.agents/skills/dispatch/`, `~/.dispatch/hosts/<host>/`) or a single, marked, removable entry.
   Do not write the host's own trust state either (Codex stores hook trust in `~/.codex/config.toml`;
   the user approves hooks in `/hooks`, Dispatch only tells them to).
3. **Only `src/hosts/_framework/` writes host files.** Your module returns `EditOp`s; the framework
   previews, applies, records and reverts them. The boundary check fails any other file that both
   calls an fs write API and names a `.claude`, `.codex`, `.agents` or `.gemini` path.
4. **Every edit is idempotent and reversible.** `setup` twice changes nothing; `uninstall --global`
   restores the host files byte for byte (AC2, UC14).
5. **Hooks are silent on any problem** (UC9, section 6).
6. **No PATH reliance.** A GUI-launched host may start hooks with `PATH=/usr/bin:/bin`. Hook commands
   and the launcher use absolute paths.
7. **A trust grant is shown verbatim.** An op that gives the host extra authority sets `trustGrant`;
   the `setup` preview prints it before anything is written and the user confirms.

## 2. Spike first

As for adapters, record the real host's behaviour before coding (the WP1 and WP8 spikes are the
model). Answer with evidence:

| Question | Decides |
| --- | --- |
| Where does the host read user-level extensions from (plugin, skill, hooks file, rules)? Is there a CLI for it (`claude plugin install -s user`)? | The `EditOp` kinds |
| What does the host's uninstall leave behind? (Claude's `plugin uninstall` leaves empty `enabledPlugins` and `extraKnownMarketplaces` keys, an `installed_plugins.json`, an orphaned cache dir.) | `cli-command` `snapshot` cleanup |
| Which hook events exist, what is on their stdin (is `model` present?), what output do they accept? | `hookHandlers` |
| Can a hook block or redirect the host's native sub-agent? What is the tool name the hook sees? | `subagentStrategy`, `subagentMatcher` |
| What are the shell tool's timeout and yield behaviour? | `waitTimeoutSec` |
| Which environment variables identify a running session? | `detectSelf` |
| Is the host sandboxed so `dispatch run` cannot reach the network or write `~/.dispatch`? | Whether a rules file or a permission is needed (a trust grant) |
| How does the host launch hooks (PATH, cwd, env, timeout)? | The hook command |

## 3. The contract

```ts
interface HostIntegration {
  readonly id: "claude-code" | "codex";
  readonly subagentStrategy: "none" | "deny_redirect";
  readonly subagentMatcher: string | null;
  readonly waitTimeoutSec: number;
  detectSelf(env: Readonly<Record<string, string | undefined>>): DetectedHost | null;
  detect(ctx: HostPlanContext): Promise<boolean>;
  plan(ctx: HostPlanContext): EditOp[];
  hookHandlers: Record<string, (input: HookInput) => Promise<HookResponse>>;
}
```

| Member | Rules |
| --- | --- |
| `id` | A closed union in `src/core/contracts.ts` (frozen by [ADR 0002](../adr/0002-wp1-contract-freeze.md)). A third host first needs a new ADR that extends the union (and `DetectedHost` in `src/platform/host.ts`, which already recognises Antigravity without integrating it). |
| `subagentStrategy` | `none`: soft mode, the host decides when to call the Dispatch agent or skill. `deny_redirect`: a `PreToolUse` hook denies the host's native sub-agent spawn and the denial reason tells the model to run `<launcher> run --detach --json --task '<task>'` and then `wait`. There is deliberately no "proxy the sub-agent" variant: on Codex multi-agent V2 the spawn message is encrypted, so a hook cannot read or rewrite it. |
| `subagentMatcher` | The `PreToolUse` matcher when the strategy is not `none` (Codex: `spawn_agent\|collaborationspawn_agent\|Agent`, because on V2 the hook sees `collaborationspawn_agent`); otherwise `null`. |
| `waitTimeoutSec` | Default `wait --timeout` for calls from this host, in seconds. Must be shorter than the host's shell tool timeout so the call returns (exit 75, "still running") instead of being killed. Claude: 100 (Bash default 120 s). Codex: 280 (unified exec yields after at most 30 s, then polls up to 300 s). It becomes `{{WAIT_TIMEOUT}}` in your templates. `wait` is read-only and safe to run concurrently, because some models start duplicates. |
| `detectSelf(env)` | Identify the *calling* host from the environment only (`CLAUDECODE=1`, `CODEX_THREAD_ID`), never from the binary on PATH: the desktop app bundles its own CLI version. Return `{ host, version }` or `null`. The result decides which instance is "self" and is never chosen as a delegation target. |
| `detect(ctx)` | Is the host installed for this user? Use `hostPresent({ home, binary, dir, env })`: the binary resolves, or its config dir exists. An absent host contributes no ops, so `setup` never creates a directory for it. |
| `plan(ctx)` | **Pure**: return the `EditOp`s, write nothing. Order matters; ops are applied in order and reverted in reverse. |
| `hookHandlers` | Keyed by hook event name. Light, see section 6. |

`HostPlanContext` is `{ home, launcherPath, nodePath, hookPath }`, all absolute. `launcherPath` is
`<dispatch home>/bin/dispatch`; embed it (never `~`) in every text the host will show a model.
`nodePath` and `hookPath` are for hook commands.

## 4. The five `EditOp` kinds

```ts
interface EditOp {
  file: string;          // absolute path (for cli-command: the binary)
  kind: "json-entry" | "text-block" | "new-file" | "rules-file" | "cli-command";
  signature: string;     // identifies Dispatch's entry so it can be found and removed
  content: string;       // kind-specific, below
  mode?: string;         // "0644" for new-file / rules-file ("0755" for the launcher)
  sha256?: string;       // new-file / rules-file: hash of content, checked before apply
  trustGrant: string | null;
}
```

The identity of an op is `(kind, file, signature)`. The manifest `~/.dispatch/setup-manifest.json` records
every applied op with what is needed to undo it (a pre-image, a byte-exact textual inverse, the created
directories, a hash), so `uninstall --global` removes **exactly** Dispatch's edits and nothing else. The
code is in `src/hosts/_framework/edits.ts` and `json-entry.ts`.

| Kind | `content` | Apply | Uninstall guarantee |
| --- | --- | --- | --- |
| `json-entry` | JSON `{ "path": [...], "mode": "append" \| "set", "value": ... }` | Edits a JSON or JSONC file with `jsonc-parser`: comments, indentation and every byte outside the entry survive. `append` adds `value` to the array at `path` (creating missing containers); `signature` must be a string that occurs inside `value` (the hook command), it is how the element is found. `set` sets `path` to `value`. Identical entry already present: unchanged. In `append` mode a *different* entry with the same signature is an error (`setup.entry_conflict`). A file that is not valid JSON/JSONC: error, never rewritten. | The entry is removed. When nobody edited the region, the file is restored **byte for byte** (a recorded textual inverse); otherwise a structural removal is used. Containers setup created are pruned; a file setup created and that is now empty is deleted with the directories setup created. An entry the user edited since is **kept** with a warning. `set` restores the previous value. |
| `text-block` | The block body | Appends a block fenced by `# dispatch:begin <signature>` and `# dispatch:end <signature>` (so only for formats where `#` starts a comment: TOML, YAML, shell, rules). Creates the file if needed. | Removes the exact block; the file returns to its prior bytes. A block edited since is kept with a warning. A file setup created that is now empty is deleted. |
| `new-file` | The whole file text | Writes the file atomically with `mode`. Refuses to overwrite a file that exists and was not created by Dispatch, or that was edited since setup. `sha256` must match the content. | Deleted only when its bytes still match the recorded hash (else kept with a warning); directories setup created are removed when empty. |
| `rules-file` | The whole file text | Same mechanics as `new-file`; the kind marks a file that **grants the host authority** (Codex `dispatch.rules` lets the launcher's `run`, `wait`, `cancel` and `status` run outside the Codex sandbox). Always set `trustGrant`. | As `new-file`. |
| `cli-command` | JSON `{ "argv": [...], "undo": [...], "snapshot": {...} }` (a bare argv array means no undo) | Runs `file` (the binary) with `argv` through the `CommandRunner` port; the real one lives in `src/runner`. Skipped when the manifest already has the same content. A non-zero exit: error `setup.command_failed`. Before running, the framework records the state named in `snapshot`. | Runs `undo`, then removes what the host CLI left behind **if it was absent before setup**: `snapshot.jsonKeys` (top-level keys of a JSON file, removed when they are left as empty objects) and `snapshot.leftovers` (directories, optionally `recursive`; files only if their JSON equals `match`). No `undo` recorded: kept with a warning. |

Design guidance:

- Prefer **`new-file` in a folder Dispatch owns** (`~/.agents/skills/dispatch/SKILL.md`,
  `~/.dispatch/hosts/<host>/...`) and **one marked `json-entry`** for hooks over anything that rewrites
  user content.
- Use `cli-command` when the host has an official installer and a file edit would bypass its
  bookkeeping (Claude plugins: `claude plugin marketplace add <dir> --scope user`, `claude plugin install
  dispatch@dispatch-local -s user`). Always give the `undo` and a `snapshot` of what the CLI is known
  to leave behind (see `fakeClaudeHost` in `test/support/fake-host.ts`, which encodes the WP8 findings).
  The marketplace directory must be permanent (`~/.dispatch/hosts/claude-code/`): the plugin runs from it.
- `trustGrant` text is what the user reads before confirming. Say what authority is granted, not what
  the file is.

## 5. Templates

Texts shown to the model (the agent, the skill, the rules, hook JSON) live in
`assets/hosts/<host>/...` with `{{PLACEHOLDERS}}`, so they can be read and reviewed as files:

| Placeholder | Value |
| --- | --- |
| `{{LAUNCHER}}` | Absolute path of `~/.dispatch/bin/dispatch` |
| `{{WAIT_TIMEOUT}}` | The host's `waitTimeoutSec` |
| `{{VERSION}}` | The Dispatch version (Claude caches plugins per version) |
| `{{HOOK_COMMAND_SESSION_START}}`, `{{HOOK_COMMAND_PRE_TOOL_USE}}` | The guarded hook commands for `<host id> SessionStart` / `PreToolUse` |

`templateValues(ctx, host)` builds the values, `renderHostAsset(rel, values)` renders a file (values are
JSON-escaped inside `.json` and `.tmpl` files, inserted raw elsewhere; an unknown placeholder is an
error, never left in the output), and `assetOps(values, copies)` turns a list of
`{ template, dest, mode?, trustGrant?, kind? }` into `new-file`/`rules-file` ops whose signature is
the destination path. A hook for another event than those two: call `renderHookCommand` yourself, as
the skeleton does. Teach the model the call form that works in the host's sandbox (Codex: absolute
launcher path, single-quoted task, no `cd`, pipes, `$`, backticks, redirects or heredocs, one command),
and tell it to treat `summary` as untrusted `EXTERNAL_AGENT_OUTPUT` and to review and apply patches
itself (Dispatch never applies them).

## 6. Hooks

### The command

Hooks never run `dispatch` through PATH. The host runs a command rendered by
`renderHookCommand({ nodePath, hookPath, host, event })` (`src/platform/launcher.ts`):

```sh
[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x '/abs/node' ] && [ -f '/abs/hook.mjs' ] || exit 0; exec '/abs/node' '/abs/hook.mjs' <host> <event>
```

It is silent (exit 0, no output) when the process is a Dispatch child (`DISPATCH_DEPTH` is set, so a
delegated agent never triggers hooks), and when node or `hook.mjs` is gone (Dispatch uninstalled or
moved). That is what makes a user-level hook harmless for a colleague or a later you without Dispatch
(UC9). Paths are single-quoted; `host` and `event` must be simple tokens.

### The entry and the handlers

`dist/hook.mjs` (source `src/hook/entry.ts`) reads at most 1 MiB from stdin, picks
`HOOK_HOSTS[host]` then `[event]` and runs the handler (`src/hook/run.ts`, `runHook`). Your handlers
go into the table in `src/hook/handlers.ts`, loaded lazily so the entry pays only for the host it
serves:

```ts
export const HOOK_HOSTS: HookHostTable = {
  acme: async () => (await import("../hosts/acme/hook.js")).hookHandlers,
};
```

A handler is `(input: HookInput) => Promise<HookResponse>` where `HookInput` has `hook_event_name`,
`session_id`, `cwd` and optionally `model` (present in Codex `SessionStart` and `PreToolUse`, **absent
in Claude `-p` `SessionStart`**; do not rely on it) and `HookResponse` is `{ stdout?, exitCode }`.

**The latency budget is 80 ms (p95)** for the whole process, node start included. To stay inside it
the hook module imports **only node built-ins, types and `src/hook/cache.ts`**: no zod, no SQLite, no
config loader, nothing from `src/hosts/_framework`. Keep integration code (the `HostIntegration`
object, `plan`) in a different module from the handlers, as the skeleton does; `test/unit/hook/hook.test.ts`
asserts that the built `dist/hook.mjs` bundles neither zod nor SQLite and measures p95 over 20 runs.

Handlers read the **hook cache**, `~/.dispatch/hook-cache.json` (`readHookCache`, `trustedRepoFor`,
`hookDispatchHome`): the active profile, whether hard mode is on, a one-paragraph policy summary and
the list of trusted repos. The CLI writes it atomically when trust or the active policy changes. A
hook never opens the state database and never spawns `dispatch`.

What a handler returns follows the host's hook protocol. Recorded examples:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Dispatch policy: ..."}}
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Dispatch: native sub-agents are disabled in this session. ... run <LAUNCHER> run --detach --json --task '<task>' ... then <LAUNCHER> wait <runId> --json --timeout 280 ..."}}
```

(`test/fixtures/hosts/claude_session_start_hook_response.json`,
`codex_pre_tool_use_deny_redirect_output.json`). A `deny_redirect` handler stays dumb: it never needs
the task text, never starts anything, and puts the redirect instructions in the reason. The reason
must carry what the prototype showed the model needs: the absolute launcher, the single-quoted call
form, the `wait` command with the host's timeout, "repeat `wait` while it exits 75", and, for hosts
whose shell tool yields before a long command ends, "poll the same session; do not start another
`wait`".

### Silent-failure rules (UC9)

A hook must never break the host. `runHook` and the entry already guarantee the outer layer: unknown
host or event, malformed or oversized stdin, an exception, a rejected promise or an invalid exit code
all end as **no output and exit 0**, and a 4 s timer exits quietly well before the host's own timeout.
Your handler adds:

- No `console.log`, no stderr, no stack traces. Output is either the protocol JSON or nothing.
- No cache, wrong cache version, unknown repo, anything unexpected: return `{ exitCode: 0 }` with no `stdout`.
- Never block on I/O that can hang (network, locks, the database). Never `await` more than a small file read.
- Never depend on `PATH`, the cwd being a repo, or `HOME` being set (`hookDispatchHome` returns `null`).
- Only `PreToolUse`-style handlers may produce a *decision* (deny); every other event only adds context.

Test them as the host would run them: `env -i PATH=/usr/bin:/bin node dist/hook.mjs <host> <event>` with
an empty HOME must print nothing and exit 0.

## 7. Doctor checks

`dispatch doctor` runs every check in the registry. A check is `{ id, run(ctx) }` returning
`{ status: "ok" | "warn" | "fail", message, fix? }`, where `ctx` is `{ home, dispatchHome, env }` and
`fix` is a command or instruction the user can follow. A check:

- is **read-only** (no quota, no writes to host files, no network);
- has a stable id (`<host>.<what>`, e.g. `codex.hooks-trusted`);
- gives a `fix` for every `warn` and `fail`;
- may throw: the registry turns a crash into a `fail` result instead of aborting the others.

The framework registers `setup.manifest`; yours go next to `registerHost` in `src/hosts/index.ts`.
Typical checks: the integration files exist and match the manifest; the host's version is in a range
you tested; the hook is trusted (Codex needs the user to approve it in `/hooks`; a `SessionStart`
heartbeat is how `doctor` can tell); the permission rule the host needs is present.

## 8. Registering the host

1. **`src/hosts/index.ts`**, inside `builtinRegistry()`: `registry.registerHost(yourHost)` and
   `registry.registerDoctorCheck(yourCheck)` (or the exported `registerHost` / `registerDoctorCheck`).
   A second registration with the same id replaces the first; doctor check ids must be unique.
2. **`src/hook/handlers.ts`**: add the lazy loader to `HOOK_HOSTS` (section 6).
3. **`assets/hosts/<host>/`**: templates. They ship in the package (`files` in `package.json`).
4. **`src/core/contracts.ts`**: the `id` union and, for self-detection, `src/platform/host.ts`
   (new ADR; not part of an ordinary host change).
5. **`vitest.config.ts`**: a coverage gate for `src/hosts/<id>/**`, like `src/hosts/_framework/**`.

`dispatch setup` then plans (`planSetup`: the launcher op, then the ops of every detected host),
shows the preview with every file and trust grant, applies after confirmation (`applySetup`, manifest
saved after every op so a failure part-way leaves an accurate record) and `setup --refresh`
re-renders and removes edits that are no longer planned. `uninstall --global` (`uninstallGlobal`)
reverts the manifest in reverse order; an entry that fails stays in the manifest and the Dispatch
home is kept so a later run can retry.

## 9. Skeleton

A compilable skeleton for a fictional host `acme`, split the way a real host must be: the
integration (loaded by the CLI) and the hook handlers (loaded by the 80 ms entry). They live in
[`docs/guides/examples/acme-host/`](examples/acme-host/), are type-checked by `pnpm typecheck` and
executed by `test/unit/docs-guides.test.ts` (a setup/uninstall round trip, a hook run and a doctor
check), which also fails when this page drifts from the files.

`src/hosts/acme/index.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../core/contracts.js";
import {
  type DoctorCheck,
  hostPresent,
  registerDoctorCheck,
  registerHost,
} from "../_framework/index.js";
import { renderHookCommand } from "../../platform/launcher.js";
import { hookHandlers } from "./hook.js";

// `HostIntegration["id"]` is the closed union "claude-code" | "codex" (frozen contract, ADR 0002).
// A real third host first amends that union through a new ADR; the cast only keeps this example
// type-checking.
const ID = "acme" as unknown as HostIntegration["id"];
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** User-scope files only: everything lives under the user's home, never in a repository. */
function paths(ctx: HostPlanContext) {
  return {
    hooks: join(ctx.home, ".acme", "hooks.json"),
    skill: join(ctx.home, ".acme", "skills", "dispatch", "SKILL.md"),
  };
}

function hookCommand(ctx: HostPlanContext, event: string): string {
  return renderHookCommand({
    nodePath: ctx.nodePath,
    hookPath: ctx.hookPath,
    host: ID,
    event,
  });
}

export const acmeHost: HostIntegration = {
  id: ID,
  subagentStrategy: "none", // soft mode: the host cannot be made to redirect its own sub-agents
  subagentMatcher: null,
  waitTimeoutSec: 100, // must stay below the host's shell-tool timeout
  detectSelf(env) {
    // Environment only, never the PATH binary (a desktop app bundles its own CLI version).
    return env.ACME_SESSION_ID ? { host: "acme", version: env.ACME_VERSION ?? null } : null;
  },
  async detect(ctx) {
    return hostPresent({ home: ctx.home, binary: "acme", dir: ".acme", env: process.env });
  },
  /** Pure: returns the edits, writes nothing. `setup` previews, applies and records them. */
  plan(ctx): EditOp[] {
    const p = paths(ctx);
    const command = hookCommand(ctx, "SessionStart");
    const skill = `# Dispatch\n\nTo delegate a task run \`${ctx.launcherPath} run --detach --json --task '<task>'\`.\n`;
    return [
      {
        file: p.hooks,
        kind: "json-entry",
        signature: command, // a string inside the appended element identifies it for removal
        content: JSON.stringify({
          path: ["hooks", "SessionStart"],
          mode: "append",
          value: { hooks: [{ type: "command", command, timeout: 5 }] },
        }),
        trustGrant: null,
      },
      {
        file: p.skill, // a new file in Dispatch's own folder; no existing skill is touched
        kind: "new-file",
        signature: p.skill,
        content: skill,
        mode: "0644",
        sha256: sha256(skill),
        trustGrant: null,
      },
    ];
  },
  hookHandlers,
};

/** Doctor checks are read-only: no quota, no writes to host files. */
export const acmeHooksCheck: DoctorCheck = {
  id: "acme.hooks-installed",
  run(ctx) {
    try {
      const text = readFileSync(join(ctx.home, ".acme", "hooks.json"), "utf8");
      return text.includes("SessionStart")
        ? { status: "ok", message: "acme SessionStart hook present" }
        : { status: "warn", message: "no SessionStart hook", fix: "dispatch setup --refresh" };
    } catch {
      return { status: "warn", message: "acme hooks.json not found", fix: "dispatch setup" };
    }
  },
};

// Registration: one line each in src/hosts/index.ts (`builtinRegistry`).
export function registerAcme(): void {
  registerHost(acmeHost);
  registerDoctorCheck(acmeHooksCheck);
}
```

`src/hosts/acme/hook.ts`:

```ts
// Hook handlers run inside the <= 80 ms hook entry (dist/hook.mjs). Import only node built-ins,
// types, and src/hook/cache.ts: no zod, no SQLite, no config loader, nothing from src/hosts/_framework.
import type { HookInput, HookResponse } from "../../core/contracts.js";
import { hookDispatchHome, readHookCache, trustedRepoFor } from "../../hook/cache.js";
import type { HookHandlers } from "../../hook/run.js";

const SILENT: HookResponse = { exitCode: 0 };

export const hookHandlers: HookHandlers = {
  /** Injects the active policy as context. Any problem means "say nothing" (UC9). */
  async SessionStart(input: HookInput): Promise<HookResponse> {
    const dispatchHome = hookDispatchHome(process.env);
    if (!dispatchHome) return SILENT;
    const cache = readHookCache(dispatchHome); // null when missing, unreadable or not version 1
    if (!cache) return SILENT;
    const repoNote = trustedRepoFor(cache, input.cwd) ? " (repo policy active)" : "";
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `${cache.policy.summary}${repoNote}`,
        },
      }),
      exitCode: 0,
    };
  },
};
```

## 10. Testing

Tests never touch the real HOME, `~/.dispatch`, `~/.claude`, `~/.codex` or `~/.agents`, and never run a
real host CLI. Tag test names with `[UCn]`, `[ACn]`, `[SEC-x]`.

| What | How |
| --- | --- |
| `plan` | `tempHome()` (`test/support/temp.ts`) gives a throwaway HOME and env. Call `planSetup({ home, dispatchHome, install, hosts })` and assert the ops with `EditOpSchema.parse`, the preview text and the trust grants. An absent host: only the launcher op, and the home is unchanged. |
| Round trip (UC14, AC2) | Pre-seed the host files (use JSONC with comments and user entries), `snapshotTree(home)` (`test/support/snapshot.ts`), `applySetup(plan, { dispatchHome, confirm: true, runner })`, `uninstallGlobal({ dispatchHome })`, then `expect(snapshotTree(home)).toEqual(before)`. Also re-run `applySetup` and assert nothing changed (idempotent). |
| `cli-command` hosts | A fake runner that edits the temp HOME the way the real CLI does, including its leftovers: `fakeClaudeRunner(home)` in `test/support/fake-host.ts`. Assert the recorded `calls`. |
| Fake hosts | `test/support/fake-host.ts` has `fakeCodexHost` and `fakeClaudeHost`, which mirror what the real integrations plan, using the real templates. Copy the shape for yours. |
| Edits made by the user | Edit the Dispatch entry between setup and uninstall and assert it is **kept with a warning**; add user entries next to it and assert they survive. |
| Hooks | Unit: `runHook(["acme", "SessionStart"], stdin, table)` for the response, and for each failure mode (bad JSON, unknown event, handler throws) expect `{ exitCode: 0 }` with no stdout. Cache: `writeHookCache` into a temp dir and set `DISPATCH_HOME`. Built: run `dist/hook.mjs` with `env: { PATH: "/usr/bin:/bin" }` and assert silence and p95 < 80 ms. |
| Templates | Render every template with a quote-bearing hook command and assert the JSON parses (`test/unit/host-assets.test.ts`). |
| Doctor checks | Call `check.run({ home, dispatchHome, env })` on a temp HOME before and after setup. |
| Boundaries | `pnpm check:boundaries` proves that nothing outside `src/hosts/_framework/` writes host paths. |

The real host is only exercised by hand, following the WP8 method: back up the host's config with a
sha256, run, restore, verify the hash, and record sanitized fixtures in `test/fixtures/hosts/`.

## Checklist

- [ ] Spike notes in `docs/spikes/`; fixtures of hook stdin/stdout in `test/fixtures/hosts/`.
- [ ] User/local scope only; no `CLAUDE.md`, `AGENTS.md`, existing skill or project settings touched.
- [ ] `plan` is pure; absent host gives no ops; ops are idempotent; `trustGrant` set where authority is granted.
- [ ] `setup` then `uninstall --global` leaves the host files byte-identical, JSONC comments included.
- [ ] Hook command from `renderHookCommand`; handlers in their own light module; p95 < 80 ms; every failure is silent exit 0.
- [ ] `waitTimeoutSec` below the host's shell timeout; `detectSelf` from the environment only.
- [ ] Doctor checks are read-only and give a `fix`.
- [ ] Registered in `src/hosts/index.ts` and `src/hook/handlers.ts`; coverage gate added;
      `pnpm build && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:boundaries` green.
