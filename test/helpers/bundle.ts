import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";

/**
 * Bundles a helper entry from test/helpers into a temp directory as a self-contained ESM file
 * (dependencies inlined), so tests can run it with plain `node` and no TypeScript loader.
 * The caller removes `dir` afterwards.
 *
 * `opts.parent` places the temp directory elsewhere. With `opts.external` the npm dependencies
 * stay external (some, like `yaml`, cannot be inlined into ESM); `parent` must then be inside the
 * package so node resolves them from its `node_modules`.
 */
export async function bundleHelper(
  name: string,
  opts: { parent?: string; external?: boolean } = {},
): Promise<{ dir: string; file: string }> {
  const parent = opts.parent ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `dispatch-helper-${name}-`));
  await build({
    entry: { [name]: `test/helpers/${name}.ts` },
    outDir: dir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node22",
    ...(opts.external ? { removeNodeProtocol: false } : { noExternal: [/.*/] }),
    silent: true,
    clean: false,
    dts: false,
    config: false,
  });
  return { dir, file: join(dir, `${name}.mjs`) };
}

/**
 * Builds the real `dispatch` bin (`src/cli/main.ts`, same options as `tsup.config.ts`) into
 * `node_modules/.cache/dispatch-test-cli/cli.mjs`, so it still finds the package root (assets,
 * dependencies) and `dist/` is left alone. Returns the file to run with plain `node`.
 */
export async function buildCli(): Promise<string> {
  const outDir = join(process.cwd(), "node_modules", ".cache", "dispatch-test-cli");
  await build({
    entry: { cli: "src/cli/main.ts" },
    outDir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node22",
    clean: false,
    splitting: false,
    sourcemap: false,
    dts: false,
    removeNodeProtocol: false,
    banner: { js: "#!/usr/bin/env node" },
    silent: true,
    config: false,
  });
  return join(outDir, "cli.mjs");
}
