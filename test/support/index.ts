/** Test kit shared by the CLI-facing work packages: fake CLIs, temp HOME/repo, tree snapshots. */
export * from "./fakes.js";
export {
  assertFakeShimsInstalled,
  assertNoRealCli,
  FAKES_BIN,
  FAKES_DIR,
  resolveOnPath,
} from "./guard.js";
export * from "./snapshot.js";
export * from "./temp.js";
