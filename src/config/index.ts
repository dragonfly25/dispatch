/** Public API of the config module (WP4). */
export { DEFAULT_PRESET, DEFAULT_PROFILE, DEFAULT_UNSPECIFIED_MODEL } from "./defaults.js";
export {
  type EffectiveConfig,
  type ExecutionConfig,
  type ExecutionInstance,
  type LoadOptions,
  loadEffectiveConfig,
  parseYaml,
} from "./load.js";
export { AUTONOMY_ORDER, type Issue, type Provenance, type Source } from "./merge.js";
export { dispatchHome, globalConfigPath, repoPaths } from "./paths.js";
export {
  type ConfigFlags,
  ConfigFlagsSchema,
  CURRENT_VERSION,
  GlobalConfigFileSchema,
  MappingFileSchema,
  migrate,
  ProfileFileSchema,
  RepoConfigFileSchema,
} from "./schema.js";
export { checkTrust, findRepo, readPolicySet, type TrustStatus, trustRepo } from "./trust.js";
export { type ValidateInput, type ValidationIssue, validate } from "./validate.js";
