// Hook handlers run inside the <= 80 ms hook entry (dist/hook.mjs). Import only node built-ins,
// types, and src/hook/cache.ts: no zod, no SQLite, no config loader, nothing from src/hosts/_framework.
import type { HookInput, HookResponse } from "../../../../src/core/contracts.js";
import { hookDispatchHome, readHookCache, trustedRepoFor } from "../../../../src/hook/cache.js";
import type { HookHandlers } from "../../../../src/hook/run.js";

const SILENT: HookResponse = { exitCode: 0 };

export const hookHandlers: HookHandlers = {
  /** Injects the active policy as context. Any problem means "say nothing" (UC9). */
  async SessionStart(input: HookInput): Promise<HookResponse> {
    const dispatchHome = hookDispatchHome(process.env);
    if (!dispatchHome) return SILENT;
    const cache = readHookCache(dispatchHome); // null when missing, unreadable or not version 1
    if (!cache) return SILENT;
    const repoNote = trustedRepoFor(cache, input.cwd) ? " (repo policy active)" : "";
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `${cache.policy.summary}${repoNote}`,
        },
      }),
      exitCode: 0,
    };
  },
};
