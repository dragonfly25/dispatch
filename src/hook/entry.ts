/**
 * Light hook entry (`dist/hook.mjs`), invoked by host hooks as `node hook.mjs <host> <event>`.
 * Budget: ≤ 80 ms. It must never fail the host: any problem means a silent exit 0. It never opens
 * the SQLite database; handlers read `~/.dispatch/hook-cache.json` instead.
 */
import { HOOK_HOSTS } from "./handlers.js";
import { MAX_HOOK_STDIN, readLimited, runHook } from "./run.js";

const quit = (code = 0): never => process.exit(code);

// Safety net: the host kills slow hooks anyway; leave quietly well before its timeout.
setTimeout(() => quit(0), 4000).unref();

try {
  if (process.stdin.isTTY) quit(0);
  const stdin = await readLimited(process.stdin, MAX_HOOK_STDIN);
  const res = await runHook(process.argv.slice(2), stdin, HOOK_HOSTS);
  if (res.stdout) process.stdout.write(res.stdout, () => quit(res.exitCode));
  else quit(res.exitCode);
} catch {
  quit(0);
}
