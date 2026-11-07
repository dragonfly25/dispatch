import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";

/**
 * Bundles a helper entry from test/helpers into a temp directory as a self-contained ESM file
 * (dependencies inlined), so tests can run it with plain `node` and no TypeScript loader.
 * The caller removes `dir` afterwards.
 */
export async function bundleHelper(name: string): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), `dispatch-helper-${name}-`));
  await build({
    entry: { [name]: `test/helpers/${name}.ts` },
    outDir: dir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node22",
    noExternal: [/.*/],
    silent: true,
    clean: false,
    dts: false,
    config: false,
  });
  return { dir, file: join(dir, `${name}.mjs`) };
}
