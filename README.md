<div align="center">

# ⚙️ Ultra Fabric

**A [Pi](https://github.com/earendil-works/pi-coding-agent) extension for context engineering: structural code maps, same-session prewalk handoff, host-owned compaction, and bounded agents.**

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fabric/main/media/cover.jpg" alt="Pi Fabric composing tools and agents in the Pi TUI" width="1100">
</p>

[![checks](https://img.shields.io/github/actions/workflow/status/ryan-brosas/ultra-fabric/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/ryan-brosas/ultra-fabric/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

> **Status:** experimental fork of [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric), based on upstream 0.31.1. Current milestone is the Slice 8 benchmark and soak gates: the all-113 DeepSWE matrix stopped at 28/113 cells on Docker daemon loss, so the gate remains unmet and automatic policy promotion stays off. See the [architecture](docs/ultra-fabric.md), the [fork-boundary ADR](docs/adr/0001-fork-boundary.md), and the [roadmap](.pi/roadmap.md).

## What Ultra Fabric is

Ultra Fabric is a Pi extension for context engineering. It reads code structurally instead of scanning text, hands long tasks across models in one live session, keeps the session's context host-owned and compact, and delegates only what an explicit, bounded agent budget allows. Main keeps task intent and final authority; delegation is explicit opt-in and every child stays bounded by admission, turn budgets, and spend caps.

Four focus areas:

1. **Codemap** — the codebase is parsed once into an AST graph, compressed 11.1x from raw source, and disclosed to the model in stages under an explicit token budget. `skeleton`, `search`, `focus`, `dwell`, `expand`, and `cascade` answer which files and symbols a change touches, not which files contain a string.
2. **Prewalk** — a frontier model plans and takes the first concrete implementation step, then hands the **same live session** to a faster executor. The executor inherits the conversation and the real tool set, and Main is restored when it settles. Three clean-room runs measured 67% of output tokens from the executor at roughly 2.2x generation rate, for an estimated 46.5% cost saving against the all-planner counterfactual.
3. **Compaction** — the session owns its context. `compact.request` records an advisory intent the host commits at the next `agent_settled` boundary, with bounded preserve items and instructions; a model can never compact the running context directly.
4. **Agent utilization** — agents are profiles on one runtime, used explicitly and bounded: `prewalk.autoScout` (explicit opt-in) injects a 2k-character brief before planning, the supervisor is a four-turn-bound runtime behavior, and scout spend lands in the budget ledger under `prewalk:scout`.

## How it works

You talk to Pi the way you always do. Fabric adds one tool, `fabric_exec`, that the model uses to combine reads, edits, MCP servers, agents, and coordination into a single type-checked TypeScript program. The program runs in a sandbox and only its result returns to the conversation; branching, loops, and fan-out become code instead of a stack of tool calls you watch one by one. Type-checking catches shape errors before the program runs.

1. You ask in plain language.
2. Pi writes one program that calls the tools, agents, and MCP servers it needs. The program is type-checked before it runs.
3. Only the result returns to your conversation. Intermediate work stays in the sandbox and shows in the activity panel.

The model writes something like this, you do not:

```ts
const [manifest, sources] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.find({ pattern: "**/*.ts", path: "src" }),
]);
return {
  package: JSON.parse(manifest).name,
  sourceCount: sources.split("\n").filter(Boolean).length,
};
```

Independent calls run in parallel; only the returned object enters the model context.

## Code map

Fabric reads code structurally instead of scanning it as text. `ast-grep` parses each source file into an outline of symbols, signatures, and line numbers, and Fabric turns those outlines into a graph the model can walk.

Measured on this repository with ast-grep 0.45.0:

| Source | Size |
| ------ | ---: |
| 223 TypeScript files, raw | 2,493,559 chars |
| The same tree as an ast-grep outline | 223,667 chars |
| Compression | 11.1x |

Reproduce:

```sh
cat $(find src -name '*.ts') | wc -c
ast-grep outline $(find src -name '*.ts') | wc -c
```

The whole outline is roughly 56K tokens. That fits a modern context window but spends most of it on code the task never touches, so the `codemap` provider discloses the map in stages. Every operation takes an explicit `maxTokens` budget and reports whether it truncated.

| Operation | What it returns |
| --------- | --------------- |
| `skeleton` | The minimal compressed map to start from |
| `search` | A query routed to the symbol and literal index |
| `focus` | A query heat-diffused through the graph to center the map on a task |
| `dwell` | One active field expanded, returning only the delta |
| `expand` | The dependency neighborhood around named entities, upstream or downstream |
| `cascade` | Files or symbols that have historically changed together with a seed |
| `source` | The AST range text of a `name:file` symbol key |

`cascade` blends git history with the dependency graph, so it answers which files a change will drag along rather than which files contain a string. That is the part text search cannot do.

The graph is built once per root and cached on file mtime, so repeated calls within a turn stay cheap. Language coverage comes from ast-grep, so TypeScript, JavaScript, Go, Python, Rust, and Java all index through one path. `@ast-grep/cli` ships as a declared dependency, so there is nothing to install separately. See [code map research](docs/code-map-research.md) for the measured baselines and the AST-rank fusion plan.

`mode: "cgc"` (opt-in via `codemap.cgc`) queries the installed CodeGraphContext database for reference repos — a separate read-only namespace, never merged into the project graph — and `explore` returns a bounded staged evidence pack (skeleton, routed symbols, complexity hotspots, seam-test pointers, source) for the "how do I get sufficient context cheaply" case.

## Prewalk handoff

Prewalk lets a frontier model plan and take the first concrete implementation step, then hands the **same session** to a faster executor. The switch is in-session: the executor inherits the live conversation and the real tool set, so no plan has to be re-serialised into a fresh context. One path, no modes. The context levers for the split — `handoffRetirement`, `autoScout`, `reuseChecklists`, `failureMemory` — are covered under [Compaction and context](#compaction-and-context). See [docs/agents.md](docs/agents.md#automatic-prewalk) for the full protocol.

Three isolated clean-room runs on 2026-08-04, each a fresh `pi -p` session in an empty workspace with `--session-dir`, planner `claude-bridge/claude-opus-5`, executor `makora/zai-org/GLM-5.2-NVFP4`, and the standalone `pi-prewalk` extension uninstalled so attribution is unambiguous.

| Task | Trigger | Plan | Execute | Planner median | Executor median | `model_change` |
| ---- | ------- | ---: | ------: | -------------: | --------------: | -------------: |
| `slugify` | `pi.edit` | 153s | 48s | 149.9 tok/s | 300.0 tok/s | 3 |
| `truncate` | `pi.write` | 106s | 84s | 132.0 tok/s | 285.5 tok/s | 3 |
| `clamp` | `pi.edit` | 81s | 77s | 120.9 tok/s | 204.7 tok/s | 3 |

Every run recorded exactly three `model_change` entries, planner, executor, planner, proving both the switch and the restore. The executor produced 45,682 of the 68,442 total output tokens (67%) across 12 of 33 requests, at roughly 2.2x the planner median generation rate.

### Cost

Measured tokens across the same three runs:

| Model | Requests | Input | Output | Cache read | Cache write |
| ----- | -------: | ----: | -----: | ---------: | ----------: |
| `claude-opus-5` | 21 | 42 | 22,760 | 319,049 | 63,157 |
| `GLM-5.2-NVFP4` | 12 | 87,151 | 45,682 | 187,456 | 0 |

Priced at published API rates. Opus 5 is $5 per 1M input and $25 per 1M output ([Anthropic](https://www.anthropic.com/news/claude-opus-5)), with Anthropic standard cache ratios of 1.25x input for writes and 0.1x for reads. GLM-5.2 is $1.40 per 1M input, $0.26 per 1M cached input, and $4.40 per 1M output ([Z.AI](https://docs.z.ai/guides/overview/pricing)).

| | Cost |
| --- | ---: |
| Planner (Opus 5) | $1.1235 |
| Executor (GLM-5.2) | $0.3718 |
| **Actual total** | **$1.4952** |
| Same work all-Opus | $2.7950 |
| **Saving** | **46.5%** |

The executor produced 67% of the output for 24.9% of the spend.

These are **estimates at published rates, not billed amounts**. The planner ran through an OAuth subscription bridge, so those tokens were not charged per request, and Z.AI list rates stand in for the actual GLM host. The all-Opus figure is a counterfactual that assumes identical token counts, which a different model would not reproduce exactly.

### Compared to the previous Fabric prewalk

Fabric previously offered three prewalk modes. Only one switched the live session; the other two handed a copied transcript to an off-session child that had no workspace tools, so it could report success having changed nothing.

| | Previous `in-place` / `trajectory` | Current single path |
| --- | --- | --- |
| Model switches observed | 0 across 2 arms | 3 per run, 3 of 3 runs |
| Executor tool calls | 0 | 12 requests, real edits |
| Restores Main afterwards | no | yes, by default |

No cost comparison is offered against the previous modes, because they did no work to price.

### Compared to the Stencil write-up

The technique originates with [Stencil Prewalk](https://stencil.so/blog/prewalk) and the todo-gated handoff in [oh-my-pi](https://github.com/can1357/oh-my-pi). Stencil reported 41% lower cost and 1.9x faster completion on SWE-Bench Pro; we estimate 46.5% lower cost and measure 2.2x generation throughput.

**These are not the same measurements.** Stencil ran a real task suite with a different model pair and reported end-to-end completion time and pass rate. Ours is a three-task shape check on trivial functions measuring generation rate, with cost derived from list prices rather than invoices, and no pass rate at all. The agreement in direction is worth noting; the numbers are not comparable, and Stencil figures are **not** inherited here. Paired task-level evidence remains the job of the 20-task contract corpus in [certification and benchmarks](docs/certification.md).

## Compaction and context

The session owns its context. A `compact` provider is always available (no config guard) with three actions:

- `compact.request({ reason?, instructions?, preserve?, requestedBy? })` — records an advisory intent to compact. The host commits it at the next `agent_settled` boundary; the model cannot compact the running context directly.
- `compact.status()` — reports the compaction controller state.
- `compact.cancel()` — cancels a pending request.

Requests are bounded: instructions up to 8 KiB, and up to 16 preserve items of at most 2 KiB each (`src/compaction/instructions.ts`). See [docs/architecture.md](docs/architecture.md#model-context-economy) for the output-side economy (capped returns, artifact staging, omission markers).

The same principle shapes the Prewalk context split. `prewalk.autoScout` is explicit opt-in and runs the cheap scout pass before planning only when enabled; recon and research otherwise stay on Main's own context, and support roles or `consult.run` workers run only on explicit request. `prewalk.handoffRetirement` retires Main's planning-phase `read`/`grep`/`find`/`ls` results from the executor transcript once the continuation is live and accepted — errors and evidence-bearing results always survive — mirroring the SWE-Edit viewer/editor decomposition that cut inference cost 17.9% on SWE-Bench Verified. `prewalk.reuseChecklists` seeds repeat tasks with their prior plan (newest 16, max 4 seed items). `prewalk.failureMemory` seeds the next similar task's plan with the failure patterns the gate previously rejected, with scout spend attributed in the budget ledger under `prewalk:scout`. See [docs/agents.md](docs/agents.md#automatic-prewalk).

## Agents

An agent is either one-shot or persistent. Roles like scout, worker, advisor, and supervisor are profiles on that one runtime, not separate systems. List them with `(await agents.roles()).roles`, pick one with `role`, and override its goal, completion contract, or turn budget per call. Add your own in `~/.pi/agent/agents/*.md` or trusted project profiles in `.pi/agents/*.md`.

Agent utilization is on-request: recon and research stay on Main's context, `autoScout` is explicit opt-in and a bounded scout brief lands before planning only when enabled, and support roles or `consult.run` workers run only through an explicit call. A role's model resolves by precedence — per-call request, then `agents.roleModels` in `fabric.json`, then the profile pin. Every child stays bounded by admission policy, turn budgets, and token or dollar caps; leaving `prewalk.autoScout` unset gives a zero-agents posture.

The built-in `supervisor` is runtime behavior, not a skill: it subscribes to settled and error events, steers only when useful, coalesces repeats, and drops stale directives, with a four-turn activation bound. `/skill:fabric-supervisor` only creates or reuses that role for a concrete goal.

Installed Pi provider extensions and `~/.pi/agent/models.json` are auto-detected for Pi-backed agents, settings, and `tools.models()`. Known Fabric providers take direct calls such as `mcp.fal_ai.get_model_schema(...)`, `memory.recall(...)`, `state.get()`, `schema.status()`, and `compact.status()`. Use `tools.call({ ref, args })` for refs computed at runtime.

## DeepSWE smoke comparison

A matched [Pier benchmark](bench/README.md) recorded on 2026-08-03 compared the published packages on the `scc-bounded-memory-spilling` DeepSWE task. Both arms used Pi 0.83.0, `openai-codex/gpt-5.6-sol` at low thinking, the same Docker task image and verifier, and three serial attempts.

| Package | Full solves | Mean partial score | Median agent wall time | Total model cost |
| ------- | ----------: | -----------------: | ---------------------: | ---------------: |
| `pi-fabric@0.25.6` | 0/3 | 0.9748 | 320.9s | $2.79 |
| `ultra-fabric@0.31.1-ultra.1` | 2/3 | 0.9947 | 398.1s | $2.90 |

The binary verifier awards a full solve only when all 31 task-specific fail-to-pass tests and all 286 pass-to-pass regression tests pass. The reference arm preserved all regression tests but missed task-specific edge cases in every attempt. Ultra passed all 31 task-specific tests in every attempt and produced two fully correct patches. All six trials completed without infrastructure errors.

This is a one-task smoke comparison with three stochastic attempts across different package versions, so it neither proves broad superiority nor isolates Ultra-native behavior from upstream evolution. See the [benchmark harness and reproduction notes](bench/README.md).

## Live Prewalk DeepSWE run

A separate one-task run recorded on 2026-08-06 exercised the live same-session Prewalk flow directly (not the Pier harness): a fresh `boyter/scc` checkout at base commit `bc2796e01998ebc2d40818323f93113aed2542ea`, checklist-first planning, and the executor model `omniroute/opencode-go/deepseek-v4-flash`. The official DeepSWE verifier for `scc-bounded-memory-spilling` graded the resulting patch on a pristine base clone.

| Metric | Value |
| --- | ---: |
| Reward | 1 |
| Pass-to-pass | 286/286 |
| Fail-to-pass | 31/31 |
| Patch bytes | 27,914 |

Evidence: `bench/results/live-prewalk/scc-bounded-memory-spilling.json` plus the exact graded patch as `scc-bounded-memory-spilling-model.patch.gz` (uncompressed md5 `539106689e27cbb76df0451f1a3e1036`, compressed sha256 `4892f6bdef150fdffafd641098ca6bd7a5c44ef3f5759589bdf83283fd21eca2`) next to it.

This result is **not comparable to the smoke comparison above** and is deliberately not merged with it. It is one task with no live baseline arm, so no cost, token, or wall-time comparison is claimed. Two process limitations are disclosed: the one-shot `explorer` scout attempt hit the run token limit and returned no usable output, and the task bundle's reference `solution.patch` was inspected during the run after independent task and path analysis, so this is not a clean-room execution. Broader subsets (canary-8 and the 36-task set) remain pending until each named task is independently run and graded; no extrapolation from 1/1 is implied.

### Status of the broader runs

The all-113 live matrix under `bench/results/deepswe-all113` (job `20260806-v3b`) was stopped mid-run when the Docker daemon became unavailable. Evidence `bench/results/deepswe-all113/monitor-v3b/status.json` records 28 of 113 cells completed, 2 exceptions, and 85 pending. The stop is an infrastructure failure, not a task verdict, and no result beyond the recorded cells is claimed. The canary-8 and full matrix subsets plus the 20-task Prewalk contract corpus remain pending until each named task is independently run and graded. Slice 8 stays active and automatic policy promotion stays disabled until representative evidence clears the documented gate.

## Install

Requires Node.js 24+ and Pi 0.80.6+. Fabric checks the host version at startup and warns when an older host may ignore continuation APIs.

### npm prerelease

Pin an exact experimental version so it does not move:

```bash
pi install npm:ultra-fabric@0.31.1-ultra.19
```

If `pi-fabric` is installed, replace it rather than loading both:

```bash
pi remove npm:pi-fabric
pi install npm:ultra-fabric@0.31.1-ultra.19
```

Restart Pi after changing extension packages.

### Git

```bash
pi install git:github.com/ryan-brosas/ultra-fabric
```

<details>
<summary>Local development methods</summary>

From a local checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/ultra-fabric
```

For one development run:

```bash
pi -e /absolute/path/to/ultra-fabric
```

</details>

## What you can ask for

Advanced patterns are user-invoked and are not advertised for automatic selection. Run `/skill:fabric-guide` for a recommendation, or invoke the exact `/skill:<name>` yourself. An ordinary coding task keeps Pi on the core `fabric-exec` path.

| You want | Run |
| -------- | --- |
| Help choosing the smallest advanced mechanism | `/skill:fabric-guide Choose a mechanism to audit every auth file and verify the findings.` |
| Parallel audits, migrations, or research with verification | `/skill:fabric-workflow Audit every auth file and synthesize verified findings.` |
| Work too big for one context window | `/skill:fabric-rlm Produce a compact architecture map of this repo.` |
| A persistent watcher for one measurable goal | `/skill:fabric-supervisor Watch this migration until it is complete and tested.` |
| A strict auditor for one feature design spec | `/skill:fabric-spec Implement docs/specs/checkout.md to the tee; nothing missing, nothing extra.` |
| A quiet decision-point reviewer | `/skill:fabric-advisor Focus on migration correctness.` |
| Same-model independent reviewers and one decision | `/skill:fabric-council Review this design for correctness, security, and operability.` |
| Multi-model compare-not-merge deliberation | `/skill:fabric-fusion Deliberate this design across models.` |
| One command that infers advisor versus supervisor | `/skill:fabric-ambient advisor Focus on migration correctness.` |
| A durable team coordinating through versioned tasks | `/skill:fabric-swarm Coordinate this migration across owned task partitions.` |
| Evidence-gated edits with postconditions | `/skill:fabric-schema Make this parser change only if focused tests stay green.` |

The `fabric-exec` reference skill loads before the first `fabric_exec` call and again when a call errors on argument shape.

## The dashboard

Fabric adds a live activity surface to Pi:

- A compact widget above the chat whose header follows the current phase and whose rows show active and completed agents with their recent tool or code-change activity.
- `/fabric` (or `/fabric dashboard`) opens **Activity** and **Topology** views. The user-facing session is always **Main**. Queue or steer Main, one-shot and persistent agents, and mesh participants; navigate a unified topology of runs with paged transcripts, topics, state, and routes.
- `/fabric settings` mirrors Pi `/settings` and writes to `fabric.json`.

See the [interface & commands reference](docs/interface.md) for every view, keybinding, and slash command.

## Reference

- [Ultra Fabric architecture](docs/ultra-fabric.md) — the power wheel, verified gaps, delivery slices, and acceptance criteria.
- [Fork boundary](docs/adr/0001-fork-boundary.md) — what stays upstream-shaped and what becomes Ultra-native.
- [Configuration](docs/configuration.md) — `fabric.json`, code modes, tool capture, approvals, and budgets.
- [Quality enforcement](docs/quality.md) — trusted changed-file checks for programming languages, HTML, CSS, and custom formats.
- [Code map research](docs/code-map-research.md) — measured compression baselines, aider's repomap algorithm, and the plan for AST-rank fusion.
- [Certification and benchmarks](docs/certification.md) — offline certification, the 20-task Prewalk contract corpus, bounded evidence analysis, and opt-in real-model benchmarks.
- [Interface & commands](docs/interface.md) — dashboard, settings, keybindings, slash commands, and headless runs.
- [Agents & mesh](docs/agents.md) — Ultra Consult, agents, model handoff and `/fabric prewalk`, the Claude runner, transports, steering, persistent agents, templates, councils, recursion, and coordination.
- [External providers](docs/providers.md) — the versioned provider protocol for extensions.
- [Architecture & security](docs/architecture.md) — the host bridge, sandboxing, tool-call robustness, and limitations.
- [Skills](docs/skills.md) — the core-first invocation policy and user-invoked advanced patterns.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The suite covers configuration, schema validation, language-aware quality enforcement, provider dispatch, tool interception and execution, QuickJS isolation, Pi built-in invocation, Ultra Consult admission and evidence, agents, Claude stream-JSON and model discovery, workflows, durable mesh state, persistent-agent mailboxes, and runner restoration. Claude fixtures never make a billable request.

Measured on `main` (2026-08-06): `pnpm run check` passes 178 test files / 1766 tests in ~2m21s. The codemap AST benchmark over 162 queries reports cascade Recall@8K 0.217 vs 0.014 for naive file ranking and 35,101 tokens-to-cover vs 43,650 (full-outline reference 58,477); the held-out split (52 train / 52 test) reports cascade Recall@8K 0.288 vs 0.008 naive, and the stress harness passes determinism, budget, and recall checks. `pnpm benchmark:prewalk` validates a 20-task contract corpus without model calls and exits `SKIP` when no result file is supplied; the real-model collectors default to a safe skip.

## License

MIT. Ultra Fabric retains the original pi-fabric copyright and license; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).