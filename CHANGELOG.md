# Changelog

## Unreleased

- setup: remove the `/fabric init` command. A normal `pi install npm:ultra-fabric@<version>` is user-global and loads in every Pi project without repository setup; `pi install -l` remains the opt-in project-only path. `/fabric status` now reports the global and project configuration paths, and `/fabric settings --global` lets trusted projects edit user-wide defaults explicitly.

## 0.31.1-ultra.21 - 2026-08-08

- prewalk: every non-trivial checklist now requires the Schema contract. `parsePrewalkChecklist` rejects items without one, the guest API declares `schema` as required so the runtime type-checker rejects `prewalk.checklist({ items })` before execution, and the armed prompt demands `prewalk.checklist({ items, schema })` on research and easy paths. The 5-9 research and 2-4 easy item bounds and per-item task/validation checks still fire first, and trivial dispositions remain schema-free. codemap and CGC remain the evidence retrieval sources that answer reference questions; Schema governs progression.

## 0.31.1-ultra.20 - 2026-08-08

- compaction: adopted reference concepts from the MIT-licensed pi-dcp and pi-vcc projects — repeated identical non-error tool results render as stable `(same output as (#N))` references counted in `omittedCounts.duplicates` (failed diagnostics are never deduplicated), and the pi-vcc `filter-noise` bookkeeping tool-pair set is skipped before projection and counted in `omittedCounts.noise`. New summaries also emit `counts.intactPairs` and the 1-based `ordinal`; entries persisted before those fields remain valid.
- prewalk: the accepted checklist projects a Schema contract (intent, reference questions and evidence refs, local scope with files/symbols/cascade refs, invariants, postconditions) through `prewalk.checklist({ items, schema })`; the research arm treats Schema as the progression authority and includes the schema object only when the plan carries external reference questions or multi-file scope.
- prewalk: new `planningEscapes` config (default true) — set false to force the full 5-9 item research protocol; the benchmark research config disables the easy and trivial escapes so research records carry real checklists.
- prewalk: the execution trace projection now records `fabric.prewalk.checklist` item counts and easy/trivial dispositions (never plan text), and the benchmark probe boundary matches the real flow where the frontier fabric_exec terminates at the accepted checklist.
- prewalk: `PI_FABRIC_PREWALK_EXTRA_EXTENSIONS` loads operator provider extensions headless; docs/certification.md records the first real collector findings (omniroute gateway route, harness fixes, remaining RPC executor-continuation blocker) with automatic policy promotion still off.

## 0.31.1-ultra.19 - 2026-08-08

- codemap: call-site and literal extraction now cache ast-grep scans per file by mtime and re-scan only files whose mtime drifted; source-root discovery skips roots that do not exist.
- agents: one-shot and persistent-agent startup failures carrying the gateway chat_admission_busy code are retried inside the bounded attempt budget, waiting out the documented Retry-After window instead of a fixed exponential ramp.
- prewalk: executor selection tries the primary route then the configured fallbackModels in order, reporting per-route unavailable and authentication reasons and a typed terminal error when every route fails.
- init: /fabric init no longer scaffolds files itself. It queues a visible repository workflow message that inspects the repository, proposes only grounded context changes, preserves existing files, and reports created, updated, skipped, and validated artifacts; trailing prose after init is rejected.
- prewalk: the unused public clearWriteScope escape hatch is removed; scope release stays owned by settleTask.
## 0.31.1-ultra.18 - 2026-08-08

- prewalk: the progress widget tears itself down the moment every checklist item is done instead of retaining fully struck-through rows on the dashboard; the message handler now routes the live checklist through a pure checklistWidgetView that returns null once the list is complete (or empty).
## 0.31.1-ultra.17 - 2026-08-08

- init: /fabric init is now an interactive jump start. Greenfield checkouts get a short intake (project name, purpose, primary users, success priority) whose answers replace the AGENTS.md overview and project.md Purpose / Users-and-success placeholders.
- init: every interactive run previews the plan behind a Write all / Cancel select before anything is written; Cancel aborts with nothing on disk. Non-interactive contexts keep the previous write-through behavior.
- init: an existing tech-stack.md can be regenerated from fresh detection behind an explicit confirm, via a new overwrite plan action in the scaffold planner.
- init: brownfield runs launch one bounded explorer (65k tokens, 180s) by default and write its brief into the architecture placeholders of files created in the same run; pre-existing files are never patched, and missing agent surfaces degrade to a skip note.
- init: .pi/fabric.json now materializes the full DEFAULT_FABRIC_CONFIG pinned to the current configVersion instead of the two-key stub.
- init: the stale present-tense legacy-migration notices after a completed .pi-to-root copy are gone; unreadable legacy siblings are reported as deferred, and the output closes with next-step guidance.
## 0.31.1-ultra.16 - 2026-08-08

- prewalk: the executor now receives an explicit [DONE:n] emission contract in the continuation and reminder prompts, numbered by original checklist position, so completed items strike through in the progress widget in the same turn they finish; the widget re-reads live status after marking and tears down exactly once when the prewalk settles instead of leaving stale rows on the dashboard.
- prewalk: the research arm spends the retrieval budget in full passes and grounds unfamiliar algorithms with an aligned arXiv paper plus an aligned repository clone under sources/.
- codemap: buildAllEdges moves from symbols.ts into build.ts so the symbol index no longer imports the call extractor.
- docs: AGENTS.md records the .cgcignore removal and full-tree indexing decision.

## 0.31.1-ultra.15 - 2026-08-07

- codemap: search now serves the grep-replacement query classes from AST-typed indexes — regex content patterns against the literal index, YAML/JSON config keys as typed literals, declaration queries with an unfiltered fallback for const-arrows and type aliases, and exact-name ties preferring the exported definition.
- codemap: new refs operation lists every real call site with file:line and enclosing caller for a name:file symbol key, riding the bundle's cached ast-grep scan.
- codemap: full-tree scans survive Windows argv limits — file lists are chunked into bounded batches in outline, literal, and call extraction, and /fabric init identity probes are bounded so a hanging gh api retry cannot stall the command.
- prewalk: the progress widget strikes through done checklist items (strikethrough + dim) with plain [ ] lines for pending items.
- docs: code-map-research.md section 14 records the codemap-first buff and measured served-fraction lift.

## 0.31.1-ultra.14 - 2026-08-07

- compaction: retire oversized old successful retirable-tool results (fabric_exec, codemap, read, grep, find, ls) above a configured ceiling with typed markers, so a single huge unique result cannot inflate context until compaction; recent turns, errors, mutations, evidence, and non-text content stay exact.
- compaction: proactive message-count ceiling (default 700) compacts before dispatch when the active context reaches it, so a long message-dense session is not rejected by a provider 800-message history cap; independent of token-occupancy thresholds and configurable in /fabric settings.
- prewalk: armed-prompt delegation guidance now states the configured consult worker ceiling instead of a stale zero-worker default.
- ci: publish workflow creates a detailed GitHub Release from the changelog section via scripts/release-notes.mjs (idempotent create/edit).

## 0.31.1-ultra.13 - 2026-08-07

- exec: add a bounded per-session `carry` namespace so JSON-safe guest state survives across sequential `fabric_exec` calls in both QuickJS and node-process runtimes.
- exec: reject full `pi.write` overwrites after a truncated `pi.read`, and elide pathological oversized scalar arrays before they consume model context.
- prewalk: make delegation guidance match the configured worker ceiling and claim accepted checklists as handoff boundaries, fixing headless sessions that stopped at the plan without running the executor.
- project: reset invalid pre-fix DeepSWE evidence and include benchmark/source material in the project code graph.

## 0.31.1-ultra.12 - 2026-08-07

- compaction: auto-compact every model via a global `compaction.threshold` (default 0.85); per-model entries still win. Models without an entry previously never auto-compacted.
- prewalk: `[DONE:n]` markers in executor turns mark checklist items complete, rendered as a checklist n/m status and ASCII widget; the per-turn reminder omits finished items and carries a done-count header, cutting re-sent tokens on long workflows.
- compat: adapt OpenAI compaction request headers to Pi 0.84 `ProviderHeaders` (values may be null; filtered before fetch). `@earendil-works/{pi-coding-agent,pi-tui,pi-ai}` devDeps bumped 0.83.0 → 0.84.1; render/TUI suites verified on 0.84.1.

## 0.31.1-ultra.11 - 2026-08-07

- init: `/fabric init` copies legacy `.pi` context files to their root-level siblings instead of only reporting the migration.
- prewalk: session-scoped arms survive settled tasks, so the gate stays armed for the whole session; the continuation reminder re-injects only after a mutation attempt, keeping read-only turns quiet.
- config: hand-edits to either `fabric.json` take effect on the next prompt via an mtime watch; no `/fabric` settings touch or restart needed.
- codemap: cgc search tokenizes multi-word queries and searches classes; `source` honors the `name:file` qualifier; scoped hotspots and search exclude vendored paths; the AST skeleton renders files by aggregate PageRank so token budgets keep load-bearing modules; truncated output carries a visible marker.
- refactor: one shared `isRecord` guard replaces ten per-module copies; the fabric_exec render surface moves to `fabric-exec-render.ts` (createFabricExecTool complexity 255 → 49); `FabricExecutionService.execute` splits into guest and settle phases (complexity 241 → 42). No behavior change.

## 0.31.1-ultra.10 - 2026-08-07

- runtime: add a distinct `budget_exhausted` terminal status threaded through the worker, agent manager, lifecycle events, activity ledger, evidence classification, and dashboards so budget exhaustion is never collapsed into timed_out; failure records preserve observed progress.
- prewalk: make `autoScout` explicit opt-in (scouts spawn only on request, never on prompt send) and add `scoutTimeoutMs` / `scoutMaxTokens` budget knobs (defaults 3 min / 64k tokens).
- codemap: add cgc reference mode with an explore evidence pipeline, member-level disclosure, wider import specifier coverage, and actionable cgc errors.
- startup: warn when the loaded build is stale vs current source.
- settings: add a CGC bridge toggle section to /fabric settings.
- cleanup: remove 21 dead exports and the superseded codemap-heat-render test.

## 0.31.1-ultra.9 - 2026-08-06

- bench: fabric-prewalk becomes a first-class DeepSWE matrix config with an isolated prewalk-first fabric.json, omniroute provider upload, and config-aware model selection.
- bench: add live Prewalk DeepSWE run evidence for `scc-bounded-memory-spilling` (reward 1, P2P 286/286, F2P 31/31) under `bench/results/live-prewalk/`.


- **CI-safe cross-repo benchmark.** The codemap focus/dwell bench skips its
  on-demand fixture clones (`sources/`, `/tmp/codemap-bench`) when absent,
  so the release gate passes in fresh CI checkouts instead of failing on
  ENOENT for vendored repositories.

## 0.31.1-ultra.7 - 2026-08-06

- **Auto-scout brief.** Opt-in `prewalk.autoScout` runs the cheap scout/explorer
  role (pinned via `roleModels`) before the frontier planning pass, bounds the
  compressed context brief to 2k characters, injects it into the armed prompt,
  and appends scout token spend to the budget ledger under `prewalk:scout`.
- **Release gate repair.** Restore user-opt-in `disable-model-invocation` on the
  specialized skills, drop the retired agent `runner` field from skill programs
  and tests, remove machine-local path pointers from skill docs, and clear the
  knip dead-export backlog so `pnpm run check` exits clean.

## 0.31.1-ultra.6 - 2026-08-06

- **AST-first agent guidance.** Route symbol, declaration, call, and dependency queries to the
  codemap provider before grep in the fabric-exec skill; grep stays for string literals,
  comments, and configuration.
- **Wider graph roots.** The source scan indexes tests/ and scripts/ alongside src/ (skipping
  node_modules, dist, .pi, sources, bench), so symbols defined outside src resolve from the AST
  index instead of forcing a grep fallback.
- **Source operation.** New `codemap.source` returns the AST range text of a `name:file` symbol
  key, budget-capped, on both the tool and fabric-provider surfaces.
- **Phrase fallback.** Multi-word queries that match no literal now tokenize and retry the symbol
  index, with provenance marking the fallback result.

## 0.31.1-ultra.5 - 2026-08-06

- **Import-scoped call edges.** Resolve codemap callees through the caller's import graph
  (new `src/codemap/scope.ts`): a call links only to definitions in the caller's file or
  its imports, with global-definer fallback where imports don't resolve. Cross-file false
  invokes edges drop from 2457 (37.9%) to 0; the cascade dependency channel regains ranking
  signal (TRAIN-selected historyWeight 1.0 -> 0.75).

## 0.31.1-ultra.4 - 2026-08-05

- **Codemap AST provider.** Expose the code map as a Fabric provider with four operations
  (skeleton, search, expand, cascade) backed by an AST-compressed graph with progressive
  disclosure. Add benchmark and stress harnesses.
- **Lifecycle durable work store.** Add a persistent task DAG, phase contract, and review
  surface for multi-turn work tracking.
- **Agent role profiles.** Extend role profiles, config surface, and fabric command for
  agent declarations.
- **Prewalk control loop.** Close the control loop by making the model oscillation
  structural; never leave Main on the executor model and restore Main's model and thinking
  level on every terminal path. Retain the executor model and hand off at the accepted
  checklist, steering the executor from the live checklist every turn.
- **Prewalk auto-arm.** Auto-arm from configuration, keep durable run evidence, and
  re-arm from current configuration across turn boundaries.
- **Prewalk in-place executor.** Run the in-place executor off-session with correct
  thinking, fallback, and provenance. Consolidate to one in-session executor path and
  clean up off-session in-place with a mode-contract test.
- **Prewalk fixes.** Bound the per-turn checklist reminder per continuation. Forward the
  armed thinking level to the executor. Surface a failed quality gate record in execution.
  Migrate away the removed prewalk mode field.
- **Host wiring.** Wire codemap and lifecycle into the host, update tooling config.
- **Config.** Enable the fabric compaction engine and context QoS window. Enable the audit
  quality gate with typecheck. Track the project Fabric configuration.
- **Agents fix.** Isolate a Consult worker from ambient project resources.
- **Codemap fix.** Remove self-invalidating history-rate assertion in the cascade test.
- **UI.** Dispatch dashboard input through a mode-keyed map.
- **Worker.** Lift main's event handlers to module scope.
- **Test harness.** Isolate HOME and the Pi agent directory per worker.
- **Bench scripts.** Add the makora DeepSWE and Pier harness scripts.
- **Documentation.** Retire the removed three-mode prewalk narrative. Describe model
  ownership after the return-policy removal. Add measured Prewalk cost, comparisons,
  and handoff results to the README. Centralize durable project context under .pi.
- **Chores.** Ignore the runtime agent run directory and hindsight directory. Drop the
  knip ignore for relocated inspiration clones. Document the code graph context boundary.
- **Dependencies.** Declare @ast-grep/cli as a devDependency so the codemap provider
  works in CI and on fresh clones without a globally installed ast-grep binary.

## 0.31.1-ultra.4 - 2026-08-05

- **Codemap AST provider.** Expose the code map as a Fabric provider with four operations
  (skeleton, search, expand, cascade) backed by an AST-compressed graph with progressive
  disclosure. Add benchmark and stress harnesses.
- **Lifecycle durable work store.** Add a persistent task DAG, phase contract, and review
  surface for multi-turn work tracking.
- **Agent role profiles.** Extend role profiles, config surface, and fabric command for
  agent declarations.
- **Prewalk control loop.** Close the control loop by making the model oscillation
  structural; never leave Main on the executor model and restore Main's model and thinking
  level on every terminal path. Retain the executor model and hand off at the accepted
  checklist, steering the executor from the live checklist every turn.
- **Prewalk auto-arm.** Auto-arm from configuration, keep durable run evidence, and
  re-arm from current configuration across turn boundaries.
- **Prewalk in-place executor.** Run the in-place executor off-session with correct
  thinking, fallback, and provenance. Consolidate to one in-session executor path and
  clean up off-session in-place with a mode-contract test.
- **Prewalk fixes.** Bound the per-turn checklist reminder per continuation. Forward the
  armed thinking level to the executor. Surface a failed quality gate record in execution.
  Migrate away the removed prewalk mode field.
- **Host wiring.** Wire codemap and lifecycle into the host, update tooling config.
- **Config.** Enable the fabric compaction engine and context QoS window. Enable the audit
  quality gate with typecheck. Track the project Fabric configuration.
- **Agents fix.** Isolate a Consult worker from ambient project resources.
- **Codemap fix.** Remove self-invalidating history-rate assertion in the cascade test.
- **UI.** Dispatch dashboard input through a mode-keyed map.
- **Worker.** Lift main's event handlers to module scope.
- **Test harness.** Isolate HOME and the Pi agent directory per worker.
- **Bench scripts.** Add the makora DeepSWE and Pier harness scripts.
- **Documentation.** Retire the removed three-mode prewalk narrative. Describe model
  ownership after the return-policy removal. Add measured Prewalk cost, comparisons,
  and handoff results to the README. Centralize durable project context under .pi.
- **Chores.** Ignore the runtime agent run directory and hindsight directory. Drop the
  knip ignore for relocated inspiration clones. Document the code graph context boundary.

## 0.31.1-ultra.3 - 2026-08-04

- Default `prewalk.returnPolicy` to `previous` so in-place returns Main to its own model once the continuation settles, matching trajectory.
- Carry a host-accepted checklist into every prewalk mode instead of research only, replaying it in the in-place continuation and embedding it in the trajectory executor task.
- Declare `@earendil-works/pi-ai` as a bundled peer dependency at `*` so an installed package cannot bind to a duplicate module instance.

## 0.31.1-ultra.2 - 2026-08-04

- Keep an unfired prewalk arm armed across turn boundaries; it previously disarmed at the end of the turn that observed its task, so a later first edit never handed off.
- Default `prewalk.alwaysRearm` to on, still adjustable in `/fabric settings`.
- Prune the prewalk arming instruction for every mode instead of research only, so in-place and trajectory executors no longer inherit the handoff scaffold on their first inference.

## 0.31.1-ultra.1 - 2026-08-02

- Fix packaged Pi startup by removing an unsupported `pi-ai` deep import.
- Add an isolated packed-extension smoke gate before release.

## 0.31.1-ultra.0 - 2026-08-02

First experimental Ultra Fabric prerelease, based on pi-fabric 0.31.1.

### Added

- Continuous Prewalk research execution with stale-result ownership and evidence gates.
- Durable persistent-agent delivery, run context, reservations, workflows, context QoS, capability routing, and outcome infrastructure described in the Ultra roadmap.
- Offline certification and a 20-task Prewalk contract corpus with opt-in real-model collection.

### Changed

- Reduced recurring Fabric and skill prompt context while preserving progressive discovery.
- Packaged every documented certification and benchmark script.
- Added a Git-install build hook and safe public `next` publication defaults.

### Compatibility

- Requires Node.js 24 or newer.
- Supports Pi 0.80.6 or newer and is developed against Pi 0.83.x.
- Published prereleases use the npm `next` channel until the runtime is declared stable.
