import { defineConfig } from "vitest/config";

/**
 * Coverage gates (plan §3): 85% global now. The 95% per-directory gates for
 * src/router, src/config, the patch filter and redaction are added by the WPs
 * that create those directories (WP4, WP5, WP6, WP12), e.g.:
 *   "src/router/**": { lines: 95, functions: 95, branches: 95, statements: 95 }
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // node:sqlite prints an ExperimentalWarning on first load; hide only that warning type.
    execArgv: ["--disable-warning=ExperimentalWarning"],
    // Fails the run early when the fake CLI shims are missing or not executable (WP2).
    globalSetup: ["test/support/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only files and thin process entries are exercised by build/pack-smoke instead.
      exclude: ["src/cli/main.ts", "src/hook/entry.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        "src/platform/**": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/quota/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "src/state/redact.ts": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/router/**": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/config/**": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/sandbox/filter.ts": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/shadow/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "src/adapters/codex/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "src/adapters/agy/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "src/adapters/claude/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "src/hosts/_framework/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
      },
    },
  },
});
