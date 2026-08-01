# Ultra Fabric Architecture

**Status:** Proposed
**Baseline:** pi-fabric 0.31.1 (`1f4fa7c`)
**Target host:** Pi 0.83.x, Node.js 24+
**Date:** 2026-08-01

## Thesis

Ultra Fabric closes the control loop around Fabric's existing runtime.

Pi Fabric already has the difficult primitives: a typed code-mode boundary, capability discovery, approvals, isolated execution, agents, persistent actors, mesh coordination, state, deterministic compaction, audit traces, and a strong TUI. Its remaining limitations are not a shortage of primitives. They are breaks between sensing, deciding, acting, verifying, recovering, and learning.

Ultra Fabric turns those pieces into one bounded, recoverable system:

```text
                            ┌───────────┐
                    ┌──────▶│  SENSE    │──────┐
                    │       └───────────┘      │
              ┌─────┴─────┐              ┌────▼─────┐
              │   LEARN   │              │  ROUTE   │
              └─────▲─────┘              └────┬─────┘
                    │       ┌───────────┐      │
              ┌─────┴─────┐ │ RUN KERNEL│ ┌────▼─────┐
              │  VERIFY   │◀│ identity  │▶│   PLAN   │
              └─────▲─────┘ │ budgets   │ └────┬─────┘
                    │       │ evidence  │      │
              ┌─────┴─────┐ │ cancel    │ ┌────▼─────┐
              │  RECOVER  │◀│ trace     │▶│ EXECUTE  │
              └───────────┘ └───────────┘ └──────────┘
```

The wheel is powerful because every spoke returns to the kernel. No model, actor, workflow, or retry loop gets unbounded authority.

## Product contract

The user states an outcome once. Main retains intent and final authority. Ultra Fabric may route, delegate, supervise, retry, compact, or verify only within explicit host-owned limits. It reports partial work and uncertainty instead of converting infrastructure failure into success.

The default remains zero agents. Power is available, not ambient.

## What the source audit found

The audit covered current source, tests, and configuration. The broad CodeGraphContext index located the same prewalk and actor seams in the nearby upstream clone but was stale for this checkout and under-reported callers, so every structural claim below was confirmed in current source and tests.

### Existing strengths to preserve

- `fabric_exec` is one flat, type-checked model boundary over a capability registry.
- QuickJS is the default isolation boundary; the Node executor is explicitly unsafe.
- Approval, audit, timeout, cancellation, output bounding, and activity reporting share one action path.
- Agent execution already has concurrency, depth, per-execution calls, token ceilings, worktrees, transports, and a cross-process cost ledger.
- Actors already have serial execution, fixed capability sets, persistent model sessions, event/topic subscriptions, ownership leases, coalescing, freshness predicates, four delivery modes, and bounded queues.
- Mesh has append-only topics, compare-and-swap state, participant leases, and owner-addressed at-most-once control.
- Deterministic compaction normalizes typed Fabric traces instead of trusting prose.
- The dashboard and topology surfaces already expose most runtime entities.

### Verified control-loop breaks

| Area | Current source behavior | Consequence |
|---|---|---|
| Prewalk lifecycle | `PrewalkController.completeTask()` handles no-mutation settlement, explicit handoff precedence, successful continuation, and failed continuation alike. | The controller cannot express retryable failure, fallback, verification, return-to-planner, or blocked state. |
| Prewalk trigger | Mutation detection is a hard-coded set of `pi.edit`, `pi.write`, and `schema.commit`. Audit records omit resolved risk/effect. | Captured extension mutations and MCP writes cannot participate; bash mutations remain opaque. |
| Model ownership | In-place Prewalk selects the executor and intentionally leaves it active. | There is no planner/executor stack or return policy. |
| Continuity | `alwaysRearm` arms the next task, not the remaining phases of the current task. | It is repeated one-shot switching, not a continuous plan → execute → verify loop. |
| Actor durability | Serialized actor records retain definitions and message history, but `queue` is always rebuilt as `[]`; shutdown rejects queued work. | Persistent actors can lose accepted-but-unprocessed inbox items across shutdown or ownership transfer. |
| Actor recovery | Failed runs record `lastError`; no actor restart policy, backoff, circuit breaker, or dead-letter state exists. | Transient and permanent failures are indistinguishable and require manual diagnosis. |
| Actor delivery | Mesh publication failures are ignored and `onDeliver` exceptions are swallowed after the message is recorded. | A result can appear complete while its active delivery was lost. |
| Backpressure | Queue overflow throws at `actorQueueLimit`. | Producers get an exception, but there is no configurable reject/coalesce/drop/dead-letter policy or overload telemetry. |
| Workflow durability | `workflow.parallel` and `workflow.pipeline` live inside one executor invocation. The swarm skill manually builds tasks from mesh CAS. | Long workflows are not natively resumable and every caller reimplements run state. |
| Spend enforcement | Cost is checked before spawn and appended during/after execution with no reservation. | Concurrent launches can each pass the same budget check and overshoot; the docs acknowledge this. |
| Budget scope | Global agent settings bound each activation, but actors have no lifetime/run-window quota. | A subscribed actor can consume indefinitely across activations. |
| Admission | Advanced mechanisms are selected by user-invoked skills or model judgment. | There is no measurable host-owned rule for when delegation adds value. |
| Routing | Models are selected explicitly; no capability requirements, fallback chain, or outcome-based route exists. | Selection cannot adapt to modality, context, cost, latency, or observed quality. |
| Context QoS | Fabric compacts typed history at thresholds and bounds nested results, but does not prioritize or retire stale tool outputs before threshold compaction. | Long sessions carry superseded evidence until a coarse compaction boundary. |
| Evaluation | Certification evaluates compaction, but ordinary agents, actors, routes, and workflows have no outcome ledger. | The runtime cannot learn whether delegation or a model route improved results. |
| Trace correlation | Audit and topology carry nested call IDs and parent entity IDs, but no uniform trace/span envelope crosses every provider, agent, actor, and workflow. | End-to-end replay and latency/cost attribution require subsystem-specific reconstruction. |
| Shared writes | Worktrees are optional and shared-workspace writers have no host-owned path lease. | Parallel writers can conflict even when model prompts request path ownership. |
| Policy extensibility | Providers add actions, but admission, routing, retry, gate, and context policies are not first-class extension points. | New control policies require modifying core managers or encoding behavior in prompts. |

## Design principles

1. **Bounded power.** Every loop owns a cycle, time, token, cost, concurrency, and effect ceiling.
2. **Typed transitions.** Lifecycle changes are reducer outputs with explicit reasons, not incidental `finally` behavior.
3. **Evidence before progression.** A phase advances from host-observed evidence, not an agent's completion prose.
4. **Durable intent, ephemeral execution.** Run intent and accepted inbox items survive; process handles do not.
5. **At-least-once work, idempotent effects.** Durable queues may redeliver, so activation and delivery IDs are stable and deduplicated.
6. **Failure is data.** Failed, stale, rejected, timed out, dead-lettered, and budget-exhausted remain distinct terminal states.
7. **Zero-agent default.** Delegation requires independence, justification, and a result field capable of changing Main's next action.
8. **No prompt-only safety.** Prompts explain policy; the host enforces authority, budgets, and transitions.
9. **No UI-first development.** Kernel behavior and replay evidence land before dashboard controls.
10. **Upstream remains mergeable.** General fixes stay small and upstream-shaped; Ultra capability lives behind new seams.

## The run kernel

Every advanced operation receives one `UltraRunContext` owned by the host:

```ts
interface UltraRunContext {
  runId: string;
  traceId: string;
  parentRunId?: string;
  objectiveDigest: string;
  deadline: number;
  signal: AbortSignal;
  capabilities: ReadonlySet<string>;
  budget: {
    agents: number;
    tokens: number;
    costUsd: number;
    reservations: readonly BudgetReservation[];
  };
  evidence: EvidenceLedger;
  transitions: TransitionLedger;
}
```

It is created once, propagated through child and provider boundaries, and settled exactly once. Providers do not bypass it. The existing invocation context, audit recorder, activity store, cost ledger, and participant identity become adapters into this kernel rather than parallel control systems.

## Spoke 1: Sense

Normalize host events, tool outcomes, actor mail, workflow transitions, context pressure, and provider health into bounded signals. Signals contain source identity, sequence, freshness, and evidence addresses. Raw prompts and unrestricted tool bodies are not copied into durable telemetry.

Initial signals:

- task accepted / revised / cancelled;
- successful action with resolved risk and effect class;
- verification observed with command, exit status, and result address;
- actor failure / overload / dead letter;
- context occupancy and protected-evidence footprint;
- model availability, rate limit, latency, and cost settlement.

## Spoke 2: Route

A deterministic router filters candidates by hard requirements before ranking:

1. runner compatibility;
2. model availability and authentication;
3. required modality and context window;
4. required tool/capability profile;
5. remaining run budget;
6. policy allowlist/denylist;
7. measured route score.

The route result is typed and includes fallbacks. Model-authored preferences may rank eligible candidates but cannot make an ineligible route valid.

## Spoke 3: Plan

Plans are small phase graphs, not unconstrained generated workflow programs. A plan declares phases, dependencies, acceptance evidence, allowed effects, and limits. Dynamic TypeScript remains available inside each phase.

The durable workflow store lives over mesh CAS and records:

- queued, ready, running, verifying, revising, completed, failed, cancelled;
- owner lease and attempt;
- dependency versions;
- evidence references;
- output digest, never an unbounded transcript;
- next admissible transition.

A restarted host resumes ready work from state rather than rerunning the workflow from the beginning.

## Spoke 4: Execute

Execution keeps Fabric's existing action registry, QuickJS boundary, agent runners, actors, and transports. Ultra adds two host-owned controls:

- **effect leases:** optional path/resource ownership for concurrent writers;
- **capability profiles:** named, versioned grants such as `inspect`, `verify`, `local-write`, and `network-read`, compiled to tools plus approval risk limits.

Worktrees remain the isolation mechanism for genuinely parallel writers. A lease is coordination, not filesystem isolation.

## Spoke 5: Verify

Verification is an ordered gate chain. Each gate returns:

```ts
type GateResult = {
  gate: string;
  passed: boolean;
  evidence: readonly EvidenceRef[];
  disposition: "advise" | "revise" | "abort";
  reason?: string;
};
```

- `advise`: retain finding and continue;
- `revise`: return to the owning phase with bounded feedback;
- `abort`: stop downstream effects.

A crashed gate becomes an explicit infrastructure failure. It does **not** silently pass and does not automatically revise. Revision counts are bounded per phase and per run.

## Spoke 6: Recover

### Prewalk v2

Prewalk becomes a task-scoped transition machine:

```text
idle
  → armed
  → planning
  → handoff_pending
  → executing
  → verifying
  → completed

handoff_pending | executing | verifying
  → retry_wait → fallback | prior phase
  → blocked
  → cancelled
```

Key changes:

- snapshot the planner model, executor route, thinking level, and task identity;
- separate `finishSuccess`, `finishFailure`, `cancel`, and `settleWithoutMutation` transitions;
- preserve the current task across retryable failure;
- classify model unavailable/auth failure as blocked until route/config changes, not an infinite retry;
- support `returnPolicy: "planner" | "executor" | "previous"`;
- use successful audited effect classes plus configurable exact refs for transition triggers;
- cap `maxCycles`, `maxFallbacks`, and phase revisions;
- verification failure returns a scoped revision to execution; it never restarts the whole task automatically;
- every hidden continuation carries run/phase identity and is rejected when stale.

### Actor supervision

Actors gain a host-owned supervision policy:

```ts
interface ActorSupervisionPolicy {
  strategy: "stop" | "restart" | "resume";
  maxAttempts: number;
  windowMs: number;
  backoff: { baseMs: number; maxMs: number; jitter: number };
  overflow: "reject" | "coalesce" | "drop-oldest" | "dead-letter";
  circuit: { failures: number; resetAfterMs: number };
}
```

The durable inbox stores accepted activations before acknowledgement. The outbox tracks mailbox-recorded, mesh-published, Main-delivered, and dead-lettered states independently. Ownership transfer can resume an accepted activation by ID without duplicating a delivered side effect.

The first supervision release is one-for-one. Supervision trees are deferred until one-for-one recovery is measured and stable.

## Spoke 7: Learn

The outcome ledger records bounded operational facts:

- route and resolved model identity;
- task feature bucket, not raw task text;
- coverage and gate outcomes;
- unique evidence contributed by children;
- latency, tokens, cost, retries, dead letters;
- whether Main accepted, rejected, or changed action from a child result;
- later verification outcome when available.

Routing may consume statistically meaningful aggregates. One success does not promote a policy. Learning changes recommendations first; automatic policy changes require explicit confidence and rollback bounds.

## Spoke 8: Govern

### Budget reservation

Replace check-then-spend with reserve → settle → release:

1. estimate a conservative upper bound;
2. atomically reserve against the run ledger;
3. launch only after reservation succeeds;
4. settle actual use and release the remainder;
5. expire abandoned reservations by owner lease.

Provider cost remains telemetry when no defensible upper bound exists. It is never presented as a hard ceiling.

### Trust and authority

- Project policy is read only after `ctx.isProjectTrusted()`.
- Persistent prompts, mail, traces, and evidence references are size bounded and secret scanned.
- Child authority never exceeds the parent's grant.
- Retry does not widen capability.
- Route fallback cannot cross a provider/account boundary excluded by policy.
- Automatic admission never authorizes publication, deployment, destructive Git, or remote mutation.

## Context QoS

Fabric's deterministic compaction remains authoritative. Ultra adds a pre-compaction QoS pass based on typed messages and traces:

1. protect the current user-turn window;
2. protect unresolved errors, active plans, accepted decisions, file changes, and verification evidence;
3. deduplicate superseded successful tool outputs by semantic operation identity;
4. replace retired bodies with typed addresses and omission counters;
5. preserve assistant tool-call/result structural pairing;
6. run compaction QA after every transform.

No LLM decides what bytes are safe to delete. Optional model summaries may add a view, but typed source addresses remain the recovery path.

## Admission policy

Advanced execution is admitted only when all three fields are present:

- **independence:** the delegated question does not depend on Main's hidden in-flight reasoning;
- **justification:** delegation provides context capacity, capability, structural diversity, or independent verification;
- **consumability:** a named result field could change Main's next action.

Host limits validate shape and budget. Semantic judgment initially remains advisory and is measured. A task being difficult is not sufficient justification.

## Twenty prioritized improvements

| Priority | Improvement | First proof |
|---|---|---|
| P0 | Fork identity and upstream-sync boundary | clean upstream rebase plus fork metadata tests |
| P0 | Prewalk typed lifecycle reducer | transition table covers every state/event pair |
| P0 | Planner/executor model stack and return policy | planner restored only under configured policy |
| P0 | Explicit Prewalk blocked/retry/fallback outcomes | auth failure blocks without looping; transient failure retries within cap |
| P0 | Stale hidden-continuation guard | old run/phase continuation cannot trigger a new task |
| P0 | Actor delivery receipts | failed Main/mesh delivery is visible and retryable |
| P0 | Durable actor inbox | accepted queued message survives manager restart |
| P0 | Actor retry/backoff/circuit breaker | controlled transient success and permanent dead letter |
| P1 | Configurable actor overflow policy | queue limit exercises reject/coalesce/drop/dead-letter deterministically |
| P1 | Per-actor lifetime/window budgets | subscribed actor stops admission at quota |
| P1 | Atomic run budget reservations | concurrent launches cannot oversubscribe a hard reservable budget |
| P1 | Durable phase/DAG runner over mesh CAS | interrupted run resumes only ready unfinished phases |
| P1 | Evidence gate chain | advise/revise/abort and gate crash semantics are executable |
| P1 | Effect/path leases for shared writers | conflicting writer is rejected or isolated before mutation |
| P1 | Capability profiles | profile compiles to stable tools and risk grants |
| P2 | Context QoS with turn/evidence protection | stale duplicate output retires while recent evidence remains exact |
| P2 | Deterministic admission envelope | zero-agent default and explicit partial coverage |
| P2 | Capability-aware model router and fallback chain | ineligible model is never selected; fallback is audited |
| P2 | End-to-end trace/span envelope | one trace correlates provider, tool, agent, actor, gate, and workflow costs |
| P3 | Outcome ledger and benchmark-driven recommendations | route report compares quality, cost, and latency with confidence bounds |

## Delivery slices

### Slice 0: establish the fork

- Fork metadata and attribution.
- This architecture and the fork-boundary ADR.
- CI remains identical to upstream.
- A documented upstream refresh command and no dependency changes.

### Slice 1: Prewalk v2 kernel

- Pure reducer in a new module.
- Existing Prewalk behavior represented as compatibility transitions.
- Blocked/retry/fallback and return policy behind opt-in config.
- RED/GREEN transition and lifecycle-event tests.

### Slice 2: reliable actors

- Durable inbox/outbox schema and migration.
- Delivery receipts, dead letters, retry/backoff, and circuit breaker.
- Restart/ownership-transfer tests with stable activation IDs.
- No dashboard changes until log/status contracts stabilize.

### Slice 3: run context, gates, and reservations

- One propagated run identity and cancellation owner.
- Ordered evidence gates with bounded revision.
- Atomic token/agent reservations; cost reservation only where defensible.

### Slice 4: durable workflows

- Mesh-backed phase graph and leases.
- Resume, cancel, partial failure, and replay.
- Existing workflow helpers become adapters, not a second engine.

### Slice 5: context QoS

- Protected typed evidence.
- Turn-window and duplicate-operation retirement.
- Compaction QA and degradation benchmarks.

### Slice 6: routing and admission

- Capability requirement filter.
- Audited fallback chains.
- Admission envelope with zero-agent default.

### Slice 7: learning and UI

- Outcome ledger and offline reports.
- Recommendation-only adaptive routing.
- Dashboard controls after kernel contracts are proven.

## Acceptance criteria

### Continuity

- A task never disappears because model selection, child startup, continuation delivery, or verification failed.
- Permanent authentication/configuration failure does not retry automatically.
- A stale continuation cannot act on a newer task.
- A continuous run has an explicit maximum number of model/phase cycles.

### Actor reliability

- An acknowledged inbox item survives process restart and ownership transfer.
- Every output ends as mailbox-only, mesh-published, Main-delivered, stale, rejected, or dead-lettered.
- Transient failure follows deterministic backoff; permanent failure opens the circuit.
- Queue overload follows configured policy without silent loss.

### Workflow and budget

- Restart resumes unfinished ready phases without rerunning completed effects.
- Partial failure reports missing coverage.
- Hard reservable budgets cannot be oversubscribed by concurrent admission.
- Cancellation stops new admission, aborts owned work, and settles leases within a bounded grace period.

### Context and learning

- Recent turns and unresolved evidence are never retired.
- Tool-call/result structure remains valid after QoS transforms.
- Outcome records exclude raw prompts, credentials, media, and unrestricted result bodies.
- Automatic recommendations demonstrate benefit on a benchmark before becoming defaults.

## Benchmark

Use at least 20 representative repository tasks and compare upstream Fabric with Ultra by:

- completed acceptance criteria;
- unsupported claims and missed constraints;
- lost or duplicate actor deliveries;
- recovery success and dead-letter rate;
- context tokens before each model request;
- parent-context tokens;
- wall-clock latency;
- total tokens and USD cost;
- delegation rate on ordinary tasks;
- percentage of child results that changed Main's next action;
- upstream rebase conflict count.

Power without measured outcome improvement is orchestration theater.

## Precedent analysis

The design independently adapts invariants from three locally reviewed MIT projects; it copies no implementation bytes.

### `pi-red-green`

**Reviewed:** `src/state-machine.ts`, `src/state-machine.test.ts`, `src/index.ts`, package metadata.
**Useful invariant:** a pure immutable reducer with explicit transition warnings and exhaustive phase tests.
**Rejected:** global file-backed state, loose tool-result parsing, and broad catch/log behavior. They do not meet Fabric's session ownership or typed trace contracts.

### `armory-fleet`

**Reviewed:** lifecycle runner, gate chain, verification gate, turn budget, gate tests, package dependencies.
**Useful invariant:** ordered gates with `advise | revise | abort`, short-circuiting, evidence, and a bounded revision loop.
**Rejected:** Armory-specific TODO/memory/vision dependencies, prompt-parsed artifacts as authority, and a 1000-turn default. Ultra uses Fabric state, typed traces, and much smaller explicit cycle bounds.

### `pi-dcp`

**Reviewed:** pure pipeline, priority ranking, pruning logic, turn-protection and structural-pairing tests, package metadata.
**Useful invariant:** protect recent turns, rank context by replacement value, preserve errors, and maintain tool-call/result structure.
**Rejected:** direct adoption of its mutable raw-message pipeline. Fabric already owns typed trace normalization and compaction QA, which must remain authoritative.

## Non-goals

- An always-on swarm.
- Unlimited recursive agents.
- Prompt-authored permissions or retry policies.
- Silent automatic deployment, publication, or destructive Git actions.
- Replacing QuickJS isolation.
- Rebuilding the 14k-line dashboard before backend contracts stabilize.
- Copying every inspiration plugin into one extension.
- Diverging from upstream merely to rename internals.

## Fork maintenance

The accepted boundary is recorded in [ADR-0001](adr/0001-fork-boundary.md). General correctness fixes should remain reviewable against upstream and be offered back. Ultra-only work enters through new policy/kernel modules and narrow adapters. Every upstream refresh runs the full check and reports conflicts in core seams separately from branding/documentation conflicts.
