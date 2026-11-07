/**
 * Registries that host integrations plug into: the hosts `setup` installs, and the `doctor` checks
 * (WP26 runs them). Hosts register at import time from `src/hosts/index.ts`.
 */
import type { HostIntegration } from "../../core/contracts.js";

/** Severity of a doctor check result. */
export type DoctorStatus = "ok" | "warn" | "fail";

/** What a doctor check reports; `fix` is a command or instruction the user can follow. */
export interface DoctorResult {
  status: DoctorStatus;
  message: string;
  fix?: string;
}

/** Facts a doctor check may use. Checks must not spend quota or write host files. */
export interface DoctorContext {
  home: string;
  dispatchHome: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** A named doctor check. `id` is stable, e.g. "setup.manifest" or "codex.hooks-trusted". */
export interface DoctorCheck {
  id: string;
  run(ctx: DoctorContext): Promise<DoctorResult> | DoctorResult;
}

/** A set of registered hosts and doctor checks. */
export class HostRegistry {
  readonly #hosts = new Map<string, HostIntegration>();
  readonly #checks = new Map<string, DoctorCheck>();

  /** Registers a host integration; a second registration with the same id replaces the first. */
  registerHost(integration: HostIntegration): void {
    this.#hosts.set(integration.id, integration);
  }

  /** Registered hosts in registration order. */
  hosts(): HostIntegration[] {
    return [...this.#hosts.values()];
  }

  getHost(id: string): HostIntegration | undefined {
    return this.#hosts.get(id);
  }

  /** Registers a doctor check; ids must be unique. */
  registerDoctorCheck(check: DoctorCheck): void {
    if (this.#checks.has(check.id)) throw new Error(`doctor check ${check.id} already registered`);
    this.#checks.set(check.id, check);
  }

  doctorChecks(): DoctorCheck[] {
    return [...this.#checks.values()];
  }

  /** Runs every check; a throwing check becomes a `fail` result instead of aborting the rest. */
  async runDoctorChecks(ctx: DoctorContext): Promise<(DoctorResult & { id: string })[]> {
    const out: (DoctorResult & { id: string })[] = [];
    for (const check of this.#checks.values()) {
      try {
        out.push({ id: check.id, ...(await check.run(ctx)) });
      } catch (err) {
        out.push({
          id: check.id,
          status: "fail",
          message: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return out;
  }
}

/** The process-wide registry used by the CLI. */
export const registry = new HostRegistry();

/** Registers a host integration in the process-wide {@link registry}. */
export function registerHost(integration: HostIntegration): void {
  registry.registerHost(integration);
}

/** Registers a doctor check in the process-wide {@link registry}. */
export function registerDoctorCheck(check: DoctorCheck): void {
  registry.registerDoctorCheck(check);
}
