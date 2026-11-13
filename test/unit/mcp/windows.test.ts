/** Windows rules of the MCP resolver: home lookup and `projects` keys (injected platform). */
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeJsonPath, listMcpServers, type ReadText } from "../../../src/mcp/index.js";

const HOME = "C:\\Users\\me";
const files =
  (map: Record<string, unknown>): ReadText =>
  (p) =>
    map[p] === undefined ? null : JSON.stringify(map[p]);
const server = { command: "srv", args: [] };

describe("MCP resolver on Windows", () => {
  it("finds .claude.json under USERPROFILE", () => {
    expect(claudeJsonPath({ USERPROFILE: HOME }, "win32")).toBe(win32.join(HOME, ".claude.json"));
    expect(claudeJsonPath({ claude_config_dir: "D:\\c" }, "win32")).toBe("D:\\c\\.claude.json");
    expect(claudeJsonPath({ USERPROFILE: HOME }, "linux")).toBeNull();
  });

  it("matches a projects key spelled with / and another case", () => {
    const read = files({
      [win32.join(HOME, ".claude.json")]: {
        projects: { "c:/work/REPO": { mcpServers: { local: server } }, other: 1 },
      },
    });
    const names = listMcpServers(
      "C:\\Work\\Repo",
      { USERPROFILE: HOME },
      { read, platform: "win32" },
    )
      .filter((s) => s.scope === "local")
      .map((s) => s.name);
    expect(names).toEqual(["local"]);
    const none = listMcpServers(
      "C:\\Work\\Other",
      { USERPROFILE: HOME },
      { read, platform: "win32" },
    );
    expect(none.filter((s) => s.scope === "local")).toEqual([]);
  });

  it("reads user settings from <home>\\.claude", () => {
    const seen: string[] = [];
    listMcpServers(
      null,
      { USERPROFILE: HOME },
      {
        read: (p) => {
          seen.push(p);
          return null;
        },
        platform: "win32",
      },
    );
    expect(seen).toContain(win32.join(HOME, ".claude", "settings.json"));
  });
});
