# Changelog

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
