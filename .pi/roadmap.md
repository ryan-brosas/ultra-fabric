---
purpose: Confirmed direction, proposed work, dependencies, and acceptance checks
---

# Roadmap

## Current direction

- Current outcome: build representative operational evidence without weakening the host-owned control boundary.
- Current milestone: Slice 8 benchmark and soak gates.
- Main constraint: Slices 0 through 7 have tested backend contracts, but automatic policy promotion remains disabled until representative real-task evidence exists. Evidence: `docs/ultra-fabric.md`.

## Effort scale

- `S`: one bounded cohort with narrow verification.
- `M`: several coupled files or checks within this repository.
- `L`: cross-area, cross-repository, migration, release, or live-model coordination.

Effort is relative scope, not a time promise.

## Confirmed work

### Produce representative Slice 8 benchmark and soak evidence

- Status: active
- Effort: `L` because the gate needs at least 20 representative tasks, paired arms, exact oracles, provenance, cost controls, and comparative analysis.
- Evidence: `docs/ultra-fabric.md` adoption status and Benchmark section, plus `scripts/benchmark-prewalk-real.mjs` and `scripts/benchmark-prewalk.mjs`.
- Dependencies: tested Slices 0 through 7, an operator-attested representative manifest, model authentication, an approved cost boundary, and deterministic repository oracles.
- Acceptance:
  - At least 20 representative tasks have complete paired upstream and Ultra evidence.
  - Records remain prompt-free and include provenance, protocol evidence, exact-oracle results, tokens, latency, and observed cost.
  - The analyzer reports confidence and rejects incomplete or unsupported claims.
  - Automatic policy promotion remains off unless measured benefit clears the documented gate.
- Risks: stochastic model behavior, benchmark contamination, provider drift, cost, and a non-representative corpus.
- Live confirmation: required for provider authentication, real-model execution, cost stopping, and soak behavior.

### Preserve upstream mergeability while Ultra evolves

- Status: ongoing
- Effort: `M` because each change must be classified, tested, and kept within a fork lane.
- Evidence: `docs/adr/0001-fork-boundary.md` and `AGENTS.md`.
- Dependencies: current upstream source under `sources/` when a refresh or precedent comparison is needed.
- Acceptance:
  - Upstream-shaped fixes remain minimal, compatible, and independently testable.
  - Ultra-native behavior uses typed seams and stays opt-in until measured.
  - Upstream refreshes do not mix with behavior changes.
  - `pnpm run check` passes after each coherent slice.
- Risks: predictable branding conflicts and policy changes leaking into upstream-shaped fixes.
- Live confirmation: none unless publication or an upstream proposal is requested.

## Proposed work

### Promote outcome-ranked routing or policy automatically

- Why it may matter: measured recommendations could improve route quality while reducing unnecessary delegation.
- Effort: `L` because promotion changes host behavior and requires representative benchmark plus soak evidence.
- Decision needed: approve only after Slice 8 clears documented quality, cost, reliability, and delegation-rate gates.
- Dependencies: representative outcomes with confidence bounds and an explicit rollback policy.
- Acceptance if approved: promotion is bounded, observable, reversible, and measurably better than the fixed baseline.

## Blockers and risks

- The bundled 20-task contract corpus is a qualification aid and defaults to non-representative. Independently sampled work remains required.
- Real comparative collection requires explicit authority for provider use and cost.
- The recorded DeepSWE comparison covers one task with three attempts per arm. It cannot establish broad superiority.

## Completed outcomes

- Slices 0 through 7 have tested backend contracts for Prewalk continuity, persistent Agent reliability, run context and reservations, durable workflows, Context QoS, routing and admission, and outcome/UI surfaces.
  Source: `docs/ultra-fabric.md` adoption status.
- Ultra Consult has a typed, bounded, zero-agent-by-default context delegation contract. Source: `docs/ultra-fabric.md` and `src/consult/`.
- Host-owned language-aware quality gates have distinct audit and enforce outcomes. Source: `docs/quality.md`, `src/quality/`, and `tests/quality-*.test.ts`.
- A one-task DeepSWE smoke comparison and reproduction notes are recorded in `README.md` and `bench/README.md`. It is supporting evidence, not the Slice 8 gate.

## Deferred or out of scope

- Prompt-only safety, ambient autonomous swarms, silent policy rewriting, and UI-first kernel development remain out of scope.
