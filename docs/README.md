# Dispatch documentation

## Using Dispatch

- [Configuration reference](configuration.md): every key of the config, profile and mapping files, with
  types, defaults, allowed values, security keys, precedence, trust and the order in which a task is
  routed. Generated from the schemas by `pnpm docs:config`; do not edit it by hand.

## Extending Dispatch

- [Writing an adapter](guides/writing-an-adapter.md): add a provider CLI (or a second account of an
  existing provider): capabilities, probe, invocation, event parsing, outcome classification, quota,
  model table, registration, fixtures and tests.
- [Writing a host integration](guides/writing-a-host-integration.md): make another agent client aware of
  Dispatch: edit operations and their uninstall guarantees, hooks and their latency budget, doctor
  checks, registration and tests.

## Design and decisions

- [Plan](PLAN.md): the approved v0.1 design, test strategy, work packages and the amendments made after
  the live spike. [Spec](spec.md): the functional specification (Italian).
- [Architecture decision records](adr/): [0001 frozen core contracts](adr/0001-frozen-contracts.md),
  [0002 adapter and host-integration contract freeze](adr/0002-wp1-contract-freeze.md).
- [Spikes](spikes/README.md): what the real CLIs do, with the evidence behind the contracts:
  [claude-code](spikes/claude-code.md), [codex](spikes/codex.md), [agy](spikes/agy.md),
  [hosts](spikes/hosts.md), [host prototype](spikes/hosts-prototype.md),
  [contracts proposal](spikes/contracts-proposal.md).
- [Project status](../STATUS.md).
