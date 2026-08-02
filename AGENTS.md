# AGENTS.md — Ultra Fabric

## Project

Ultra Fabric is a resilient, adaptive orchestration runtime for Pi, forked from `monotykamary/pi-fabric`.

- Checkout: `/home/ryanj/work/projects/ultra-fabric`
- Product architecture: `docs/ultra-fabric.md`
- Fork boundary: `docs/adr/0001-fork-boundary.md`
- Runtime: Node.js 24+ and Pi 0.83.x
- Package manager: pnpm with a committed lockfile
- Git remotes: `origin` is Ultra Fabric; `upstream` is pi-fabric

## Mission

Close Fabric's control loop without discarding its proven runtime. The user states an outcome once; Ultra Fabric may route, delegate, supervise, retry, compact, and verify only within host-owned limits. The default remains zero agents.

Implement the roadmap continuously in the order recorded in `docs/ultra-fabric.md`:

1. Prewalk v2 continuity and stale-result ownership
2. Reliable actors with durable inbox/outbox and explicit delivery outcomes
3. Run context, evidence gates, and atomic reservations
4. Durable workflows over mesh CAS
5. Context QoS
6. Capability routing and admission
7. Outcome learning and UI

Finish the smallest coherent tested slice, update adoption status, then continue to the next unblocked slice. Stop only for a material product boundary, dependency change, destructive operation, contradictory proof, or unavailable required authority.

## Fork boundary

Keep two lanes separate:

- **Upstream-shaped fixes:** minimal existing-file changes, focused regression tests, no Ultra policy concepts.
- **Ultra-native capability:** pure typed modules, narrow adapters, opt-in policy until measured, and no UI before backend contracts stabilize.

Do not mix an upstream refresh with behavior changes. Preserve the upstream MIT license and attribution.

## Engineering rules

- Test first for every behavior change. Observe RED, implement the minimum GREEN, then refactor.
- Keep policy pure and effects at adapters. Model lifecycle and failures as discriminated unions.
- Treat async completion as owned by a stable run/session/phase identity; reject stale completion.
- Preserve task intent across infrastructure failure. Never retry permanent failure automatically.
- Bound every loop by attempts, time, tokens, cost, concurrency, and effects.
- Failure states remain distinct: blocked, failed, stale, rejected, timed out, dead-lettered, and budget-exhausted.
- Do not add dependencies without explicit user approval.
- Do not hand-edit `dist/`; build it from `src/`.
- Keep shared-workspace writers serialized or isolated in worktrees.

## Verification

Name the narrow check before each slice. Before handoff, run:

```sh
pnpm run check
```

This runs typecheck, a fresh build, all tests, and Knip dead-code analysis. Also inspect:

```sh
git diff --check
git status --short --branch
```

Tests run against `src/`, while Pi loads `dist/`, so a fresh build is mandatory even when focused tests pass.

## Commits and publication

Use conventional commits such as `feat(prewalk): ...`, `fix(actors): ...`, and `chore(release): ...`. Keep unrelated work out of commits. Do not push, publish, release, or change repository visibility unless the user requests it.
