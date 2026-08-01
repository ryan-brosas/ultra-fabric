# ADR-0001: Keep Ultra policy separate from upstream-compatible Fabric fixes

**Status:** Accepted
**Date:** 2026-08-01

## Context

Ultra Fabric begins as a fork of pi-fabric 0.31.1. Upstream is moving quickly, particularly in Prewalk, actors, compaction, and the TUI. Those are also the areas Ultra intends to strengthen. A broad rewrite would make every upstream release expensive to absorb and would hide generally useful correctness fixes inside fork-only architecture.

The fork needs two different kinds of change:

1. correctness, lifecycle, and compatibility fixes that improve pi-fabric itself;
2. Ultra-specific control policy: continuous phase execution, supervision, durable workflows, adaptive routing, context QoS, and outcome learning.

Treating both kinds alike either constrains Ultra to upstream's product boundary or creates permanent merge conflict debt.

## Decision

Use a two-lane fork boundary.

### Lane A: upstream-shaped fixes

A change belongs in Lane A when it corrects existing documented behavior without requiring an Ultra policy concept. It:

- changes the smallest existing source/test surface;
- preserves public API compatibility unless the defect requires otherwise;
- includes a focused regression test;
- avoids Ultra branding and new dependencies;
- is suitable to propose upstream as an isolated commit.

Examples include lost delivery diagnostics, stale lifecycle ownership, incorrect cancellation, and malformed boundary state.

### Lane B: Ultra-native capability

A change belongs in Lane B when it introduces a new policy or product behavior. It:

- begins in a new pure module under a narrow namespace or subsystem seam;
- exposes typed contracts before manager/UI integration;
- is opt-in until benchmarked;
- uses adapters into existing Fabric managers instead of rewriting them;
- adds no dashboard surface until the backend contract and tests stabilize.

Examples include the Prewalk v2 reducer, actor supervision policy, durable workflow state, admission routing, budget reservations, and the outcome ledger.

### Commit and merge discipline

- Keep Lane A and Lane B work in separate commits.
- Rebase or merge upstream before beginning a new delivery slice.
- Resolve core source conflicts independently from expected fork identity conflicts in `README.md` and `package.json`.
- Never mix an upstream version refresh with feature behavior in one commit.
- Retain the upstream MIT license and attribution.

## Consequences

### Positive

- General bug fixes remain upstreamable and easier to review.
- Ultra can develop stronger policy without waiting for upstream acceptance.
- Upstream refresh cost is measurable by seam.
- New behavior can be feature-gated and removed without destabilizing the base runtime.
- The existing test suite remains a compatibility oracle.

### Negative

- Some features require adapters that look temporarily repetitive.
- Branding files will conflict predictably on upstream refreshes.
- A behavior may begin as an Ultra adapter before a cleaner upstream hook exists.
- Maintainers must classify changes before implementation and preserve commit boundaries.

## Alternatives considered

### Rewrite pi-fabric around a new kernel

Rejected. It maximizes initial freedom but discards a mature 48k-line runtime and 100+ test files, while creating an unreviewable migration and permanent ecosystem split.

### Keep all changes as upstream pull requests

Rejected. Continuous Prewalk, adaptive routing, and outcome learning are product decisions rather than narrow fixes and may not match upstream's scope or timing.

### Build a companion extension only

Rejected as the sole architecture. A companion can observe Pi lifecycle events but cannot safely own Fabric's inner execution audits, actor queue persistence, budget reservation, or boundary handoff state. Companion packages may still be useful for optional UI or external integrations.

### Copy inspiration plugins wholesale

Rejected. Their lifecycle ownership, persistence, dependencies, and event contracts differ. Ultra adapts only source-qualified invariants into Fabric-native typed seams.
