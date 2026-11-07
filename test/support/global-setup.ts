import { assertFakeShimsInstalled } from "./guard.js";

/** Vitest globalSetup: fail the whole run early if the fake CLI shims are missing or not executable. */
export default function setup(): void {
  assertFakeShimsInstalled();
}
