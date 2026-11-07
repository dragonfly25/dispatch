#!/usr/bin/env node
// Fake coding-agent CLI used by every Dispatch test that would otherwise need a real
// `claude`, `codex` or `agy` (plan section 3, "Fake CLIs"). Plain Node ESM, no dependencies.
//
//   node fake-cli.mjs <claude|codex|agy> [args...]
//
// Environment (normally exported by the per-run `.fake-env` next to the shim symlinks that
// test/support/fakes.ts creates, so the child env stays clean):
//   FAKE_SCENARIO      path to a JSON file { "<cli>": [scenario, ...], "<cli>:<sub>": cfg | [cfg, ...] }
//   FAKE_STATE_DIR     per-run directory: call counters live here; escape_writes writes abs.txt here
//   FAKE_LOG           JSONL file; every invocation appends records (merged per invocationId by readLog)
//   FAKE_FIXTURES_DIR  optional override of test/fixtures
// Run scenarios (key "<cli>") are picked by call index; subcommand configs (key "<cli>:<sub>")
// have their own counters. The last entry repeats. See test/support/fakes.ts for the typed shape.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [cli, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const invocationId = randomUUID();
const LOG = process.env.FAKE_LOG;
const STATE = process.env.FAKE_STATE_DIR;

const VERSION_TEXT = { claude: "2.1.301 (Claude Code)", codex: "codex-cli 0.167.0", agy: "1.5.2" };
const FIXTURE_VERSION = { claude: "2.1.301", codex: "0.167.0", agy: "1.5.2" };
const DEFAULT_SUCCESS_FIXTURE = {
  claude: "claude/2.1.301/child_isolation_canary",
  codex: "codex/0.167.0/edit_workspace_write",
};
const SECRETS = {
  anthropic: "sk-ant-api03-FAKE0123456789abcdefghijklmnopqrstuvwxyz",
  github: "ghp_FAKE0123456789abcdefghijklmnopqrstuv",
  bearer: "Authorization: Bearer FAKEtoken0123456789abcdefghijklmnop",
};
const SESSION = "00000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------- logging

function currentPgid() {
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    // not Linux
  }
  try {
    const r = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
    const n = Number.parseInt(r.stdout, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function writeLog(phase, extra) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ invocationId, phase, ...extra })}\n`);
  } catch {
    // logging must never break the fake
  }
}

const truncate = (s, n = 4096) => (s.length > n ? s.slice(0, n) : s);

// ---------------------------------------------------------------- scenario lookup

function loadScenarioFile() {
  if (!process.env.FAKE_SCENARIO) return {};
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, "utf8"));
  } catch (err) {
    console.error(`fake-cli: cannot read FAKE_SCENARIO: ${err.message}`);
    return {};
  }
}

/** Atomically claims the next call index for `key` by creating calls/<key>.<n> exclusively. */
function nextCallIndex(key) {
  if (!STATE) return 0;
  const dir = path.join(STATE, "calls");
  fs.mkdirSync(dir, { recursive: true });
  const name = key.replace(/[^A-Za-z0-9_-]/g, "_");
  for (let n = 0; ; n++) {
    try {
      fs.closeSync(fs.openSync(path.join(dir, `${name}.${n}`), "wx"));
      return n;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

function pick(entry, index) {
  if (!Array.isArray(entry)) return entry;
  return entry.length === 0 ? undefined : entry[Math.min(index, entry.length - 1)];
}

function classify() {
  const a = args;
  const sub = (key) => ({ kind: "subcommand", key });
  if (["--version", "-v", "-V"].includes(a[0])) return sub("version");
  if (cli === "claude" && (a[0] === "plugin" || a[0] === "plugins")) return sub("plugin");
  if (cli === "codex") {
    if (a[0] === "login" && a[1] === "status") return sub("login");
    if (a[0] === "features" && a[1] === "list") return sub("features");
    if (a[0] === "debug" && a[1] === "models") return sub("models");
    if (a[0] === "app-server") return sub("app-server");
  }
  if (cli === "agy") {
    if (a[0] === "models") return sub("models");
    const isFlag = (x) => x === "-p" || x === "--print";
    const usage = a.some(
      (x, i) => x === "-p=/usage" || x === "--print=/usage" || (isFlag(x) && a[i + 1] === "/usage"),
    );
    if (usage) return sub("usage");
  }
  return { kind: "run", key: null };
}

// ---------------------------------------------------------------- output helpers

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const write = (stream, s) => new Promise((resolve) => stream.write(s, () => resolve()));
const asLine = (l) => (typeof l === "string" ? l : JSON.stringify(l));
async function emitLines(lines) {
  for (const l of lines) await write(process.stdout, `${asLine(l)}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads stdin until EOF or `timeoutMs`, whichever comes first (a parent may never close it). */
async function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      process.stdin.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// ---------------------------------------------------------------- fixtures and streams

function loadFixture(spec) {
  const root = process.env.FAKE_FIXTURES_DIR ?? path.join(HERE, "..", "fixtures");
  const base = path.join(root, spec);
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const stdout = read(`${base}.stdout.jsonl`) ?? read(`${base}.json`);
  if (stdout === null) throw new Error(`fixture not found: ${spec}`);
  const meta = JSON.parse(read(`${base}.meta.json`) ?? "{}");
  const sub = (s) => s.replaceAll("<WT>", cwd).replaceAll("<TMP>", os.tmpdir());
  return {
    stdout: sub(stdout),
    stderr: sub(read(`${base}.stderr.txt`) ?? ""),
    exitCode: meta.exitCode ?? 0,
  };
}

/** Minimal valid "success" event stream for each CLI, carrying `text` as the final answer. */
function textStream(text) {
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (cli === "claude") {
    return [
      {
        type: "system",
        subtype: "init",
        cwd,
        session_id: SESSION,
        tools: [],
        mcp_servers: [],
        model: "claude-haiku-5-5",
        permissionMode: "acceptEdits",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          type: "message",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text }],
          usage,
        },
        session_id: SESSION,
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        num_turns: 1,
        result: text,
        session_id: SESSION,
        total_cost_usd: 0,
        usage,
      },
    ];
  }
  if (cli === "codex") {
    return [
      { type: "thread.started", thread_id: SESSION },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      {
        type: "turn.completed",
        usage: { ...usage, cached_input_tokens: 0, reasoning_output_tokens: 0 },
      },
    ];
  }
  return [
    {
      event: "init",
      conversation_id: SESSION,
      init: { model: "gemini-3.8-flash-low", cwd, permission_mode: "request-review", tools: [] },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: SESSION,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        usage: { ...usage, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: SESSION,
        status: "SUCCESS",
        response: text,
        num_turns: 1,
        usage,
        denied_actions: [],
      },
    },
  ];
}

/** Default success output: the recorded fixture where one exists, a synthetic stream otherwise. */
function successOutput(fixture) {
  const spec = fixture ?? DEFAULT_SUCCESS_FIXTURE[cli];
  if (spec) return loadFixture(spec);
  return { stdout: `${textStream("DONE").map(asLine).join("\n")}\n`, stderr: "", exitCode: 0 };
}

async function emitOutput(out) {
  if (out.stdout) await write(process.stdout, out.stdout);
  if (out.stderr) await write(process.stderr, out.stderr);
}

const successLines = (fixture) => successOutput(fixture).stdout.split("\n").filter(Boolean);

// ---------------------------------------------------------------- run scenarios

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function tryWrite(label, file, content, mode) {
  try {
    ensureDirFor(file);
    fs.writeFileSync(file, content, mode ? { mode } : undefined);
    return { label, path: file, ok: true };
  } catch (err) {
    return { label, path: file, ok: false, error: err.code ?? err.message };
  }
}

function gitDirOf(dir) {
  const dotGit = path.join(dir, ".git");
  try {
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (m) return path.resolve(dir, m[1].trim());
    }
  } catch {
    // no .git at all
  }
  return dotGit;
}

/** First half of the event's JSON: never parseable. */
const half = (event) => {
  const text = JSON.stringify(event);
  return text.slice(0, Math.ceil(text.length / 2));
};

const HOOK = "#!/bin/sh\necho FAKE-ESCAPE\n";

const scenarios = {
  async replay(sc) {
    const out = loadFixture(sc.fixture);
    if (sc.delayMs) await sleep(sc.delayMs);
    await emitOutput(out);
    return sc.exitCode ?? out.exitCode;
  },

  async success_edit(sc) {
    const files = sc.files ?? { [sc.file]: sc.content };
    for (const [rel, content] of Object.entries(files)) {
      const target = path.resolve(cwd, rel);
      ensureDirFor(target);
      fs.writeFileSync(target, content ?? "");
    }
    const out = successOutput(sc.fixture);
    await emitOutput(out);
    return sc.exitCode ?? out.exitCode;
  },

  async slow(sc) {
    const events = sc.events ?? successLines(sc.fixture);
    for (const e of events) {
      await sleep(sc.delayMs ?? 100);
      await emitLines([e]);
    }
    return sc.exitCode ?? 0;
  },

  async quota_exhausted(sc) {
    const out = loadFixture(`${cli}/${sc.version ?? FIXTURE_VERSION[cli]}/quota_exhausted`);
    await emitOutput(out);
    return sc.exitCode ?? out.exitCode;
  },

  async malformed(sc) {
    const good = textStream("partial");
    const unknown =
      cli === "agy"
        ? { event: "zz_unknown_event", payload: {} }
        : { type: "zz_unknown_event", payload: {} };
    await emitLines([good[0], half(good[1]), "WARNING: this line is not json at all", unknown]);
    await write(process.stdout, half(good[2])); // truncated, no newline
    return sc.exitCode ?? 0;
  },

  async crash(sc) {
    await emitLines(successLines(sc.fixture).slice(0, sc.lines ?? 2));
    await write(process.stderr, "fake-cli: Segmentation fault (simulated)\n");
    if (sc.signal) process.kill(process.pid, sc.signal);
    process.exit(sc.exitCode ?? 139);
  },

  async hang_ignore_term(sc) {
    let terms = 0;
    process.on("SIGTERM", () => {
      terms += 1;
      writeLog("update", { sigtermCount: terms });
    });
    const life = sc.maxLifetimeMs ?? 60000; // safety net: a failed test cannot leak processes forever
    // The grandchild reports on fd 3 once its SIGTERM handler is installed, so tests can rely on it.
    const code = `process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),${life});setInterval(()=>{},1000);require("fs").writeSync(3,"r")`;
    const quiet = sc.grandchildHoldsStdout === false;
    const grandchild = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", quiet ? "ignore" : "inherit", quiet ? "ignore" : "inherit", "pipe"],
      detached: Boolean(sc.grandchildDetached),
    });
    grandchild.unref();
    await new Promise((resolve) => {
      grandchild.stdio[3].once("data", resolve);
      setTimeout(resolve, 5000);
    });
    grandchild.stdio[3].destroy();
    writeLog("update", { grandchildPid: grandchild.pid });
    await emitLines(successLines(sc.fixture).slice(0, 1));
    setTimeout(() => process.exit(124), life);
    setInterval(() => {}, 1000);
    return undefined; // no exit code: the event loop stays alive
  },

  async recurse(sc) {
    const command = sc.command ?? process.env.DISPATCH_RECURSE_CMD;
    if (!command) {
      await write(process.stderr, "fake-cli recurse: no command and DISPATCH_RECURSE_CMD unset\n");
      return 97;
    }
    const r = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: sc.timeoutMs ?? 30000,
      maxBuffer: 1 << 20,
    });
    writeLog("update", {
      recurse: {
        command,
        exitCode: r.status,
        signal: r.signal,
        stdout: truncate(r.stdout ?? ""),
        stderr: truncate(r.stderr ?? ""),
        error: r.error?.message ?? null,
      },
    });
    await emitLines(textStream("recursion attempted"));
    return 0;
  },

  async escape_writes(sc) {
    const state = STATE ?? os.tmpdir();
    const results = [
      tryWrite("git-hook", path.join(cwd, ".git", "hooks", "pre-commit"), HOOK, 0o755),
      tryWrite("parent-dir", path.resolve(cwd, "..", "outside.txt"), "FAKE-ESCAPE\n"),
      tryWrite("absolute", path.join(state, "abs.txt"), "FAKE-ESCAPE\n"),
      tryWrite("dispatch-config", path.join(cwd, ".dispatch", "config.yaml"), "version: 1\n"),
      tryWrite("claude-settings", path.join(cwd, ".claude", "settings.json"), '{"FAKE":true}\n'),
    ];
    const resolved = gitDirOf(cwd); // linked worktrees have a .git *file*
    if (resolved !== path.join(cwd, ".git")) {
      results.push(
        tryWrite("git-hook-resolved", path.join(resolved, "hooks", "pre-commit"), HOOK, 0o755),
      );
    }
    if (sc.pinnedPath)
      results.push(tryWrite("pinned", path.resolve(cwd, sc.pinnedPath), "FAKE-ESCAPE\n"));
    writeLog("update", { escape: results });
    await emitLines(textStream("escape attempts finished"));
    return 0;
  },

  async symlink(sc) {
    const links = sc.links ?? { link: "/etc/passwd", link2: "../.." };
    const results = Object.entries(links).map(([name, target]) => {
      try {
        const file = path.join(cwd, name);
        fs.rmSync(file, { force: true });
        fs.symlinkSync(target, file);
        return { name, target, ok: true };
      } catch (err) {
        return { name, target, ok: false, error: err.code ?? err.message };
      }
    });
    writeLog("update", { symlink: results });
    await emitLines(textStream("symlinks created"));
    return 0;
  },

  async leak_secret(sc) {
    const canary = sc.secret ?? process.env.CANARY_SECRET ?? "";
    const text = `leak: ${SECRETS.anthropic} ${SECRETS.github} ${SECRETS.bearer} canary=${canary}`;
    await emitLines(textStream(text));
    await write(process.stderr, `${text}\n`);
    return 0;
  },

  async fail(sc) {
    if (sc.stdout) await write(process.stdout, sc.stdout);
    await write(process.stderr, sc.stderr ?? "fake-cli: simulated failure\n");
    return sc.exitCode ?? 1;
  },
};

// ---------------------------------------------------------------- subcommands

const CODEX_FEATURES = [
  ["hooks", "stable", "true"],
  ["plugins", "stable", "true"],
  ["multi_agent", "stable", "true"],
  ["multi_agent_v2", "experimental", "false"],
  ["apps", "stable", "true"],
  ["unified_exec", "stable", "true"],
  ["memories", "experimental", "false"],
];
const CODEX_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-reserve",
  "gpt-5.6-luna",
];

function agyUsage(cfg) {
  const variant = cfg.variant ?? "fixture";
  if (variant === "unauthenticated") {
    const short_error = "You are not logged in. Run `agy` to authenticate.";
    return { exitCode: 1, stderr: `AGY_ERROR: ${JSON.stringify({ short_error })}\n` };
  }
  if (variant === "changed_format") {
    const limits = [
      { model_group: "Gemini Models", remaining_pct: 100, resets: "2026-11-14T07:18:55Z" },
    ];
    const data = { status: "SUCCESS", response: "", command: { name: "usage", data: { limits } } };
    return { stdout: `${JSON.stringify(data)}\n` };
  }
  const fixture = JSON.parse(loadFixture(`agy/${FIXTURE_VERSION.agy}/usage`).stdout);
  if (cfg.remainingFraction !== undefined || cfg.resetTime !== undefined) {
    const rows = [];
    for (const g of fixture.command.data.groups) {
      for (const b of g.buckets) {
        if (cfg.remainingFraction !== undefined) b.remaining_fraction = cfg.remainingFraction;
        if (cfg.resetTime !== undefined) b.reset_time = cfg.resetTime;
        rows.push(
          `${g.name}\t${b.name}\t${Math.round(b.remaining_fraction * 100)}%\t${b.reset_time}`,
        );
      }
    }
    fixture.response = `${rows.join("\n")}\n`;
  }
  return { stdout: `${JSON.stringify(fixture)}\n` };
}

const defaults = {
  version: () => ({ stdout: `${VERSION_TEXT[cli]}\n` }),
  login: (cfg) =>
    cfg.loggedIn === false
      ? { exitCode: 1, stderr: "Not logged in\n" }
      : { stdout: "Logged in using ChatGPT\n" },
  features: () => ({
    stdout: `${CODEX_FEATURES.map(([n, stage, on]) => `${n.padEnd(28)}${stage.padEnd(16)}${on}`).join("\n")}\n`,
  }),
  models: () => {
    if (cli === "agy")
      return { stdout: "gemini-3.8-flash-low\ngemini-3.8-flash\ngemini-3.8-pro\n" };
    const models = CODEX_MODELS.map((slug) => ({
      slug,
      display_name: slug,
      multi_agent_version: slug === "gpt-reserve" || slug === "gpt-5.6-luna" ? "v1" : "v2",
      shell_type: "unified_exec",
    }));
    return { stdout: `${JSON.stringify({ models })}\n` };
  },
  plugin: () => ({ stdout: args.includes("list") && args.includes("--json") ? "[]\n" : "ok\n" }),
  usage: agyUsage,
};

async function runSubcommand(key, cfg) {
  if (key === "app-server") return runAppServer(cfg);
  const base = defaults[key]?.(cfg) ?? {
    exitCode: 2,
    stderr: `fake-cli: unsupported subcommand ${cli} ${args.join(" ")}\n`,
  };
  const out = {
    stdout: cfg.stdout ?? base.stdout,
    stderr: cfg.stderr ?? base.stderr,
    exitCode: cfg.exitCode ?? base.exitCode ?? 0,
  };
  if (cfg.delayMs) await sleep(cfg.delayMs);
  await emitOutput(out);
  return out.exitCode;
}

// ---------------------------------------------------------------- codex app-server

function rateLimitSnapshot(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const p = cfg.primaryUsed ?? 42;
  const s = cfg.secondaryUsed ?? 17;
  const exhausted = p >= 100 || s >= 100;
  return {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: p,
      windowDurationMins: 300,
      resetsAt: cfg.primaryResetsAt ?? now + 3 * 3600,
    },
    secondary: {
      usedPercent: s,
      windowDurationMins: 10080,
      resetsAt: cfg.secondaryResetsAt ?? now + 4 * 86400,
    },
    credits: null,
    planType: cfg.planType ?? "plus",
    ordinaryUsageAllowed: cfg.ordinaryUsageAllowed ?? !exhausted,
    rateLimitReachedType: cfg.rateLimitReachedType ?? (exhausted ? "rate_limit_reached" : null),
  };
}

function rateLimitsResult(cfg, variant) {
  if (variant === "changed_format") {
    const windows = {
      five_hour: { used_pct: 42, resets_in_s: 3600 },
      weekly: { used_pct: 17, resets_at_iso: "2026-11-14T07:18:55Z" },
    };
    return { limits: [{ id: "codex", windows }] };
  }
  const zero = variant === "always_zero" ? { primaryUsed: 0, secondaryUsed: 0 } : {};
  const snap = rateLimitSnapshot({ ...cfg, ...zero });
  return { rateLimits: snap, rateLimitsByLimitId: { codex: snap } };
}

async function runAppServer(cfg) {
  const variant = cfg.variant ?? "ok";
  const received = [];
  const send = (obj) =>
    write(process.stdout, `${JSON.stringify(cfg.jsonrpc ? { jsonrpc: "2.0", ...obj } : obj)}\n`);
  const notify = (method, params) =>
    cfg.notifications === false ? undefined : send({ method, params });
  let initialized = false;
  let queue = Promise.resolve();

  const handle = async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      received.push({ unparsable: truncate(line, 200) });
      await send({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    received.push(msg);
    const { id, method } = msg;
    if (method === "initialize") {
      await notify("configWarning", {
        summary: "fake notification before the initialize response",
      });
      if (variant === "hang" && cfg.hangAt === "initialize") return;
      initialized = true;
      const userAgent = "codex-cli/0.167.0 (fake)";
      await send({ id, result: { userAgent, codexHome: path.join(os.homedir(), ".codex") } });
    } else if (method === "initialized") {
      await notify("account/updated", { authMode: "chatgpt", planType: "plus" });
    } else if (method === "account/rateLimits/read") {
      if (!initialized) {
        await send({ id, error: { code: -32002, message: "Not initialized" } });
        return;
      }
      await notify("mcpServer/startupStatus/updated", { name: "fake", status: "ready" });
      if (variant === "hang") return;
      if (variant === "rpc_error") {
        const message = cfg.errorMessage ?? "rate limits unavailable (fake)";
        await send({ id, error: { code: cfg.errorCode ?? -32603, message } });
        return;
      }
      if (variant === "garbage") {
        await write(process.stdout, "<<< not json >>>\n");
        await send({ id, result: "not-an-object" });
        return;
      }
      const result = rateLimitsResult(cfg, variant);
      await notify(
        "account/rateLimits/updated",
        result.rateLimits ? { rateLimits: result.rateLimits } : result,
      );
      await send({ id, result });
      await notify("thread/status/changed", { status: "idle" });
    } else if (id !== undefined) {
      await send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  const life = cfg.maxLifetimeMs ?? 60000;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim()) queue = queue.then(() => handle(line));
  });
  if (variant === "hang") {
    setTimeout(() => process.exit(124), life);
    return new Promise(() => {}); // stays alive, even after stdin closes
  }
  await new Promise((resolve) => rl.on("close", resolve));
  await queue;
  writeLog("update", { rpcReceived: received });
  return 0;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!VERSION_TEXT[cli]) {
    console.error(`fake-cli: unknown cli ${JSON.stringify(cli)}`);
    return 96;
  }
  const { kind, key } = classify();
  const scenarioKey = kind === "run" ? cli : `${cli}:${key}`;
  const index = nextCallIndex(scenarioKey);
  const entry = pick(loadScenarioFile()[scenarioKey], index);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("FAKE_")),
  );
  let signalReceived = null;
  process.on("exit", (code) =>
    writeLog("end", { endedAt: new Date().toISOString(), exitCode: code, signalReceived }),
  );
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    if (sig === "SIGTERM" && entry?.scenario === "hang_ignore_term") continue;
    process.on(sig, () => {
      signalReceived = sig;
      process.exit(128 + os.constants.signals[sig]);
    });
  }

  writeLog("start", {
    cli,
    kind,
    key,
    scenario: entry?.scenario ?? null,
    callIndex: index,
    argv: [cli, ...args],
    args,
    cwd,
    env,
    pid: process.pid,
    ppid: process.ppid,
    pgid: currentPgid(),
    startedAt: new Date().toISOString(),
  });

  if (kind === "subcommand") return runSubcommand(key, entry ?? {});

  const reads = cli === "claude" || (cli === "codex" && args[0] === "exec");
  const stdin = reads ? await readStdin(Number(entry?.stdinTimeoutMs ?? 1000)) : Buffer.alloc(0);
  writeLog("update", { stdin: truncate(stdin.toString("utf8")), stdinBytes: stdin.length });

  if (!entry) {
    const where = process.env.FAKE_SCENARIO ?? "unset";
    await write(
      process.stderr,
      `fake-cli: no scenario for ${cli} call ${index} (FAKE_SCENARIO=${where})\n`,
    );
    return 97;
  }
  const run = scenarios[entry.scenario];
  if (!run) {
    await write(process.stderr, `fake-cli: unknown scenario ${JSON.stringify(entry.scenario)}\n`);
    return 98;
  }
  return run(entry);
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err) => {
    console.error(`fake-cli: ${err.stack ?? err}`);
    process.exitCode = 99;
  },
);
