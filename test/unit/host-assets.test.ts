import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(root, "assets", "hosts", rel), "utf8");

/** Placeholders the host-integration code (WP17/WP22/WP27) must fill in. */
const KNOWN = new Set([
  "LAUNCHER",
  "WAIT_TIMEOUT",
  "VERSION",
  "HOOK_COMMAND_SESSION_START",
  "HOOK_COMMAND_PRE_TOOL_USE",
]);

const TEMPLATES = [
  "claude-code/marketplace.json",
  "claude-code/plugin.json",
  "claude-code/agents/dispatch.md",
  "claude-code/hooks/hooks.json",
  "codex/skills/dispatch/SKILL.md",
  "codex/hooks.fragment.json",
  "codex/dispatch.rules.tmpl",
];

/** Renders a template the way setup must: JSON-escaped values inside JSON/Starlark strings. */
function render(rel: string, values: Record<string, string>): string {
  const needsEscape = rel.endsWith(".json") || rel.endsWith(".tmpl");
  return read(rel).replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const v = values[name] ?? "";
    return needsEscape ? JSON.stringify(v).slice(1, -1) : v;
  });
}

const values = {
  LAUNCHER: "/home/u/.dispatch/bin/dispatch",
  WAIT_TIMEOUT: "100",
  VERSION: "0.1.0",
  HOOK_COMMAND_SESSION_START:
    '[ -n "$DISPATCH_DEPTH" ] && exit 0; exec /abs/node /abs/hook.mjs claude SessionStart',
  HOOK_COMMAND_PRE_TOOL_USE: "exec /abs/node /abs/hook.mjs codex PreToolUse",
};

describe("host asset templates [UC2][UC3][UC9]", () => {
  it.each(TEMPLATES)("%s uses only known placeholders", (rel) => {
    const names = [...read(rel).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1] as string);
    for (const n of names) expect(KNOWN.has(n), `${rel}: unknown placeholder ${n}`).toBe(true);
  });

  it.each(TEMPLATES.filter((t) => t.endsWith(".json")))(
    "%s renders to valid JSON even with quotes in the hook command",
    (rel) => {
      expect(() => JSON.parse(render(rel, values))).not.toThrow();
    },
  );

  it("claude hooks.json carries the SessionStart guard command verbatim", () => {
    const hooks = JSON.parse(render("claude-code/hooks/hooks.json", values));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(values.HOOK_COMMAND_SESSION_START);
  });

  it("codex hooks fragment matches the V2 spawn tool names [UC3]", () => {
    const frag = JSON.parse(render("codex/hooks.fragment.json", values));
    const matcher: string = frag.hooks.PreToolUse[0].matcher;
    expect(matcher.split("|").sort()).toEqual(["Agent", "collaborationspawn_agent", "spawn_agent"]);
    expect(frag.hooks.SessionStart).toHaveLength(1);
  });

  it("claude agent and codex skill give the same delegation protocol", () => {
    for (const rel of ["claude-code/agents/dispatch.md", "codex/skills/dispatch/SKILL.md"]) {
      const text = render(rel, values);
      expect(text, rel).toContain("/home/u/.dispatch/bin/dispatch run --detach --json");
      expect(text, rel).toContain("/home/u/.dispatch/bin/dispatch wait <runId> --timeout 100");
      expect(text, rel).toContain("EXTERNAL_AGENT_OUTPUT");
      expect(text, rel).toContain("75");
      expect(text, rel).toMatch(/Dispatch never applies/i);
      expect(text, rel).not.toContain("{{");
    }
  });

  it("codex skill tells the model to poll a yielded wait instead of re-running it", () => {
    expect(read("codex/skills/dispatch/SKILL.md")).toContain("write_stdin");
  });

  it("rules template allows only the four subcommands and names no shell metacharacters", () => {
    const rules = render("codex/dispatch.rules.tmpl", values);
    expect(rules).toContain(
      'pattern = ["/home/u/.dispatch/bin/dispatch", ["run", "wait", "cancel", "status"]]',
    );
    expect(rules).toContain('decision = "allow"');
    expect(rules).not.toMatch(/forbidden|prompt/);
    expect(rules).toContain('["/home/u/.dispatch/bin/dispatch", "install"]');
  });
});
