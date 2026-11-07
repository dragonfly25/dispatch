/**
 * Host setup framework (WP17): the only module that writes host files. Host integrations
 * (`src/hosts/claude-code`, `src/hosts/codex`) build {@link EditOp} lists with the helpers here
 * and register themselves with {@link registerHost}.
 */
export { manifestCheck } from "./checks.js";
export {
  type ApplyResult,
  applyOp,
  type CliCommandSpec,
  type CommandResult,
  type CommandRunner,
  type EditDeps,
  parseCliSpec,
  type RevertResult,
  renderTextBlock,
  revertEntry,
} from "./edits.js";
export { type JsonEntrySpec, jsonHash, parseJsonEntrySpec } from "./json-entry.js";
export {
  ABSENT,
  type Manifest,
  type ManifestEntry,
  manifestPath,
  readManifest,
  writeManifest,
} from "./manifest.js";
export {
  type DoctorCheck,
  type DoctorContext,
  type DoctorResult,
  type DoctorStatus,
  HostRegistry,
  registerDoctorCheck,
  registerHost,
  registry,
} from "./registry.js";
export {
  type AssetCopy,
  assetOps,
  dispatchHomeOf,
  hostAssetDir,
  hostPresent,
  renderHostAsset,
  renderTemplate,
  type TemplateValues,
  templateValues,
} from "./render.js";
export {
  type ApplyOptions,
  type ApplySummary,
  applySetup,
  describeOp,
  hostPlanContext,
  launcherOp,
  launcherPath,
  planSetup,
  type SetupContext,
  type SetupPlan,
  type UninstallOptions,
  type UninstallSummary,
  uninstallGlobal,
} from "./setup.js";
