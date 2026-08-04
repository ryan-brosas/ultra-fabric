# Ultra Fabric Architecture

**Status:** Active adoption
**Baseline:** pi-fabric 0.31.1 (`1f4fa7c`)
**Target host:** Pi 0.83.x, Node.js 24+
**Date:** 2026-08-01

## Adoption status

Slices 0-7 now have tested backend contracts. Prewalk v2 owns typed continuity, configurable effect triggers, identity-checked continuation, bounded execute → verify → revise, with a host-accepted 5–9 item checklist, checklist-triggered runtime stop, planning-message pruning, and same-session executor ownership that hands Main back its own model on settle. Persistent Agents own durable inbox/outbox replay, retry/dead-letter/circuit behavior, quotas, telemetry, root traces, and outcomes. Fabric propagates run identity, gates, reservations, durable phase leases, cooperative path leases, deterministic Context QoS, capability/auth routing, explicit delegation intent, capability profiles, and a prompt-free outcome ledger with confidence-bounded recommendations. Automatic policy promotion remains disabled until the Slice 8 benchmark and soak gates are run on representative real tasks. Prewalk protocol compatibility does not inherit external cost, quality, or success-rate claims. The offline `benchmark:prewalk` analyzer now enforces strict prompt-free records, paired in-place/research coverage across at least 20 operator-attested representative tasks, provenance, protocol evidence, and confidence reporting. The opt-in `benchmark:prewalk:real` collector adds isolated paired Pi RPC runs, exact filesystem/test oracles, prompt-free probe telemetry, a non-billable evaluator seam, and an observed USD stop. A bundled 20-task source-mapped contract corpus is offline RED/GREEN qualified and defaults to non-representative; independently sampled historical work and empirical results remain Slice 8 gates. The quality increment adds opt-in host-owned changed-file gates with broad language detection, trusted shell-free checks, explicit coverage failure, and distinct failed, timed-out, and crashed outcomes.

## Thesis

Ultra Fabric closes the control loop around Fabric's existing runtime.

Pi Fabric already has the difficult primitives: a typed code-mode boundary, capability discovery, approvals, isolated execution, agents, persistent agents, mesh coordination, state, deterministic compaction, audit traces, and a strong TUI. Its remaining limitations are not a shortage of primitives. They are breaks between sensing, deciding, acting, verifying, recovering, and learning.

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

The wheel is powerful because every spoke returns to the kernel. No model, persistent Agent, workflow, or retry loop gets unbounded authority.

## Product contract

The user states an outcome once. Main retains intent and final authority. Ultra Fabric may route, delegate, supervise, retry, compact, or verify only within explicit host-owned limits. It reports partial work and uncertainty instead of converting infrastructure failure into success.

The default remains zero agents. Power is available, not ambient.

## What the source audit found

The audit covered current source, tests, and configuration. The broad CodeGraphContext index located the same prewalk and persistent Agent seams in the nearby upstream clone but was stale for this checkout and under-reported callers, so every structural claim below was confirmed in current source and tests.

### Existing strengths to preserve

- `fabric_exec` is one flat, type-checked model boundary over a capability registry.
- QuickJS is the default isolation boundary; the Node executor is explicitly unsafe.
- Approval, audit, timeout, cancellation, output bounding, and activity reporting share one action path.
- Agent execution already has concurrency, depth, per-execution calls, token ceilings, worktrees, transports, and a cross-process cost ledger.
- Persistent Agents already have serial execution, fixed capability sets, persistent model sessions, event/topic subscriptions, ownership leases, coalescing, freshness predicates, four delivery modes, and bounded queues.
- Mesh has append-only topics, compare-and-swap state, participant leases, and owner-addressed at-most-once control.
- Deterministic compaction normalizes typed Fabric traces instead of trusting prose.
- The dashboard and topology surfaces already expose most runtime entities.

### Verified control-loop breaks

| Area | Current source behavior | Consequence |
|---|---|---|
| Prewalk lifecycle | The typed reducer owns blocked/retry, bounded fallback, checklist readiness, one-mutation reservation, identity-checked continuation settlement, delayed re-arm, opt-in evidence-gated execute → verify → revise cycles, and configurable effect/risk/ref triggers. | Legacy prompt-only verification and completed-call handoff modes remain compatibility paths until comparative evaluation is complete. |
| Prewalk trigger | Prewalk rejects matching mutation authorization before checklist readiness, reserves one matching call, and stops QuickJS or Node execution at the accepted checklist boundary. Failed attempts release the reservation. Defaults preserve `pi.edit`, `pi.write`, `schema.commit`, and declared workspace effects. | Bash remains intentionally opaque unless explicitly named in `triggerRefs`. Unknown shell effects cannot satisfy the prewalk claim. |
| Model ownership | Prewalk switches the same Main session at the accepted checklist, keeps the executor through implementation and verification, and restores Main to its original model on settle. | Automatic nested planner/executor stacks remain out of scope. |
| Continuity | Hidden messages carry handoff identity. Prewalk planning uses a distinct phase-owned message removed from model context when the executor continuation is accepted. The accepted checklist is carried forward. Gated mode requires passing evidence and bounds revision. | Legacy prompt-only verification remains the compatibility default until gated mode is measured. |
| Persistent Agent durability | A per-persistent Agent atomic `inbox.json` stores accepted queued and in-flight activations by stable ID before acknowledgement; interrupted in-flight work reloads at the head for at-least-once replay. | Media bytes remain transient and replay depends on stable-ID effect deduplication. |
| Persistent Agent recovery | Zero-effect startup failures can retry one-for-one with bounded backoff; outbox delivery has independent retry, explicit stable-ID replay, dead letters, and a persisted closed/open/half-open Main-delivery circuit. | Runs with any turns, tool calls, or token usage remain terminal by design; richer effect evidence is required before safe resume. |
| Persistent Agent delivery | Every completed output records independent mesh and Main receipts with attempts, timestamps, errors, dead-letter/circuit states; persistent Agent mesh events deduplicate by the outbox message ID. | Cross-provider Main delivery relies on the stable message ID contract for idempotent adapters. |
| Backpressure | Queue overflow follows configured reject, source-coalesce, drop-oldest, or dead-letter policy; displaced activations receive explicit terminal records and aggregate queue/dead-letter telemetry. | Per-persistent Agent overflow-policy overrides remain out of scope. |
| Workflow durability | `workflow.durable` stores validated phase graphs over mesh CAS with owner leases, idempotent create, expired-lease resume, bounded retry, cancellation, partial failure, evidence refs, and output digests. `durable.run` adapts guest closures without persisting code or raw results. | Replayed phases must recover actual data through artifacts/state because durable storage intentionally retains only output digests. |
| Spend enforcement | Per-execution agent calls and finite tokens reserve atomically before provider invocation; blocking calls release unused tokens and detached calls commit their full bound. Cost is still appended from observed usage. | Agent/token over-admission is closed; cost can still overshoot because no trustworthy hard pre-run estimate exists. |
| Budget scope | Persistent Agents accept durable per-persistent Agent lifetime/window activation quotas; every enqueue path shares the same admission counter and observed token ledger, and aggregate exhaustion is queryable. | Token totals remain observed telemetry rather than a hard lifetime ceiling because no safe per-activation estimate exists for ambient work. |
| Admission | Host policy can require a typed delegation reason plus expected artifact. Named capability profiles compile to fixed child tools and recursive risk grants; outcomes retain reason counts. | Semantic value remains recommendation-only rather than a host guess. |
| Routing | Pi agent and trajectory requests can declare modality, reasoning, context, output, and cost requirements plus an ordered fallback set. The host checks registry availability/auth before launch, allows capability-preserving fallbacks automatically, gates quality downgrade by host policy, and persists a typed route artifact. | Outcome-ranked routes remain recommendations; Fabric never silently rewrites configured defaults. |
| Context QoS | Every model request gets a deterministic pre-threshold pass that retires only large, old, superseded read/grep/find/ls bodies while preserving message count, call/result pairing, recent turns, errors, mutations, and typed Fabric evidence. Cumulative omission counters are host-visible. | Semantic compression and model-authored summaries remain outside this pass. |
| Evaluation | Terminal Fabric and ambient persistent Agent runs persist prompt-free duration/token/cost/verification/route records. The offline Prewalk analyzer rejects raw fields and requires complete paired evidence. The opt-in real collector isolates every arm, invokes Pi through public RPC, runs exact literal-argv oracles, records prompt-free protocol telemetry and provenance, and stops before the next arm at its observed USD boundary. | The bundled 20-task contract corpus and structural evaluator are qualification aids; independently sampled historical work, semantic rubric review, and an actual comparative run remain rollout gates. |
| Trace correlation | One run/trace/span envelope crosses providers, recursive children, direct and ambient persistent Agent activations; durable phase leases retain owner run/trace/span; final details persist bounded evidence, gates, transitions, and reservations. | External systems still need to propagate the public envelope explicitly. |
| Shared writes | `leases.acquire/release/list` atomically owns file/tree paths per run; active foreign leases reject `pi.edit`/`pi.write` before mutation. Worktrees remain available for stronger isolation. | Shell commands are opaque and must use worktrees or explicit coordination. |
| Quality enforcement | Successful `pi.write`, `pi.edit`, and committed `schema.commit` paths are language-classified and routed to trusted bounded checks. Audit warns; enforce aborts on failed checks or uncovered languages. | Shell, direct orchestration-only, child-agent, and foreign-process writes remain outside exact attribution. Subjective cleanliness requires concrete project rules. |
| Policy extensibility | Bounded configuration now controls triggers, admission, profiles, routing downgrade, retry, gates, quotas, and Context QoS; providers contribute declared risk/capability facts. | Arbitrary third-party policy callbacks remain deferred until the stable config contracts are measured. |

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

Normalize host events, tool outcomes, persistent Agent mail, workflow transitions, context pressure, and provider health into bounded signals. Signals contain source identity, sequence, freshness, and evidence addresses. Raw prompts and unrestricted tool bodies are not copied into durable telemetry.

Initial signals:

- task accepted / revised / cancelled;
- successful action with resolved risk and effect class;
- verification observed with command, exit status, and result address;
- persistent Agent failure / overload / dead letter;
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

Execution keeps Fabric's existing action registry, QuickJS boundary, agent runners, persistent Agents, and transports. Ultra adds two host-owned controls:

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

Prewalk is a task-scoped transition machine:

```text
idle
  → armed
  → armed + accepted checklist (research)
  → mutation_in_flight (research)
  → handing_off
  → continuation_pending | verification_pending
  → continuing | verifying
  → idle | armed | blocked
```

Current contracts:

- research mode requires a host-validated 5–9 item checklist with one concrete validation per item before a matching mutation can authorize;
- one matching mutation reservation closes parallel races; a failed attempt releases it, while the first successful audit owns the boundary;
- an internal cancellation signal stops QuickJS and Node execution at that boundary, and the result records the exact audit rather than treating the owned stop as failure;
- the research planning message is removed from context before executor inference, while the accepted checklist is included in the identity-owned continuation;
- prewalk keeps the executor model through completion and verification by default, and an explicit previous return policy hands Main back its own model on settle;
- model unavailability or authentication failure blocks with preserved task intent instead of retrying indefinitely;
- verification failure returns scoped evidence to execution within a configured revision cap and never restarts the whole task automatically;
- hidden continuations carry lifecycle identity and stale messages are rejected.

### Persistent-Agent supervision

The persistent Agent runtime owns durable execution mechanics: serial activation, accepted-before-acknowledge inboxes, independent delivery receipts, bounded zero-effect retry, overflow policy, circuit breaking, quotas, and ownership transfer. A role profile owns behavior, subscriptions, delivery defaults, tools, goal, completion contract, and turn budget.

The built-in `supervisor` profile is the first-class goal watcher. It runs only on settled/error events, returns schema-validated directives, gives completion precedence over drift, actively steers Main only when useful, coalesces repeated triggers, suppresses directives made stale by a newer event or Main revision, and has a four-turn activation limit plus one wrap-up turn. `fabric-supervisor` is only an idempotent setup skill around `agents.create({ role: "supervisor" })`; no separate supervisor manager or extension exists.

The durable inbox stores accepted activations before acknowledgement. The outbox tracks mailbox-recorded, mesh-published, Main-delivered, and dead-lettered states independently. Ownership transfer can resume an accepted activation by ID without duplicating a delivered side effect.

Supervision remains one-for-one. Nested supervision trees are deferred until one-for-one recovery is measured and stable.

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

Fabric's deterministic portable summary remains the cross-model recovery view. Ultra owns model-aware routing and adds a pre-compaction QoS pass based on typed messages and traces:

1. protect the current user-turn window;
2. protect unresolved errors, active plans, accepted decisions, file changes, and verification evidence;
3. deduplicate superseded successful tool outputs by semantic operation identity;
4. replace retired bodies with typed addresses and omission counters;
5. preserve assistant tool-call/result structural pairing;
6. run compaction QA after every transform.

The deterministic cut and portable summary do not ask an LLM what source bytes are safe to delete. Official OpenAI Responses models may also persist and replay an opaque provider-native artifact, while exact Claude bridge models use the bridge takeover. The session log and typed source addresses remain the recovery path.

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
| P0 | Persistent Agent delivery receipts | failed Main/mesh delivery is visible and retryable |
| P0 | Durable persistent Agent inbox | accepted queued message survives manager restart |
| P0 | Persistent Agent retry/backoff/circuit breaker | controlled transient success and permanent dead letter |
| P1 | Configurable persistent Agent overflow policy | queue limit exercises reject/coalesce/drop/dead-letter deterministically |
| P1 | Per-persistent Agent lifetime/window budgets | subscribed persistent Agent stops admission at quota |
| P1 | Atomic run budget reservations | concurrent launches cannot oversubscribe a hard reservable budget |
| P1 | Durable phase/DAG runner over mesh CAS | interrupted run resumes only ready unfinished phases |
| P1 | Evidence gate chain | advise/revise/abort and gate crash semantics are executable |
| P1 | Effect/path leases for shared writers | conflicting writer is rejected or isolated before mutation |
| P1 | Capability profiles | profile compiles to stable tools and risk grants |
| P2 | Context QoS with turn/evidence protection | stale duplicate output retires while recent evidence remains exact |
| P2 | Deterministic admission envelope | zero-agent default and explicit partial coverage |
| P2 | Capability-aware model router and fallback chain | ineligible model is never selected; fallback is audited |
| P2 | End-to-end trace/span envelope | one trace correlates provider, tool, agent, persistent Agent, gate, and workflow costs |
| P3 | Outcome ledger and benchmark-driven recommendations | route report compares quality, cost, and latency with confidence bounds |

## Delivery slices

Current adoption on `prewalk-continuity`: Slices 0-7, the research-compatible Prewalk increment, and the Ultra Consult context-delegation increment are implemented and tested. The Prewalk increment adds checklist-gated first-mutation ownership, runtime preemption, planning-context pruning, and same-session executor completion without changing compatibility defaults. Its offline analyzer gates bounded paired evidence, and its opt-in real collector now owns trusted manifests, deterministic pair order, isolated Pi RPC execution, exact oracles, independent non-billable scoring, provenance, and observed-cost stopping. The bundled contract corpus is offline-qualified but defaults non-representative; independently sampled historical tasks and empirical results remain Slice 8 work. Slice 1 adds configurable effect-aware continuity and gated revision. Slice 2 adds durable persistent Agents, delivery recovery, quotas, overload telemetry, and ambient outcomes. Slice 3 propagates run identity, evidence/gates, and atomic reservations. Slice 4 provides durable phase/DAG execution plus owner spans and cooperative write leases. Slice 5 provides deterministic pre-threshold Context QoS. Slice 6 provides explicit admission, capability profiles, and capability/auth-aware routing. Slice 7 provides live health surfaces, derived outcomes, deterministic/model-judge scoring, and confidence-bounded recommendations. The context increment adds one typed `consult.run` surface with context-aware zero-agent admission, bounded fresh read-only workers, Partition/Challenge/Compare semantics, host-resolved file evidence, explicit partial coverage, and prompt-free outcome metrics. The quality increment adds broad file-language detection, trusted command normalization, contained mutation attribution, serial argv execution, and host-owned audit or enforce gates. Slice 8 remains operational rollout and benchmark evidence, not another backend feature slice.

### Slice 0: establish the fork

- Fork metadata and attribution.
- This architecture and the fork-boundary ADR.
- CI remains identical to upstream.
- A documented upstream refresh command and no dependency changes.

### Slice 1: Prewalk v2 kernel

- Pure reducer in a new module.
- Existing Prewalk behavior represented as compatibility transitions.
- Opt-in research mode with a bounded checklist, atomic mutation reservation, exact successful-audit boundary, and executor-only completion.
- Blocked/retry/fallback, planning-message pruning, and legacy return policy behind typed config.
- RED/GREEN transition, runtime-preemption, prompt-isolation, and lifecycle-event tests.

### Slice 2: reliable persistent agents

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

### Context delegation increment: Ultra Consult

- One typed `consult.run` surface instead of exposing a general autonomous swarm.
- Zero-agent default, one attempt per parent execution, at most three workers, and normal atomic agent/token reservations.
- Fresh depth-one Pi workers with fixed read-only tools, discovered extensions off, one host path-scope guard, and no recursion.
- Partition for non-overlapping context, Challenge for one concrete proposal with silence allowed, and Compare only for structural diversity.
- Deterministic reduction: only cached, byte-bounded in-project file/line addresses inside the declared perspective scope survive; complete coverage plus normalized-equal recommendations is the only synthesized consensus.
- Explicit success, partial, inconclusive, failed, cancelled, timed-out, budget-exhausted, and not-admitted outcomes.
- Run transitions and persisted outcomes retain only bounded counts, context ratio, tokens, and cost; prompts and worker prose remain ephemeral.

This increment closes the context-capacity and fresh-subagent gap identified after Slices 0-7. It does not prove that delegation improves outcomes. Automatic policy expansion remains blocked on the Slice 8 benchmark.

## Acceptance criteria

### Continuity

- A task never disappears because model selection, child startup, continuation delivery, or verification failed.
- Permanent authentication/configuration failure does not retry automatically.
- A stale continuation cannot act on a newer task.
- A continuous run has an explicit maximum number of model/phase cycles.

### Persistent-agent reliability

- An acknowledged inbox item survives process restart and ownership transfer.
- Every output ends as mailbox-only, mesh-published, Main-delivered, stale, rejected, or dead-lettered.
- Transient failure follows deterministic backoff; permanent failure opens the circuit.
- Queue overload follows configured policy without silent loss.

### Workflow and budget

- Restart resumes unfinished ready phases without rerunning completed effects.
- Partial failure reports missing coverage.
- Hard agent/token reservations cannot be oversubscribed by concurrent admission; cost remains observed until a defensible ceiling exists.
- Cancellation stops new admission, aborts owned work, and settles leases within a bounded grace period.

### Quality enforcement

- A successful attributed source mutation records one host-owned quality gate when quality mode is active.
- Audit mode reports controlled failures without converting the Fabric result to failure.
- Enforce mode blocks failed, timed-out, crashed, missing, and uncovered checks.
- Commands receive literal argv, run without a shell, have bounded output and time, and execute serially.
- Opaque or foreign writes are documented as unverified rather than guessed.

### Context and learning

- Recent turns and unresolved evidence are never retired.
- Tool-call/result structure remains valid after QoS transforms.
- Outcome records exclude raw prompts, credentials, media, and unrestricted result bodies.
- Automatic recommendations demonstrate benefit on a benchmark before becoming defaults.

## Benchmark

Use at least 20 representative repository tasks and compare upstream Fabric with Ultra. `pnpm benchmark:prewalk:corpus -- --output <manifest.json>` materializes the source-mapped contract corpus with a non-representative default, `pnpm benchmark:prewalk:real -- --dry-run <manifest.json>` validates its 40-arm schedule, `pnpm benchmark:prewalk:real -- <manifest.json>` collects opt-in paired evidence, and `pnpm benchmark:prewalk -- <results.json>` applies the rollout gate:

- completed acceptance criteria;
- unsupported claims and missed constraints;
- lost or duplicate persistent Agent deliveries;
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

### Context-engineering precedents

The context increment uses **Adapt** mode: behavior was independently rewritten into Fabric's existing guest bridge, run budget, agent manager, evidence ledger, and outcome store. No source files or expressive prompt text were copied.

- **`pi-vcc`** — reviewed `src/core/build-sections.ts`, `src/hooks/proactive-threshold.ts`, and their tests. Useful invariants were host-observed context pressure, deterministic structured preservation, and a no-op below threshold. Ultra keeps its own Context QoS and uses pressure only as one Consult admission signal; it does not import VCC's transcript compiler or compaction hooks.
- **`pi-subagents`** — reviewed capability-ceiling and fresh/fork context source plus unit/integration tests. Useful invariants were fresh context as an explicit mode, intersected capability ceilings, and controlled failure before launch. Ultra reuses its existing `AgentManager` rather than the upstream registry/protocol/TUI, fixes Consult children to a read-only allowlist, and deliberately excludes forked context.
- **`pi-distill`** — reviewed output-intent, compression-fallback source, and summary pipeline tests. Its arbitrary model-generated tool-output distillation was not adopted: it targets Pi 0.80, adds package dependencies, and can replace a large source body with unverifiable prose. Ultra instead returns deterministic structured findings whose evidence resolves against the checkout.

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

### Quality-gate precedents

The quality increment uses Adapt mode and copies no implementation bytes.

- **MegaLinter** at `3feb08dac95a08084b52ce20dcd45ba559a9d30b` was reviewed through its language descriptors, `linter_factory.py`, `utils.filter_files`, filter tests, and dependency manifest. Ultra adopts descriptor-like language routing and explicit file versus project invocation, but not its container image, dynamic linter installation, or Python runtime.
- **pre-commit** at `242ce8a25657be59f2770b50de41fe0fd508820d` was reviewed through `commands/run.py`, `lang_base.py`, config validation, regression tests, and dependency manifest. Ultra adopts validated file classification, literal argument passing, serial capability, and controlled failure, but not hook environments or repository caching.
- **reviewdog** at `04461841471c037c240d8358e0498e8c2401c07d` was reviewed through diff filtering, parser boundaries, project runners, tests, and `go.mod`. Ultra adopts explicit changed-file ownership while preserving failure detail. Its shell-string command runner is incompatible with Ultra's trusted argv boundary and was rejected.

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
