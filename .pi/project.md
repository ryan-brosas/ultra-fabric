---
purpose: Source-backed project purpose, architecture, ownership, operations, and risks
---

# Project context

## Purpose

Ultra Fabric is an experimental Pi extension that closes the control loop around pi-fabric's typed orchestration runtime.
It keeps Main responsible for task intent while adding bounded routing, execution, verification, recovery, and learning. Evidence: `README.md` and `docs/ultra-fabric.md`.

## Users and success

Primary users are Pi users and extension developers who need one typed control plane for tools, MCP, one-shot and persistent Agents, durable workflows, quality gates, and runtime evidence.

Observable success means task intent survives infrastructure failure, effects remain host-bounded, failure states stay distinct, and the local package gate remains green.
Explicit non-goals include ambient delegation, prompt-only safety, UI-first backend design, and automatic policy promotion before representative benchmark and soak evidence. See `docs/ultra-fabric.md`.

## Boundaries and invariants

- Default guest execution uses a fresh QuickJS context with a JSON-only host bridge. Guest code has no direct process, filesystem, network, or subprocess globals. See `docs/architecture.md` and `src/runtime/quickjs-runtime.ts`.
- The optional Node-process executor is trusted unsafe execution, not a sandbox. Schema enforce mode disables it. See `docs/architecture.md` and `src/runtime/node-process-runtime.ts`.
- Every effect crosses a host action path with schema validation, approvals, audit, timeout, cancellation, and output bounds.
- Main retains final authority and zero agents remains valid. Delegation must stay bounded and explicit.
- Node.js 24+ and Pi 0.83.x are the compatibility baseline. `package.json` pins Pi packages to 0.83.0.
- The fork keeps upstream-shaped correctness fixes separate from Ultra-native policy. See `docs/adr/0001-fork-boundary.md`.
- Generated `dist/` is rebuilt from `src/` and must not be edited directly.

## Architecture

- `src/index.ts:92` exports the `piFabric` extension entry point. It loads configuration, registers `fabric_exec`, discovers packaged skills, installs tool ownership, initializes state, and wires Pi lifecycle events.
- `src/fabric-state.ts` is the composition root for configuration, execution, audit, agents, mesh, schema, state, outcomes, Prewalk, quality, and UI state.
- `src/fabric-exec-tool.ts` and `src/execution-service.ts` own the model-facing typed boundary and host-side execution orchestration.
- `src/runtime/` provides TypeScript checking plus QuickJS and optional Node-process execution.
- `src/core/action-registry.ts` and `src/providers/` expose Pi tools, extensions, MCP, agents, memory, mesh, leases, schema, state, outcomes, and workflows through one registry.
- `src/agents/` owns one-shot and persistent Agent lifecycles, budgets, transports, durable delivery, and role profiles. Packaged profiles live under `agents/`.
- `src/prewalk/`, `src/run/`, `src/leases/`, and `src/mesh/` own continuity, run identity, shared-write reservations, and durable coordination.
- `src/quality/`, `src/context/`, `src/compaction/`, and `src/outcomes/` own evidence gates, deterministic context control, and prompt-free outcome records.
- `src/ui/` and `src/activity/` project runtime state into Pi's widget, dashboard, settings, and transcripts.

The primary flow is `fabric_exec` to the TypeScript checker, then the selected guest runtime, then the host bridge and `ActionRegistry`, then a provider adapter. Only the bounded final result returns to Main.
Advanced paths may add Agent execution, mesh-backed workflow phases, verification gates, recovery, and outcome recording, but each returns through the same host-owned run context.

Configuration authority is the schema in `src/config.ts`. Trusted user or project configuration may live in `~/.pi/agent/fabric.json` or `.pi/fabric.json`. Never copy local values into documentation or logs.

## Agent utilization

Read-only `agents.roles()` returned nine effective built-in profiles with no diagnostics:

- One-shot roles: `scout` (6 turns + 1 grace), `planner` (8 + 1), `explorer` (10 + 1), `reviewer` (10 + 1), and `worker` (30 + 2).
- Persistent roles: `ambient` (4 + 1), `supervisor` (4 + 1), `advisor` (8 + 1), and `coordinator` (12 + 1).
- `worker` is the only built-in profile with `edit` and `write`. `advisor`, `explorer`, and `reviewer` include `bash`; the remaining profiles expose bounded read/search tools.
- `ambient` handles selected `turn_end` and `tool_error` events. `supervisor` handles `agent_settled` and `tool_error` drift signals. Both use directive delivery with coalescing.
- Every profile source is `builtin` under `agents/*.md`. `agents.templates()` returned no reusable templates, and `.pi/agents/` is absent, so no project override or custom profile was found.

Initialization started no Agent. The inventory proves available profiles and role turn budgets, not active Agent use or unreturned global concurrency limits.

## CodeGraphContext links

- The narrowest indexed ancestor is the broad `/home/ryanj/work` index. Its health probe returned 110,777 files, 811,997 functions, 636,630 classes, and 121,480 modules.
- A non-fuzzy `piFabric` query located current `src/index.ts:92` alongside an inspiration copy. Current source confirmed the Ultra hit.
- Relationship probes returned zero callers, importers, and module dependencies for `piFabric`. This is not an absence claim: current `tests/extension-shutdown.test.ts:3,35` imports and invokes it.
- `list_watched_paths` returned no watched paths. No watcher was started for the broad ancestor; use scoped graph results as locators and verify them with current source and tests.

## Source ownership

- Maintained runtime: `src/`
- Packaged Agent profiles and skills: `agents/` and `skills/`
- Tests and fixtures: `tests/`
- Product and operator documentation: `README.md`, `docs/`, `CHANGELOG.md`
- Certification and benchmark tooling: `scripts/` and `bench/`
- Local upstream and benchmark sources: `sources/`
- Generated package output: `dist/`, created by `pnpm run build`
- Runtime-managed state: `.pi/fabric-runs/**`, `.pi/fabric/mesh/**`, and `.pi/hindsight/**`

## Tests and integrations

- Vitest tests run against `src/`. `tests/extension-shutdown.test.ts` exercises the extension entry point; runtime, provider, Agent, workflow, quality, state, memory, and package behavior have focused suites under `tests/`.
- Pi supplies extension registration, lifecycle events, model selection, tools, UI, and session continuation.
- QuickJS is the default guest boundary; the optional Node-process executor is explicitly trusted and unsafe.
- mcporter supplies pooled MCP integration. Agent execution supports Pi and, when configured, Claude CLI plus process and terminal transports.
- Hindsight, Fabric session memory, graph, and MCP inventories are operator context, not product-service health evidence.

## Verification and operations

- Required local gate: `pnpm run check`, then `git diff --check` and `git status --short --branch`.
- CI: `.github/workflows/test.yml` runs Node 24 on Ubuntu and Windows with frozen pnpm install, typecheck, build, tests, and Knip.
- Release: `.github/workflows/release.yml` publishes a public npm prerelease from `v*` tags after tag and package-version agreement.
- Benchmark collection can invoke real models and incur cost. The one-task DeepSWE smoke in `README.md` is not representative proof.
- Observed command exits and warnings are recorded in `.pi/tech-stack.md`; transient worktree status stays in the session receipt.

## Decisions, risks, and questions

- Fork decision: preserve upstream mergeability while building Ultra-native policy behind typed seams. See `docs/adr/0001-fork-boundary.md`.
- Slice 8 still needs independently sampled representative work, comparative results, and soak evidence before automatic promotion.
- Shell and foreign-process writes remain opaque to exact mutation attribution.
- Persistent delivery and replay depend on stable identities and idempotent effect handling.
- The broad graph index has no watcher and cannot prove current call relationships.
- No named live server, feature flag, deployment, rollback procedure, or release authority was confirmed.
