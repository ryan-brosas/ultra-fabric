# AGENTS.md — Ultra Fabric

Detailed context lives in `.pi/project.md`, `.pi/roadmap.md`, and `.pi/tech-stack.md`. Architecture authority is `docs/ultra-fabric.md`; fork authority is `docs/adr/0001-fork-boundary.md`.

## Project invariants

- Ultra Fabric is a resilient Pi orchestration runtime forked from `monotykamary/pi-fabric`.
- Support Node.js 24+ and Pi 0.83.x. Use pnpm with the committed lockfile.
- Main retains task intent and final authority. The default remains zero agents.
- Keep automatic policy promotion disabled until the documented Slice 8 benchmark and soak gates pass.

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

Close Fabric's control loop without discarding its proven runtime. The user states an outcome once; Ultra Fabric may route, delegate, supervise, retry, compact, and verify only within host-owned limits.

- Follow the ordered roadmap in `.pi/roadmap.md` and `docs/ultra-fabric.md`; the current milestone is Slice 8 representative benchmark and soak evidence.
- Finish the smallest coherent tested slice, update adoption status, then continue until a material boundary, destructive effect, contradiction, or missing authority blocks progress.

## Fork boundary

Classify every change before implementation and keep the two lanes separate:

- **Upstream-shaped fixes:** minimal existing-file changes, focused regression tests, compatibility with upstream, and no Ultra policy concepts.
- **Ultra-native capability:** pure typed modules, narrow adapters, opt-in policy until measured, and no UI before backend contracts stabilize.

Do not mix an upstream refresh with behavior changes. Preserve the upstream MIT license and attribution.

## Engineering rules

- Test first for every behavior change. Observe RED, implement the minimum GREEN, then refactor.
- Keep policy pure and effects at adapters. Model lifecycle and failures as discriminated unions.
- Treat async completion as owned by a stable run/session/phase identity; reject stale completion.
- Preserve task intent across infrastructure failure. Never retry permanent failure automatically.
- Bound every loop by attempts, time, tokens, cost, concurrency, and effects.
- Keep blocked, failed, stale, rejected, timed out, dead-lettered, and budget-exhausted distinct.
- Do not add dependencies without explicit user approval.
- Do not hand-edit `dist/`; build it from `src/`.
- Keep shared-workspace writers serialized. Installed Pi policy blocks branch and worktree creation in this checkout.

## Verification

Name the narrow check before each slice. Before handoff, run exactly:

```sh
pnpm run check
git diff --check
git status --short --branch
```

`pnpm run check` performs typecheck, a fresh build, all tests, Knip dead-code analysis, and package smoke. Tests run against `src/`, while Pi loads `dist/`.

## Commits and publication

Use conventional commits such as `feat(prewalk): ...`, `fix(agents): ...`, and `chore(release): ...`. Keep unrelated work out of commits. Do not push, publish, release, or change repository visibility unless the user requests it.
