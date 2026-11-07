import { describe, expect, it } from "vitest";
import { MIN_SECRET_LENGTH, redact, redactDeep } from "../../src/state/redact.js";
import { CANARY_MARKER, SECRET_SAMPLES } from "../support/secrets.js";

describe("[SEC-redact] redact()", () => {
  for (const [name, sample] of Object.entries(SECRET_SAMPLES)) {
    it(`masks ${name} and keeps surrounding text`, () => {
      const out = redact(`before ${sample} after`);
      expect(out).not.toContain(CANARY_MARKER);
      expect(out.startsWith("before ")).toBe(true);
      expect(out.endsWith(" after")).toBe(true);
      expect(out).toMatch(/\[REDACTED:[a-z-]+\]/);
    });
  }

  it("labels each kind", () => {
    expect(redact(SECRET_SAMPLES["anthropic-key"])).toBe("[REDACTED:anthropic-key]");
    expect(redact(SECRET_SAMPLES["openai-key"])).toBe("[REDACTED:openai-key]");
    expect(redact(SECRET_SAMPLES["github-token-pat"])).toBe("[REDACTED:github-token]");
    expect(redact(SECRET_SAMPLES["google-key"])).toBe("[REDACTED:google-key]");
    expect(redact(SECRET_SAMPLES["slack-token"])).toBe("[REDACTED:slack-token]");
    expect(redact(SECRET_SAMPLES["aws-key-id"])).toBe("[REDACTED:aws-key-id]");
    expect(redact(SECRET_SAMPLES.jwt)).toBe("[REDACTED:jwt]");
    expect(redact(SECRET_SAMPLES["private-key"])).toBe("[REDACTED:private-key]");
  });

  it("keeps the header name for Authorization and Bearer, masks the credential", () => {
    expect(redact("Authorization: Bearer abcdef1234567890")).toBe(
      "Authorization: [REDACTED:authorization]",
    );
    expect(redact('{"authorization":"Bearer abcdef1234567890"}')).toBe(
      '{"authorization":"[REDACTED:authorization]"}',
    );
    expect(redact("curl -H 'x: y' with Bearer abcdef1234567890 done")).toBe(
      "curl -H 'x: y' with Bearer [REDACTED:bearer] done",
    );
    expect(redact(`aws_secret_access_key = ${"A".repeat(40)}`)).toBe(
      "aws_secret_access_key = [REDACTED:aws-secret]",
    );
  });

  it("masks an unterminated private key block up to the end of the text", () => {
    const out = redact("log\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nmore");
    expect(out).toBe("log\n[REDACTED:private-key]");
  });

  it("masks every occurrence", () => {
    const out = redact(`${SECRET_SAMPLES["github-token"]} and ${SECRET_SAMPLES["github-token"]}`);
    expect(out).toBe("[REDACTED:github-token] and [REDACTED:github-token]");
  });

  it("leaves ordinary text alone", () => {
    const text = [
      "run 01KA0000000000000000000000 finished in 4200ms",
      "task-list risk-assessment disk-cleanup-utility-for-large-volumes",
      "src/state/store.ts version 1.2.3 a.b.c",
      "sk- alone, ghp_ short, AIza short, Bearer x",
    ].join("\n");
    expect(redact(text)).toBe(text);
  });

  it("removes explicit secrets (longest first) and ignores very short ones", () => {
    const out = redact("pw=hunter2-extra and hunter2 and ab", [
      "hunter2",
      "hunter2-extra",
      "ab",
      "",
    ]);
    expect(out).toBe("pw=[REDACTED:secret] and [REDACTED:secret] and ab");
    expect(MIN_SECRET_LENGTH).toBe(4);
    expect(redact("x", undefined)).toBe("x");
  });

  it("is idempotent", () => {
    const text = Object.values(SECRET_SAMPLES).join("\n");
    const once = redact(text, ["zzzz-secret"]);
    expect(redact(once, ["zzzz-secret"])).toBe(once);
  });
});

describe("[SEC-redact] redactDeep()", () => {
  it("redacts strings in nested objects, arrays and keys without mutating the input", () => {
    const input = {
      a: SECRET_SAMPLES["anthropic-key"],
      list: ["ok", SECRET_SAMPLES.jwt, { deep: SECRET_SAMPLES["slack-token"] }],
      [SECRET_SAMPLES["google-key"]]: "keyed",
      n: 3,
      b: true,
      nil: null,
      undef: undefined,
    };
    const snapshot = structuredClone(input);
    const out = redactDeep(input);
    expect(JSON.stringify(out)).not.toContain(CANARY_MARKER);
    expect(out.n).toBe(3);
    expect(out.b).toBe(true);
    expect(out.nil).toBeNull();
    expect(out.list[0]).toBe("ok");
    expect(input).toEqual(snapshot);
  });

  it("applies explicit secrets everywhere", () => {
    const out = redactDeep(
      { env: { TOKEN: "super-secret-value" }, lines: ["x super-secret-value"] },
      ["super-secret-value"],
    );
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
  });

  it("turns Dates into ISO strings and passes primitives through", () => {
    expect(redactDeep(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
  });

  it("handles cycles and shared (non-circular) references", () => {
    const shared = { v: SECRET_SAMPLES["openai-key"] };
    const cyc: Record<string, unknown> = { shared, again: shared };
    cyc.self = cyc;
    const out = redactDeep(cyc) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
    expect(out.shared).toEqual({ v: "[REDACTED:openai-key]" });
    expect(out.again).toEqual({ v: "[REDACTED:openai-key]" });
  });
});
