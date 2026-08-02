# AGENTS.md — Ultra Fabric

## Project

Ultra Fabric is a resilient, adaptive orchestration runtime for Pi, forked from `monotykamary/pi-fabric`.

- Checkout: `/home/ryanj/work/projects/ultra-fabric`
- Product architecture: `docs/ultra-fabric.md`
- Fork boundary: `docs/adr/0001-fork-boundary.md`
- Runtime: Node.js 24+ and Pi 0.83.x
- Package manager: pnpm with a committed lockfile
- Git remotes: `origin` is Ultra Fabric; `upstream` is pi-fabric

## Working contract

- Follow Rule 0. The latest explicit user request controls intent and scope while higher authority remains.
- Frame meaningful work in one or two sentences with concrete acceptance criteria. Ask only when a consequential boundary remains unclear.
- Do not narrate routine tool calls or echo file contents. Keep explanations proportional to the work and avoid box-drawing characters.
- Read scoped `AGENTS.md` or `CLAUDE.md`, configuration, and relevant context before asking intent questions. Check `sources/` early when present. Put needed upstream or mod clones there instead of fetching isolated files.
- Prefer semantic or graph navigation before text search. Find all references before renames or signature changes. Use grep and find for strings, comments, configuration, or graph fallback.
- For non-trivial work, use a compact plan that names files, order, tests, and live checks. Ask before an unrequested multi-file refactor or architecture decision.
- Build the smallest working slice, run focused diagnostics after edits, then run the repository gate. Separate local proof from checks still needed on named servers or feature flags.
- Use plain `fabric_exec` and zero agents for ordinary work. Get one-line user confirmation before an agent, actor, or advanced Fabric workflow unless the request already names it.
- Never place secrets in prompts, agent messages, actor instructions, mesh payloads, logs, or committed files. Read them from runtime environment or config and never echo values.
- Preserve user-supplied commit and PR wording unless asked to edit it. Use the current allowed branch and never invent one.
- Confirm the working directory before shell commands and honor the detected shell. Mention fish only when verified. A disabled backup must replace the real extension, such as `mymod.bak`, so loaders cannot still match it.
- Use one name per thing, active voice, short paragraphs, and direct verbs. Avoid hedging, hype, semicolons, and em dashes in new prose.
- Verify factual claims or label them unconfirmed. For debugging, list the symptoms every valid theory must explain before choosing a root cause.
- Treat graph and memory results as hints until source-verified. Keep durable work status in source, issues, the current receipt, or project-scoped Hindsight. Update existing memory instead of duplicating it.

## Mission

Close Fabric's control loop without discarding its proven runtime. The user states an outcome once; Ultra Fabric may route, delegate, supervise, retry, compact, and verify only within host-owned limits. The default remains zero agents.

Implement the roadmap continuously in the order recorded in `docs/ultra-fabric.md`:

1. Prewalk v2 continuity and stale-result ownership
2. Reliable persistent Agents with durable inbox/outbox and explicit delivery outcomes
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
- Keep shared-workspace writers serialized. Installed Pi policy blocks branch and worktree creation in this checkout.

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

Use conventional commits such as `feat(prewalk): ...`, `fix(agents): ...`, and `chore(release): ...`. Keep unrelated work out of commits. Do not push, publish, release, or change repository visibility unless the user requests it.
