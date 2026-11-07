import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLES, renderConfigReference } from "../../scripts/gen-config-reference.js";
import { loadEffectiveConfig, trustRepo, validate } from "../../src/config/index.js";
import { sandbox } from "./config/helpers.js";

const DOC = join(import.meta.dirname, "..", "..", "docs", "configuration.md");

describe("docs/configuration.md [AC6]", () => {
  it("is up to date with the schemas (run `pnpm docs:config` to regenerate)", () => {
    expect(readFileSync(DOC, "utf8")).toBe(renderConfigReference());
  });

  it("documents every key of every file kind", () => {
    const doc = renderConfigReference();
    for (const key of [
      "`autonomy`",
      "`allowed_providers`",
      "`providers.<instance>.max_autonomy`",
      "`worktree.bootstrap`",
      "`pins`",
      "`trusted_repos`",
      "`quota.readers`",
      "`rules`",
      "`action.type`",
      "`match.min_remaining_pct`",
      "`preset.effort_shift`",
      "`models.<adapter>.tiers.<tier>.relative_cost`",
    ]) {
      expect(doc).toContain(key);
    }
    expect(doc).toMatch(
      /`autonomy` \| enum \| `worktree` \|.*\| global; repo and flags only tighten \|/,
    );
  });

  it("annotated examples load, trust and validate without errors", () => {
    const box = sandbox();
    box.global(EXAMPLES.global);
    const repo = box.repo("app", {
      ".dispatch/config.yaml": EXAMPLES.repo,
      ".dispatch/profiles/team-review.yaml": EXAMPLES.profile,
      ".dispatch/mappings/thrifty.yaml": EXAMPLES.mapping,
    });
    trustRepo({ cwd: repo, env: box.env, now: new Date("2026-11-07T09:00:00Z") });
    const loaded = loadEffectiveConfig({ cwd: repo, env: box.env });
    expect(loaded.trusted).toBe(true);
    expect(loaded.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(loaded.routing.profiles["team-review"]).toBeDefined();
    expect(loaded.routing.presets.thrifty).toBeDefined();
    expect(validate(loaded).filter((i) => i.level === "error")).toEqual([]);
  });
});
