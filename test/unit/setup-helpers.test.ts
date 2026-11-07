/** Detection and the pure helpers of the setup wizard. */
import { afterEach, describe, expect, it } from "vitest";
import { createDetector } from "../../src/setup/detect.js";
import {
  currentAnswers,
  renderGlobalConfig,
  updateGlobalConfig,
} from "../../src/setup/global-config.js";
import { describeAnswers, guessHost } from "../../src/setup/wizard.js";
import { createFakes, type FakesContext } from "../support/index.js";

let fakes: FakesContext | undefined;
afterEach(() => {
  fakes?.dispose();
  fakes = undefined;
});

describe("detection", () => {
  it("probes quota-free through the adapters; an unknown or missing CLI is 'not installed'", async () => {
    fakes = createFakes({ "codex:login": { loggedIn: true } });
    const found = await createDetector(fakes.env)(["claude", "codex", "nope"]);
    expect(found.map((c) => [c.id, c.installed, c.loggedIn])).toEqual([
      ["claude", true, null],
      ["codex", true, true],
      ["nope", false, null],
    ]);
    expect(found[0]?.version).toMatch(/^\d+\.\d+\.\d+/);
    const none = await createDetector(fakes.env, undefined, () => null)(["claude", "codex"]);
    expect(none.every((c) => !c.installed)).toBe(true);
    const boom = await createDetector(fakes.env, undefined, () => {
      throw new Error("boom");
    })(["claude"]);
    expect(boom[0]?.installed).toBe(false);
  });
});

describe("wizard helpers", () => {
  it("guesses the host from the environment, then from what is installed", () => {
    const some = (id: string) => [{ id, installed: true, version: null, loggedIn: null }];
    expect(guessHost({ CLAUDECODE: "1" }, [])).toBe("claude-code");
    expect(guessHost({ CODEX_THREAD_ID: "t" }, [])).toBe("codex");
    expect(guessHost({}, some("codex"))).toBe("codex");
    expect(guessHost({}, some("claude"))).toBe("claude-code");
    expect(guessHost({}, [])).toBe("none");
  });

  it("describes only what was answered", () => {
    expect(describeAnswers({ plans: {} })).toEqual(["plans: none declared (unknown)"]);
    expect(describeAnswers({ plans: { codex: "pro" }, enableAntigravity: true })).toEqual([
      "plans: codex=pro",
      "antigravity: enabled (terms accepted)",
    ]);
  });
});

describe("global config helpers", () => {
  it("reads the current answers leniently", () => {
    expect(currentAnswers("a: [unclosed")).toEqual({ plans: {} });
    expect(currentAnswers("just text")).toEqual({ plans: {} });
    expect(currentAnswers("main_host: emacs\nautonomy: root\nprofile: 3")).toEqual({ plans: {} });
    expect(
      currentAnswers(
        "profile: preserve\nautonomy: direct\nproviders:\n  codex:\n  claude: { plan: pro }\n  antigravity: { enabled: true }\n",
      ),
    ).toEqual({
      plans: { claude: "pro" },
      profile: "preserve",
      autonomy: "direct",
      enableAntigravity: true,
      acceptAgyTerms: false,
    });
  });

  it("every combination of answers renders a config its own loader accepts", () => {
    const variants: Record<string, string>[] = [
      {},
      { claude: "pro" },
      { codex: "unknown" },
      { antigravity: "ultra" },
    ];
    for (const plans of variants) {
      for (const enableAntigravity of [false, true]) {
        const text = renderGlobalConfig({
          mainHost: "none",
          profile: "balance",
          autonomy: "direct",
          plans,
          enableAntigravity,
        });
        expect(text).toContain("autonomy: direct");
      }
    }
  });

  it("update leaves a text without answers byte-identical in meaning", () => {
    const text = "# c\nversion: 1\nprofile: balance # p\n";
    expect(updateGlobalConfig(text, { plans: {} }, "x")).toBe(text);
  });
});
