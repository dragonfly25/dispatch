/**
 * Built-in defaults (the lowest layer). Profiles, presets and model tables come from the
 * package's `assets/` directory; everything else is here.
 */
import { DEFAULT_EFFORTS, DEFAULT_TIERS } from "../core/contracts.js";
import { type MergedProvider, newProvider, type Settings } from "./merge.js";

export const DEFAULT_TIER_NAMES: readonly string[] = DEFAULT_TIERS;
export const DEFAULT_EFFORT_NAMES: readonly string[] = DEFAULT_EFFORTS;
export const DEFAULT_PROFILE = "balance";
export const DEFAULT_PRESET = "mirror";
export const DEFAULT_UNSPECIFIED_MODEL = "balanced";
/** Default retention of finished runs and history (`retention_days`). */
export const DEFAULT_RETENTION_DAYS = 30;

const antigravity: MergedProvider = {
  ...newProvider("antigravity"),
  // Experimental, opt-in and read-only (plan "Your decisions"); merge.ts enforces the cap.
  enabled: false,
  max_autonomy: "read-only",
};

/** Fresh copy of the default settings. */
export function defaultSettings(): Settings {
  return {
    providers: {
      claude: newProvider("claude"),
      codex: newProvider("codex"),
      antigravity: structuredClone(antigravity),
    },
    autonomy: "worktree",
    allowed_providers: null,
    concurrency: { per_provider: 2, total: 4 },
    max_depth: 1,
    network: "off",
    worktree: { bootstrap: "none", symlink_paths: [], keep: false },
    unspecified_model: DEFAULT_UNSPECIFIED_MODEL,
    pins: [],
    mappings: { preset: DEFAULT_PRESET, direct: [] },
    profile: DEFAULT_PROFILE,
    shadow_profiles: [],
    timeouts: { default_task_ms: 10 * 60 * 1000 },
    quota: { cache_minutes: 5, readers: {} },
    retention_days: DEFAULT_RETENTION_DAYS,
  };
}
