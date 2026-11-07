/** Doctor checks owned by the setup framework itself. */
import { readTextOrNull, sha256 } from "./fsutil.js";
import { readManifest } from "./manifest.js";
import type { DoctorCheck } from "./registry.js";

/**
 * `setup.manifest`: setup ran and the files it created are still intact. A missing or edited file
 * is a warning with `dispatch setup --refresh` as the fix.
 */
export const manifestCheck: DoctorCheck = {
  id: "setup.manifest",
  run(ctx) {
    const manifest = readManifest(ctx.dispatchHome);
    if (manifest.entries.length === 0) {
      return { status: "warn", message: "setup has not run", fix: "dispatch setup" };
    }
    const broken = manifest.entries
      .filter((e) => e.kind === "new-file" || e.kind === "rules-file")
      .filter((e) => sha256(readTextOrNull(e.file) ?? "") !== e.sha256)
      .map((e) => e.file);
    if (broken.length > 0) {
      return {
        status: "warn",
        message: `missing or edited since setup: ${broken.join(", ")}`,
        fix: "dispatch setup --refresh",
      };
    }
    return { status: "ok", message: `${manifest.entries.length} setup edits recorded` };
  },
};
