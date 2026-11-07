# ADR 0001: Frozen core contracts

- Status: accepted
- Date: 2026-11-07
- Work package: WP0

## Context

About fifteen work packages are developed in parallel against the same types: the router, the
runner, the state store, quota, sandbox, adapters and host integrations. If those shared types
drift while packages are in flight, branches stop composing and reviews turn into merge archaeology.

## Decision

1. `src/core/contracts.ts` is the single source of the shared contracts: zod schemas with their
   inferred types (Task, HostContext, ProviderInstance, QuotaWindow, QuotaSnapshot, RuleTrace,
   DecisionInput, Decision, NormalizedEvent, Outcome, AdapterOutcome, RunResult v1, records),
   the `ExitCode` table, and the port interfaces (Clock, Spawner, StateStore, QuotaProvider,
   Sandbox).
2. Once WP0 is merged these contracts are **frozen**. Any change, including an additive one,
   needs a new ADR in `docs/adr/` that states the change, the reason and the packages affected,
   and lands in the same PR as the change.
3. Items marked `@provisional — frozen by WP1` (Adapter, AdapterCapabilities, Invocation,
   ProbeResult, BuildInvocationArgs, AdapterRunContext, HostIntegration, HostPlanContext,
   HookResponse, EditOp) may change until WP1 (live spike) records the real CLI behaviour. WP1
   removes the marker and adds an ADR describing the frozen shape. Adapter and host packages may
   be developed against the provisional versions but merge only after the freeze.
4. `DecisionInput.routing` is an opaque record until WP4 defines `RoutingConfig`; WP4 narrows it
   with its own ADR.
5. The public `RunResult` JSON Schema is snapshotted in
   `test/__snapshots__/run-result.v1.schema.json`. A snapshot diff is a contract change: a
   breaking one requires `schemaVersion: 2`.

## Consequences

- Packages can be built and reviewed independently against a stable surface.
- Contract changes are deliberate and visible in history.
- Some awkwardness in the frozen shapes is accepted rather than fixed ad hoc.
