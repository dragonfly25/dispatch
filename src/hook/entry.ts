/**
 * Light hook entry (`dist/hook.mjs`), invoked by host hooks as `node hook.mjs <host> <event>`.
 * Budget: ≤ 80 ms. It must never fail the host: any problem means a silent exit 0.
 * For now it drains stdin and exits; WP17 adds the real dispatching to host handlers.
 */
const done = (): never => process.exit(0);

if (process.stdin.isTTY) done();
process.stdin.on("data", () => {});
process.stdin.on("end", done);
process.stdin.on("error", done);
