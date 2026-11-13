// Windows entry of a fake CLI: `<name>.cmd` (an npm cmd-shim) unwraps to `node <name>.mjs`, which
// cannot source `.fake-env` or pass the CLI name like the POSIX sh shim does. So this script loads
// the per-run `.fake-env.json` written next to it by test/support/fakes.ts, then runs fake-cli.mjs
// as `<name>`. Identical for every CLI: the name is this file's base name.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const config = join(here, ".fake-env.json");
if (existsSync(config)) Object.assign(process.env, JSON.parse(readFileSync(config, "utf8")));
const fakeCli = process.env.FAKE_CLI_JS || join(here, "..", "fake-cli.mjs");
process.argv.splice(2, 0, basename(self, ".mjs"));
await import(pathToFileURL(fakeCli).href);
