# Changelog

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
