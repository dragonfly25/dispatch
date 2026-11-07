import { defineConfig } from "tsup";

/**
 * Two bundles:
 * - `cli.mjs`: the `dispatch` bin.
 * - `hook.mjs`: the light hook entry, kept separate so host hooks stay fast (≤ 80 ms budget).
 */
export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    hook: "src/hook/entry.ts",
  },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
