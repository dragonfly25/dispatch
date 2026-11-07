import { defineConfig, type Options } from "tsup";

/**
 * Two bundles, built separately so only the bin gets the shebang (`pnpm build` empties `dist/`
 * first; the per-entry configs must not clean each other's output):
 * - `cli.mjs`: the `dispatch` bin.
 * - `hook.mjs`: the light hook entry, kept separate so host hooks stay fast (≤ 80 ms budget).
 *   It is always started as `node hook.mjs`, so it needs no shebang.
 */
const shared: Options = {
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  clean: false,
  splitting: false,
  sourcemap: false,
  dts: false,
};

export default defineConfig([
  { ...shared, entry: { cli: "src/cli/main.ts" }, banner: { js: "#!/usr/bin/env node" } },
  { ...shared, entry: { hook: "src/hook/entry.ts" } },
]);
