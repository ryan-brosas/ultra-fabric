<div align="center">

# ⚙️ Ultra Fabric

**A resilient, adaptive orchestration runtime for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One typed control plane for tools, models, agent lifecycles, workflows, recovery, verification, and learning._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fabric/main/media/cover.jpg" alt="Pi Fabric composing tools and agents in the Pi TUI" width="1100">
</p>

[![checks](https://img.shields.io/github/actions/workflow/status/ryan-brosas/ultra-fabric/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/ryan-brosas/ultra-fabric/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

> **Development status:** Ultra Fabric is an experimental fork of [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric), currently based on upstream 0.31.1. It preserves Fabric's programmable runtime while developing continuous Prewalk, supervised persistent agents, durable workflows, adaptive routing, context QoS, and outcome-based learning. See the [Ultra Fabric architecture](docs/ultra-fabric.md) and [fork-boundary ADR](docs/adr/0001-fork-boundary.md).

You keep talking to Pi the way you always do. Fabric gives the model **one programmable tool** — `fabric_exec` — that it uses to compose Pi's core tools, MCP servers, captured extension tools, one-shot and persistent agents, plus durable coordination into a single type-checked TypeScript program. The program runs in a QuickJS sandbox by default; an explicit unsafe Node-process executor is available for trusted workloads that exceed WASM32 memory. Only the final result comes back to the conversation. Branching, loops, fan-out, and data flow become code the model writes and type-checks — not a stack of separate tool calls you have to orchestrate.

## Why Fabric?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| ⚡ | **Code mode** | One flat tool schema; branching, loops, fan-out, and data flow live in checked TypeScript. |
| 🧰 | **Capability routing** | Call Pi core tools, MCP servers, captured extension tools, or Fabric providers through one runtime. |
| 🧑‍🤝‍🧑 | **Agent runtime** | One-shot and persistent agents, councils, and bounded recursive queries. |
| 🧠 | **Ultra Consult** | Zero-agent-by-default context offload through host-scoped read-only fresh workers and byte-bounded validated evidence. |
| 🕸️ | **Workflows + mesh** | Phased progress plus durable topics, shared tasks, and compare-and-swap state. |
| 🛡️ | **Guardrails** | Approvals, isolation, language-aware quality gates, timeouts, concurrency, recursion depth, and shared cost budgets. |
| 🎛️ | **Native TUI** | Live activity, an interactive dashboard, and settings without leaving Pi. |

## How it works

1. **You ask** in plain language, as usual.
2. **Pi writes one program** that calls the tools, agents, and MCP servers it needs. The program is type-checked before it runs.
3. **Only the result returns** to your conversation. Intermediate work stays in the sandbox and surfaces in the activity panel and dashboard.

Under the hood, the model writes something like this — you don't:

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

## One Agent runtime, configurable roles

An Agent is either `one-shot` or `persistent`; scout, worker, advisor, supervisor, and other names are role profiles rather than separate runtimes. Discover them with `(await agents.roles()).roles` and inspect its `diagnostics`, select one with `role`, and override a concrete goal, completion contract, or narrower turn budget per instance. Add user profiles in `~/.pi/agent/agents/*.md` or trusted project profiles in `.pi/agents/*.md`.

The built-in persistent `supervisor` is native runtime behavior: settled/error subscriptions, validated directives, active steering, coalescing, stale-directive suppression, read-only tools, completion precedence, and a four-turn activation bound come from `agents/supervisor.md`. `/skill:fabric-supervisor` only creates or reuses that role for a concrete goal; it is not a second supervisor implementation.

Installed Pi model-provider extensions and `~/.pi/agent/models.json` entries are auto-detected for Pi-backed agents, settings, and `tools.models()`; Ultra Fabric keeps no provider allowlist. Known Fabric providers use concise direct calls such as `mcp.fal_ai.get_model_schema(...)`, `memory.recall(...)`, `state.get()`, `schema.status()`, and `compact.status()`; `tools.call({ ref, args })` remains the fallback for refs discovered or computed at runtime.

## Install

Requires Node.js 24+ and Pi 0.80.6+. Fabric also checks a detectable Pi host version at startup and warns when an older host may ignore continuation APIs such as persistent-agent `triggerTurn`.

```bash
pi install git:github.com/ryan-brosas/ultra-fabric
```

<details>
<summary>Other install methods</summary>

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

Advanced patterns are user-invoked and are not advertised for automatic selection. Run `/skill:fabric-guide` when you want one recommendation, or invoke the exact `/skill:<name>` yourself. Describing an ordinary coding task keeps Pi on the core `fabric-exec` path. Ultra Consult is part of that core path rather than an advanced skill: Main may attempt it once when fresh context could change a named decision, while host policy can still admit zero workers.

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

The foundation is the `fabric-exec` reference skill: the model loads it before its first `fabric_exec` call and again when a call errors on argument shape.

## The dashboard

Fabric adds a live activity surface to Pi, no extra extension required:

- A compact widget above the chat (like `pi-supervisor`) whose header follows the current phase while its rows show active/completed agents across both lifecycles and their recent nested tool or code-change activity.
- `/fabric` (or `/fabric dashboard`) — **Activity** and **Topology** views where the user-facing Pi session is always present as **Main**. Queue/steer Main, one-shot and persistent agents, and observed mesh participants; navigate a spring-followed unified topology of runs and project mesh, with paged transcripts, topics, state, and routes.
- `/fabric settings` — mirrors Pi's `/settings` and writes changes to `fabric.json`.

See the [interface & commands reference](docs/interface.md) for every view, keybinding, and slash command.

## Reference

- [Ultra Fabric architecture](docs/ultra-fabric.md) — the power wheel, verified gaps, delivery slices, and acceptance criteria.
- [Fork boundary](docs/adr/0001-fork-boundary.md) — what stays upstream-shaped and what becomes Ultra-native.
- [Configuration](docs/configuration.md) — `fabric.json`, code modes, tool capture, approvals, and budgets.
- [Quality enforcement](docs/quality.md). Configure trusted changed-file checks for programming languages, HTML, CSS, and custom formats.
- [Interface & commands](docs/interface.md) — dashboard, settings, keybindings, slash commands, and headless runs.
- [Agents & mesh](docs/agents.md) — Ultra Consult, agents, trajectory-preserving model handoff and `/fabric prewalk`, the Claude runner, transports, steering, persistent agents, global templates, councils, recursive queries, and durable coordination.
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

The test suite covers configuration, schema validation, language-aware quality enforcement, provider dispatch, registered-tool interception and execution, QuickJS isolation, Pi built-in invocation, Ultra Consult admission/evidence/reduction, agents, fake Claude stream-JSON and model discovery, workflows, durable mesh state, persistent-agent mailboxes and subscriptions, and Pi/Claude runner restoration. Claude fixtures never make a billable request.

## License

MIT. Ultra Fabric retains the original pi-fabric copyright and license; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
