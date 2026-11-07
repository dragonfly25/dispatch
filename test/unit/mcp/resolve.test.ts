/** MCP forwarding resolver: precedence, scopes, transports, the secrets rule. Pure (injected reads). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeJsonPath,
  describeServer,
  forwardableNames,
  listMcpServers,
  memoRead,
  REASONS,
  type ReadText,
  referencedVariables,
  resolveForwardedServers,
} from "../../../src/mcp/index.js";

const HOME = "/home/u";
const ROOT = "/work/repo";
const ENV = { HOME };
/** `${NAME}` without a template placeholder in the source. */
const ref = (name: string) => `\${${name}}`;
const SECRET = "canary-mcp-ghp_0123456789";

function files(map: Record<string, unknown>): ReadText {
  return (path) => {
    const v = map[path];
    if (v === undefined) return null;
    return typeof v === "string" ? v : JSON.stringify(v);
  };
}

const claudeJson = (body: unknown) => ({ [join(HOME, ".claude.json")]: body });

describe("describeServer [SEC-mcp]", () => {
  it("accepts stdio and http servers whose env/header values are pure references", () => {
    expect(
      describeServer("gh", "user", {
        command: "gh-mcp",
        args: ["--stdio"],
        env: { GH_TOKEN: ref("GH_TOKEN") },
      }),
    ).toEqual({
      name: "gh",
      scope: "user",
      transport: "stdio",
      command: "gh-mcp",
      args: ["--stdio"],
      envRefs: ["GH_TOKEN"],
      headerRefs: [],
      headers: {},
      forwardable: true,
    });
    expect(
      describeServer("api", "project", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: ref("API_AUTH") },
      }),
    ).toMatchObject({
      transport: "http",
      headers: { Authorization: "API_AUTH" },
      headerRefs: ["API_AUTH"],
      forwardable: true,
    });
    // A url without a type is http, as in Claude Code.
    expect(describeServer("u", "user", { url: "https://x.test" }).transport).toBe("http");
  });

  it.each([
    ["literal env", { command: "x", env: { API_KEY: SECRET } }, REASONS.literal],
    ["literal header", { type: "http", url: "https://x", headers: { A: SECRET } }, REASONS.literal],
    [
      "default value",
      { command: "x", env: { K: `${ref("K").slice(0, -1)}:-x}` } },
      REASONS.literal,
    ],
    ["ref with text", { command: "x", env: { K: `Bearer ${ref("K")}` } }, REASONS.literal],
    ["non-string env", { command: "x", env: { K: 1 } }, REASONS.literal],
    ["renamed env", { command: "x", env: { API_KEY: ref("MY_KEY") } }, REASONS.rename],
    ["reserved var", { command: "x", env: { CODEX_HOME: ref("CODEX_HOME") } }, REASONS.reserved],
    [
      "NODE_OPTIONS",
      { command: "x", env: { NODE_OPTIONS: ref("NODE_OPTIONS") } },
      REASONS.reserved,
    ],
    ["expansion in args", { command: "x", args: [ref("HOME")] }, REASONS.expand],
    ["expansion in url", { type: "http", url: `https://${ref("HOST")}` }, REASONS.expand],
    ["headersHelper", { type: "http", url: "https://x", headersHelper: "h.sh" }, REASONS.helper],
    ["oauth", { type: "http", url: "https://x", oauth: { clientId: "c" } }, REASONS.helper],
    ["sse", { type: "sse", url: "https://x" }, REASONS.sse],
    ["ws", { type: "ws", url: "wss://x" }, REASONS.transport],
    ["no command", { type: "stdio" }, REASONS.malformed],
    ["not an object", "nope", REASONS.malformed],
    ["env not an object", { command: "x", env: ["A"] }, REASONS.malformed],
  ])("%s is not forwardable", (_n, raw, reason) => {
    const s = describeServer("s", "user", raw);
    expect(s).toMatchObject({ forwardable: false, reason });
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("rejects names that are not a safe TOML key", () => {
    expect(describeServer("a.b", "user", { command: "x" }).reason).toBe(REASONS.name);
    expect(describeServer('a"b', "user", { command: "x" }).reason).toBe(REASONS.name);
  });
});

describe("listMcpServers", () => {
  it("resolves local > project > user, project servers only when approved", () => {
    const read = files({
      ...claudeJson({
        mcpServers: {
          shared: { command: "user-shared" },
          useronly: { command: "u" },
        },
        projects: {
          [ROOT]: {
            mcpServers: { shared: { command: "local-shared" } },
            enabledMcpjsonServers: ["approved"],
            disabledMcpjsonServers: ["rejected"],
          },
        },
      }),
      [join(ROOT, ".mcp.json")]: {
        mcpServers: {
          shared: { command: "project-shared" },
          approved: { command: "p1" },
          rejected: { command: "p2" },
          pending: { command: "p3" },
        },
      },
    });
    const all = listMcpServers(ROOT, ENV, { read });
    const by = Object.fromEntries(all.map((s) => [s.name, s]));
    expect(all.map((s) => s.name)).toEqual([
      "approved",
      "pending",
      "rejected",
      "shared",
      "useronly",
    ]);
    expect(by.shared).toMatchObject({ scope: "local", command: "local-shared" });
    expect(by.approved).toMatchObject({ scope: "project", forwardable: true });
    expect(by.pending).toMatchObject({ forwardable: false, reason: REASONS.unapproved });
    expect(by.rejected).toMatchObject({ forwardable: false, reason: REASONS.unapproved });
    expect(by.useronly).toMatchObject({ scope: "user", forwardable: true });
    expect(forwardableNames(ROOT, ENV, { read })).toEqual(["approved", "shared", "useronly"]);
    // User scope only (every repo).
    expect(forwardableNames(null, ENV, { read })).toEqual(["shared", "useronly"]);
  });

  it("honours enableAllProjectMcpServers from user or local settings, minus disabled ones", () => {
    const project = {
      [join(ROOT, ".mcp.json")]: { mcpServers: { a: { command: "a" }, b: { command: "b" } } },
    };
    const viaUser = files({
      ...project,
      [join(HOME, ".claude", "settings.json")]: { enableAllProjectMcpServers: true },
      [join(ROOT, ".claude", "settings.local.json")]: { disabledMcpjsonServers: ["b"] },
    });
    expect(forwardableNames(ROOT, ENV, { read: viaUser })).toEqual(["a"]);
    // The repo-shared .claude/settings.json is repo content: it cannot approve its own servers.
    const viaRepo = files({
      ...project,
      [join(ROOT, ".claude", "settings.json")]: { enableAllProjectMcpServers: true },
    });
    expect(forwardableNames(ROOT, ENV, { read: viaRepo })).toEqual([]);
  });

  it("reads $CLAUDE_CONFIG_DIR/.claude.json when the variable is set", () => {
    const env = { HOME, CLAUDE_CONFIG_DIR: "/cfg/alt" };
    expect(claudeJsonPath(env)).toBe("/cfg/alt/.claude.json");
    expect(claudeJsonPath({})).toBeNull();
    const read = files({ "/cfg/alt/.claude.json": { mcpServers: { alt: { command: "a" } } } });
    expect(forwardableNames(ROOT, env, { read })).toEqual(["alt"]);
    expect(listMcpServers(ROOT, {}, { read })).toEqual([]);
  });

  it("treats missing and malformed files as no servers", () => {
    expect(listMcpServers(ROOT, ENV, { read: () => null })).toEqual([]);
    const read = files({
      ...claudeJson("{not json"),
      [join(ROOT, ".mcp.json")]: "[]",
      [join(HOME, ".claude", "settings.json")]: "null",
    });
    expect(listMcpServers(ROOT, ENV, { read })).toEqual([]);
    const odd = files(claudeJson({ mcpServers: [1], projects: { [ROOT]: "x" } }));
    expect(listMcpServers(ROOT, ENV, { read: odd })).toEqual([]);
    expect(listMcpServers(ROOT, ENV, { read: files(claudeJson({ projects: [] })) })).toEqual([]);
  });

  it("finds the project entry under the realpath of the repo root, from real files", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-mcp-"));
    try {
      const real = join(dir, "real");
      mkdirSync(real);
      symlinkSync(real, join(dir, "link"));
      const home = join(dir, "home");
      mkdirSync(home);
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          projects: { [realpathSync(real)]: { mcpServers: { here: { command: "h" } } } },
        }),
      );
      expect(forwardableNames(join(dir, "link"), { HOME: home })).toEqual(["here"]);
      expect(forwardableNames(join(dir, "missing"), { HOME: home })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memoRead reads each path once", () => {
    let n = 0;
    const read = memoRead((p) => {
      n++;
      return p;
    });
    expect(read("a")).toBe("a");
    expect(read("a")).toBe("a");
    expect(n).toBe(1);
  });
});

describe("resolveForwardedServers (run-time re-resolution) [SEC-mcp]", () => {
  const read = files(
    claudeJson({
      mcpServers: {
        gh: { command: "gh-mcp", env: { GH_TOKEN: ref("GH_TOKEN") } },
        leaky: { command: "x", env: { API_KEY: SECRET } },
        api: { type: "http", url: "https://x.test", headers: { Authorization: ref("API_AUTH") } },
      },
    }),
  );

  it("keeps forwardable servers whose variables are set, in request order", () => {
    const r = resolveForwardedServers(
      ROOT,
      ["gh", "api", "gh"],
      { ...ENV, GH_TOKEN: "t", API_AUTH: "a" },
      { read },
    );
    expect(r.dropped).toEqual([]);
    expect(r.servers.map((s) => s.name)).toEqual(["gh", "api"]);
    expect(referencedVariables(r.servers)).toEqual(["GH_TOKEN", "API_AUTH"]);
  });

  it("drops unknown, literal-secret and unset-variable servers with a reason", () => {
    const r = resolveForwardedServers(ROOT, ["Claude_Browser", "leaky", "gh"], ENV, { read });
    expect(r.servers).toEqual([]);
    expect(r.dropped).toEqual([
      { name: "Claude_Browser", reason: REASONS.notFound },
      { name: "leaky", reason: REASONS.literal },
      { name: "gh", reason: "GH_TOKEN not set in Dispatch's environment" },
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
