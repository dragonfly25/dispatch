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
        "src/state/redact.ts": { lines: 95, functions: 95, branches: 95, statements: 95 },
        "src/router/**": { lines: 95, functions: 95, branches: 95, statements: 95 },
      },
    },
  },
});
