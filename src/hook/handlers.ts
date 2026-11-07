import type { HookHostTable } from "./run.js";

/**
 * Hook handler modules per host id. WP22 and WP27 add entries such as
 * `"codex": async () => (await import("../hosts/codex/hook.js")).hookHandlers`.
 * Those modules must import only node built-ins, types and `src/hook/cache.ts`, so the hook entry
 * stays within its 80 ms budget (no zod, no SQLite, no config loader).
 */
export const HOOK_HOSTS: HookHostTable = {
  "claude-code": async () => (await import("../hosts/claude-code/hook.js")).hookHandlers,
  codex: async () => (await import("../hosts/codex/hook.js")).hookHandlers,
};
