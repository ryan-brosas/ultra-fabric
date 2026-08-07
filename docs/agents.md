# Agents & mesh

This is the human-facing reference for Fabric's multi-agent runtime. The model-facing API lives in [`skills/fabric-exec/references/agents.md`](../skills/fabric-exec/references/agents.md) and [`mesh.md`](../skills/fabric-exec/references/mesh.md); the reusable patterns live in the [skills](../skills/) (`fabric-workflow`, `fabric-swarm`, `fabric-council`, `fabric-rlm`, `fabric-supervisor`, `fabric-advisor`, `fabric-fusion`). See [configuration](configuration.md) for the `agents` and `mesh` settings.

## Agent lifecycles

**Agent** is the only user-facing delegated-runtime concept. Choose a lifecycle instead of a separate primitive:

- A **one-shot agent** runs one task through `agents.run()`, `agents.spawn()`, `agents.handoff()`, workflows, or Ultra Consult.
- A **persistent agent** has stable identity, a serial mailbox, a resumable runner session, and optional event/topic subscriptions. Create one with `agents.create()`.
- An **agent template** is a reusable persistent-agent definition. It is not live and carries no mailbox, transcript, or run history. List templates with `agents.templates()`.
- A **worker** is one process or activation behind an agent, not another public identity.

Role profiles make each lifecycle customizable without adding another runtime concept. `agents.roles()` returns the active contracts plus diagnostics for invalid custom files. Built-ins include one-shot `scout`, `explorer`, `planner`, `reviewer`, and `worker`, plus persistent `advisor`, `supervisor`, `ambient`, and `coordinator`. User profiles in `~/.pi/agent/agents/*.md` override built-ins, and trusted project profiles in `.pi/agents/*.md` override both.

## Workflows

Fabric programs already keep orchestration and intermediate values in code. The workflow globals add Claude Code-style names and progress phases without introducing a second JavaScript runtime.

Available helpers:

- `workflow.agent(prompt, options)` or `agent(...)` — one worker. Set `label` on every call.
- `workflow.parallel(thunks, { concurrency })` or `parallel(...)` — fan-out. Pass functions, not promises.
- `workflow.pipeline(items, ...stages)` or `pipeline(...)` — per-item sequential stages with cross-item concurrency.
- `workflow.context()` — reads the safe run/trace/span envelope and current agent/token reservation snapshot; the raw objective is never exposed.
- `workflow.gate({ gate, passed, disposition, evidence, reason?, error? })` — records ordered verification evidence. Failed `advise` gates continue, `revise` gates must be resolved by a later passing result for the same gate, and `abort` or crashed gates fail the run.
- `workflow.configure({ name, description })` — names the activity surface.
- `workflow.phase(name, { id?, description?, total? })` or `phase(...)` — progress groups.
- `workflow.item(...)` — non-agent work items whose status changes over time.
- `workflow.event(...)` — notable milestones in the dashboard feed.
- `workflow.log(...)` — compact progress notes.
- `workflow.budget` — token-budget observations.

Agent calls may provide `requirements` and an ordered `fallbackModels` list. Fabric evaluates Pi registry capability and authentication before launch. Capability-preserving fallbacks are automatic; quality downgrade requires host `agents.allowQualityDowngrade`. The returned handle/result includes `route` with the requested and selected model, reason, quality classification, and considered candidates.

Host policy can require `admission: { reason, expectedArtifact }` before one-shot runs, spawns, or handoffs. Bounded reasons distinguish independent context, separable parallel work, capability gaps, long-running work, and independent verification. `profile` selects a host `agents.capabilityProfiles` entry whose tools and recursive risk grants cannot be elevated by the request.

`fabric_exec` accepts optional `agentBudget` and `tokenBudget` limits. The host reserves agent slots and finite tokens before provider invocation, injects the reservation as the child `maxTokens` ceiling, rejects concurrent over-admission, and reclaims unused tokens after blocking runs settle. Detached spawn and handoff conservatively commit their full reservation. Cost remains append-only because Fabric has no trustworthy pre-run cost ceiling. A JSON Schema on an agent request makes the worker return validated structured data through `result.value`; workflow helpers return that value directly and otherwise return the agent's final text. See [`/skill:fabric-workflow`](../skills/fabric-workflow/SKILL.md) for the full pattern.

## Ultra Consult

Ultra Consult is the bounded context-engineering path between doing everything in Main and invoking a full workflow skill. Main can call `consult.run()` directly inside its ordinary `fabric_exec` program. The host begins with zero workers, admits at most one Consult attempt per parent execution, and launches no more than three fresh workers.

Use it only when a named result can change a named decision:

- **Partition** assigns non-overlapping path scopes to two or three workers. It is appropriate for broad context that can be split without sharing Main's hidden reasoning.
- **Challenge** gives one worker a concrete proposal and asks only for material evidence-backed objections. No issue is a successful silent result.
- **Compare** uses non-overlapping evidence scopes or distinct model identities. The reducer preserves disagreement and never asks another model to invent a consensus.

```ts
return consult.run({
  objective: "Review the authentication boundary",
  decision: "Ship the refresh-token design or revise it",
  mode: "partition",
  admission: {
    justification: "context_capacity",
    independence: "Token rotation and session invalidation are separate modules",
    couldChange: "The ship decision and revision owner",
  },
  perspectives: [
    { id: "tokens", question: "Inspect rotation", scope: ["src/auth/tokens"] },
    { id: "sessions", question: "Inspect invalidation", scope: ["src/auth/sessions"] },
  ],
});
```

Workers always use fresh Pi sessions, `recursive: false`, discovered extensions off, and only `read`, `grep`, `find`, and `ls`. Fabric loads one explicit host scope guard that realpath-checks every tool path against the checkout and perspective before the tool executes. The request cannot add shell, network, write tools, or another delegation layer. Every non-silent finding must also resolve to an existing regular file inside the checkout and its perspective scope, with a valid optional line range. Absolute paths, traversal, missing files, out-of-project symlinks, invalid lines, and unsupported claims are rejected.

The reducer returns `success`, `partial`, `inconclusive`, a terminal failure status, or `not_admitted`, plus explicit coverage. It computes consensus only when every requested perspective is accepted and all recommendations are normalized-equal; otherwise it returns ordered disagreements. A declined request is not retried or converted into manual fan-out. Outcome records retain only mode/status, coverage, context ratio, unique evidence count, and aggregate worker tokens/cost. Worker prompts and prose are not persisted.

Configure the admission threshold and ceilings under `/fabric settings` → **Ultra Consult** or the `consult` block in [`fabric.json`](configuration.md).

## One-shot agents

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  transport: "localterm",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

Background handles are explicit:

```ts
const handle = await agents.spawn({
  task: "Map the persistence layer and identify its public entry points.",
  transport: "tmux",
});

// Do independent work here.

return await agents.wait({ id: handle.id });
```

### Trajectory-preserving handoff

A handoff is a blocking Pi-to-Pi delegation over a real fork of the caller's active session branch, rather than a fresh worker that receives only a task string. One complete `fabric_exec` invocation is the atomic frontier unit. An explicit `agents.handoff()` call records a deferred request inside the guest; it does not spawn a child or stop the program at that line. Sequential and parallel calls after the request continue normally.

After the complete Fabric program returns, Pi finalizes the native outer `fabric_exec` tool result. At that `message_end` boundary, Fabric forks through the original assistant entry containing the native `fabric_exec` call and appends that exact finalized native `toolResult` to the child branch. It then starts the selected executor in the same workspace and waits before Pi can perform another Main inference. The child therefore sees exactly the outer call and frontier result finalized before handoff replacement, including the Fabric source, output, and persisted trace; nested calls are not rewritten into synthetic assistant turns. An in-memory source is materialized into the same native Pi session format.

Fabric adds no handoff-specific count or size limit. Normal `fabric_exec` output and trace projection limits still apply before the boundary. Handoff fails closed if the active outer turn cannot be identified or belongs to an incomplete parallel top-level tool batch.

```ts
await pi.edit({ path: "src/guard.ts", edits: [{ oldText, newText }] });
await agents.handoff({
  model: "anthropic/claude-haiku-4-5",
  task: "Continue from this completed Fabric invocation.",
  when: ({ count }) => count("pi.edit") >= 1,
});
await pi.bash({ command: "pnpm test guard" });
return "Frontier Fabric invocation completed";
```

`when` is an optional pure synchronous predicate evaluated inside the Fabric guest. It receives immutable `{ calls, count(ref?) }` facts for every successful resolved bridge call completed earlier in that `fabric_exec` program, including `pi.*`, `extensions.*`, `mcp.*`, external providers, and computed `tools.call()` refs. `count()` counts all calls; `count("pi.edit")` counts one ref; `count(["pi.edit", "schema.commit"])` counts a set. Generic calls are recorded under their resolved target rather than `fabric.$call`, and failed calls do not count. A false predicate starts no child and fails clearly; the function itself never crosses the host bridge. Omit `when` for unconditional scheduling.

Inside the guest, `agents.handoff()` resolves to `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`; child output cannot be consumed by later code in that same Fabric invocation. At the outer boundary, Main's tool result is replaced with the compact completion `{ handedOff, completed, status, agent, implementation, error? }`. `model` is required, the target runner is Pi, and `worktree` is intentionally unavailable because implementation must remain visible in the caller's workspace. Optional fields are `task`, `name`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, and `schema`. The source session is not switched or historically rewritten.

### Automatic Prewalk

`/fabric prewalk` adapts Can Bölük's [Prewalk research](https://stencil.so/blog/prewalk) into one in-session path. The frontier model plans and submits a checklist, the host hands the same Main session to the executor for implementation and verification, then restores the frontier model on settle.

```text
/fabric prewalk
/fabric prewalk Implement the token guard and run its tests
/fabric prewalk --status
/fabric prewalk --retry
/fabric prewalk --off
```

With a task, Fabric arms prewalk and submits it to Main immediately. Without one, it captures the next user input. Configure the executor under `/fabric settings` → **Prewalk**. **Always re-arm** captures successive tasks until `/fabric prewalk --off`.

The protocol:

1. Fabric sends Main a hidden, phase-owned instruction to form a grounded plan and submit `prewalk.checklist({ items })` with 5-9 ordered tasks and a specific validation for each.
2. The host rejects every matching mutation until that checklist is accepted. One matching mutation can be in flight; concurrent matches are rejected.
3. The accepted checklist triggers the handoff. The host aborts the Fabric runtime as an owned boundary, so no later guest statement or nested call runs. This works in both QuickJS and the unsafe Node-process runtime.
4. Fabric records the exact successful audit as the trigger, filters the planning instruction out of the next model context, switches the same Main session to the configured executor, and sends the accepted checklist in the identity-owned continuation.
5. The executor completes the remaining implementation and verification. When the continuation settles, Fabric restores Main to its original model.

Failed mutation attempts release the reservation and do not switch models. Trigger matching still comes from `triggerEffects`, `triggerRisks`, and `triggerRefs`. Bash cannot be inferred as a workspace mutation and remains opaque unless named explicitly. Prewalk does not spawn a child and does not require `agents.enabled`. Matching these protocol boundaries does not import the article's cost or quality claims. Ultra must establish those through its own benchmark.

For a host-enforced verification loop, set `prewalk.verificationMode` to `"gated"`. The hidden verify turn must run checks and report `workflow.gate()`; passing evidence settles, `revise` creates one scoped executor handoff, and missing/aborted/crashed evidence blocks at the configured `maxPhaseRevisions` cap. Omit the field for legacy prompt-only verification.

Recon and research stay on Main's own context. Support roles (`scout`, `explorer`, `worker`, `reviewer`) and `consult.run` workers run only on explicit request through `agents.run` or the `consult.run` surface, and every child stays bounded by admission, turn budgets, and spend caps. The prewalk prompts carry no plan-then-delegate discipline.

Three more opt-in levers tune the planning/execution split:

- `prewalk.handoffRetirement` (default off) retires Main's planning-phase `read`/`grep`/`find`/`ls` results once the executor continuation is live and accepted. The checklist already carries the plan, so the executor stops replaying every exploration result as input each turn and re-reads only what it touches. Errors and evidence-bearing results always survive. Mirrors the SWE-Edit viewer/editor decomposition, which cut inference cost 17.9% on SWE-Bench Verified.
- The **easy path** is a checklist disposition, not a config flag: a bounded mid-tier task may call `prewalk.checklist({ easy: true, items })` with 2-4 items. The host still hands off to the executor (unlike trivial) but Main skips deep research. Trivial stays for one-or-two-edit tasks, full for complex ones.
- `prewalk.reuseChecklists` (default off) records each accepted checklist keyed by task text and seeds the next similar task's armed prompt with the nearest prior plan (token-overlap ranked, bounded to the newest 16, max 4 seed items) so Main adapts instead of re-deriving. Stored as `prewalk-checklists.json` beside the run root.

Prewalk adds no system-prompt instructions. A dedicated hidden planning message is kept only while the frontier phase is armed. Accepting the identity-owned executor continuation removes it before provider inference. The hook also retains only the continuation owned by the current pending/continuing lifecycle and removes stale or legacy Prewalk continuation messages. Successful handoffs settle only after Pi reports no follow-up work remains. **Always re-arm** activates after settlement rather than during the same task. If a captured task settles without a monitored trigger, prewalk disarms instead of leaking into the next task. Failed handoffs remain blocked and never retry automatically. Retry is explicit. An explicit successful `agents.handoff()` takes precedence over automatic prewalk. Prewalk requires full code mode and is unavailable in Schema enforce mode.

### Pi model-provider extensions

Ultra Fabric automatically consumes Pi's effective `ModelRegistry`; it does not ship a provider allowlist or a second model catalog. A provider extension registered with `pi.registerProvider()` (for example Makora), a Pi package installed with `pi install`, and entries in `~/.pi/agent/models.json` therefore appear in:

- `tools.models()` and `agents.models({ runner: "pi" })`;
- `/fabric settings` and persistent-agent model pickers;
- capability-aware routing, Prewalk selection, and Pi-backed one-shot or persistent runs.

Install the provider as a global/package extension, or place it in an auto-discovered trusted location, then run `/reload`. Ordinary Pi children inherit normal extension discovery because `agents.extensions` defaults to `true`; Ultra passes the canonical `provider/model-id` key to the child Pi CLI. Setting `extensions: false` deliberately starts Pi with `--no-extensions`, so extension-registered providers are unavailable in that child. A provider loaded only through a one-off parent `pi -e /path/to/provider.ts` flag is not propagated automatically; install/auto-discover it or use `models.json` before selecting its model.

Provider authentication, endpoints, model metadata, and streaming remain owned by Pi and the provider extension. Ultra Fabric does not copy credentials or vendor a Makora-specific transport.

### Transports

| Transport   | Behavior                                                   | Attach command               |
| ----------- | ---------------------------------------------------------- | ---------------------------- |
| `process`   | Detached local worker process; default and lowest overhead | none                         |
| `tmux`      | One detached tmux session per child                        | `tmux attach-session -t …`   |
| `screen`    | One detached GNU Screen session per child                  | `screen -r …`                |
| `localterm` | One pinned LocalTerm PTY per child                         | `localterm session attach …` |
| `herdr`     | One background Herdr tab per child                         | `herdr terminal attach …`    |
| `auto`      | Tries Herdr, LocalTerm, tmux, screen, then process         | transport-specific           |

Herdr uses its local socket API to create an argv-backed background tab atomically, without shell quoting or focus changes. Automatic selection is enabled only when the parent Pi process is already inside Herdr (`HERDR_ENV=1` with an injected workspace and socket); select `transport: "herdr"` under the same conditions. Each child can be opened directly with the attach command in its handle.

LocalTerm already exposes the needed tmux-parity primitives: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric therefore requires no LocalTerm patch. Start its daemon before selecting it:

```bash
localterm start
```

Use `/fabric agents` to list both live lifecycles; `/fabric attach <id>` displays an attach command for supported one-shot entries. Abort signals propagate to the transport and selected child process. When a program uses orchestration entry points (`agent`/`workflow.agent`, `agents.run`/`agents.wait`/`agents.ask`, `council.run`, `rlm.query`, `consult.run`)—including `agents.*` refs invoked through `tools.call()` and refs computed at runtime—Fabric raises the whole-program `executor.timeoutMs` to at least `agents.timeoutMs`, so the parent deadline cannot stop children that are still within their own per-agent budget.

Set `worktree: true` to create a dedicated Git worktree and `pi-fabric/<name>-<id>` branch. Worktrees are retained for inspection until `agents.cleanup()` is called. Fabric passes the absolute project and mesh roots into every Pi child, so a recursive child in a worktree remains in the same participant directory instead of creating a second `.pi/fabric/mesh` under that worktree.

## Shared-workspace write leases

`leases.acquire({ paths, ttlMs })` atomically owns file/tree paths for the current run; `leases.release({ ids })` releases only leases owned by that run and `leases.list()` shows active project leases. An overlapping foreign lease rejects nested `pi.edit`/`pi.write` before mutation. No lease preserves compatibility behavior. Bash is intentionally opaque, so use worktrees when shell commands can write.

## Unified participants and steering

Fabric has one project participant directory. Every live root or Agent has a `rootId`, an optional `parentId`, an `ownerHostId`, and an authenticated owner identity naming the process that controls its lifecycle. **Main** is the local user-facing view of one root; **Peers** are compatibility views of the other roots. They are not separate registries or control planes. **Peer is a reserved Fabric term for another root Pi session, never shorthand for a child agent.** Use `agents.peers()` first when asked about a peer; `agents.list()` only reports child agents and cannot determine peer-root settlement.

`agents.self()` returns the caller's participant record. `agents.members({ scope?, kinds?, includeStale? })` exposes public roots and Agents; persistent entries use `kind: "agent", lifecycle: "persistent"` rather than another identity class. `agents.list({ scope?, lifecycle? })` is the canonical live-agent inventory: lifecycle defaults to `"one-shot"`, with `"persistent"` and `"all"` available; scope defaults to `"local"`, with `"lineage"` for the same root and `"project"` for every live project agent. `agents.main()` and `agents.peers()` remain convenient root projections. Normal discovery hides every participant whose execution-host lease expired. Shared summaries contain operational metadata but never agent prompts, results, or errors.

```ts
const main = await agents.main();
const project = await agents.members({ scope: "project" });
const peerRoot = project.find(
  (participant) => participant.kind === "root" && participant.id !== main.id,
);
if (peerRoot) {
  await agents.steer({ id: peerRoot.id, message: "Coordinate on the shared migration." });
}
await agents.followUp({ id: main.id, message: "After the audit, reconcile the findings." });

const lineage = await agents.list({ scope: "lineage" });
return { self: await agents.self(), lineage };
```

For Main and one-shot agents, `steer` is delivered after the current turn's tool calls and before the next model call; `followUp` waits for the current run to settle. For a persistent agent, both enqueue its serial mailbox. `agents.status({ id })` accepts any participant id, returning full detail for a local run/persistent agent and a bounded directory summary for a remote participant. `agents.setSteeringMode`/`setFollowUpMode` remain local one-shot controls.

Local routing returns `"main"` or `"local"`. Cross-process `steer`, `followUp`, and `stop` resolve the target's exact owner, send an owner-addressed control command, and wait for a version/target/owner-identity-matched acknowledgement. Success returns `routed: "mesh", acknowledged: true`; unknown ids, stale owners, rejection, and timeout throw rather than reporting an unverified queue. The dashboard's `s`, `u`, and `x` actions use this same path. Cross-process control requires `mesh.enabled`. See [`references/agents.md`](../skills/fabric-exec/references/agents.md).

### Participant lifecycle subscriptions

Use durable source-qualified subscriptions when one participant must react to another participant's Pi or run lifecycle. Unlike `agents.status()`, subscriptions are host-managed and survive turns without asking a model to poll.

```ts
const [peer] = await agents.peers();
if (peer) {
  await agents.subscribe({
    from: peer.id,
    events: ["pi.agent_settled"],
    to: "main",
    delivery: "followUp",
    triggerTurn: true,
    once: true,
  });
}
```

`agents.subscribe` takes an exact source participant id (or `"main"` for the caller's root), one or more lifecycle events, an optional target (default Main), a `steer`/`followUp` delivery mode, an explicit `triggerTurn` policy, and optional `once`. Use `agents.subscriptions()` and `agents.unsubscribe({ id })` to inspect and remove routes. Subscriptions begin at the current mesh sequence rather than replaying old events, and their delivery cursor is durable across host restarts. Delivery is at-least-once if a host crashes after inserting the target message but before persisting its cursor; consumers can deduplicate side effects with the lifecycle event `id`.

Pi-specific events are namespaced as `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events are `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. Lifecycle envelopes intentionally contain source identity and bounded operational metadata rather than session transcripts.

A detached local `agents.spawn()` also has a narrower convenience path: when `agents.notifyOnComplete` is enabled, terminal completion sends Main a triggered follow-up automatically. Calling `agents.wait()` makes it foreground work and suppresses that detached notification.

## Persistent agents

`agents.create()` creates a named persistent agent with a fixed runner, a persistent runner session, a serial mailbox, and optional subscriptions to parent-session events or durable mesh topics:

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: `Watch the main session until the auth migration is complete and tested.
Prefer silence. Reply with a directive only for material drift, a blocker, or verified completion.`,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  thinking: "high",
  tools: ["read", "grep", "find", "ls"],
});
```

A host-managed Claude persistent agent uses the same mailbox and event surface while retaining Claude Code context across activations:

```ts
return agents.create({
  name: "claude-reviewer",
  runner: "claude",
  model: "claude/haiku",
  instructions: "Review each delivered event and report only concrete regressions.",
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  tools: ["read", "grep", "find", "ls"],
});
```

Claude persistent agents can retain context, inspect/edit with mapped Claude Code tools, consume host events and mesh messages delivered by Fabric, and return text or directives. They cannot themselves call `fabric_exec`, `agents.*`, or `mesh.*`; use a Pi persistent agent when the persistent agent must recursively coordinate through Fabric. If Claude's private session has been removed, the next activation fails clearly rather than silently discarding persistent agent context. Recreate the persistent agent to start a fresh Claude session.

This is the primitive behind emergent supervisors and advisors; neither requires another extension. Persistent agents can observe every session-bound public Pi extension event: resource discovery; session start/info/switch/fork/compaction/tree/shutdown events; input and before-agent-start; agent, turn, and message lifecycle; context and provider request/response lifecycle; tool call/result/execution lifecycle; model and thinking changes; and user bash. The exact event names are the Pi extension names (for example `input`, `before_agent_start`, `tool_call`, and `tool_result`), plus Fabric's synthetic `tool_error`. `project_trust` is the sole exception because it fires before Fabric may read the trusted project agent registry. Intercepting Pi hooks remain observations: a persistent agent runs asynchronously and cannot block a tool, rewrite context, mutate provider headers, or return another extension hook result. Shutdown and immediate session-replacement observations are best-effort because the owning runtime is being torn down.

Host-event JSON includes a bounded recent-session snapshot and is sanitized before it enters the mailbox: credential-shaped fields and encoded blobs are redacted. Pi `ImageContent` blocks are different. Fabric replaces each persisted block with an indexed descriptor, carries the raw image out of band on the transient activation, and submits it to the selected persistent agent's Pi or Claude model automatically. There is no media opt-in flag—the explicit event subscription is the trust boundary. Raw image bytes never enter `persistentAgents.json` or the persistent agent mailbox record, although the selected runner's own persistent model session may retain images using its normal session semantics. `activation.signal.media` contains descriptor metadata for freshness predicates and correlation.

Persistent agents process messages one at a time, coalesce repeated host events by default (especially useful for `message_update` and `tool_execution_update`), and restore with the trusted project agent registry.

### Native asynchronous vision handoff

A vision handoff no longer needs its own event-watching extension. Create one persistent agent once, target a multimodal model, and subscribe to `input`; Fabric detects and attaches the prompt's images automatically. Passive `steer` delivers the description to Main without starting an unrelated idle turn, and `coalesce: false` preserves distinct image prompts while the vision agent is busy:

```ts
return agents.create({
  name: "vision-handoff",
  instructions: `Inspect every attached image from the parent prompt.
Return { action: "silent" } when no image is attached.
Otherwise return { action: "message", message } with a precise, compact visual description
that Main can use without seeing the image. Do not answer the user's broader coding task.`,
  events: ["input"],
  runner: "pi",
  model: "provider/multimodal-model", // replace with a key from tools.models()
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: false,
  validWhile: ({ activation }) =>
    activation.kind !== "hostEvent" || (activation.signal?.media?.length ?? 0) > 0,
  tools: [],
  extensions: false,
});
```

`validWhile` drops image-free input activations before a model run, so ordinary text prompts incur no vision-agent inference. Dispatch remains asynchronous: Main's current inference is never blocked waiting for the visual description. Use `before_agent_start` instead of `input` only when the persistent agent specifically needs Pi's expanded prompt/system context; subscribing to both intentionally produces two activations for one user prompt.

`validWhile` adds a programmatic freshness guard for persistent agents. Fabric serializes its pure synchronous function source, checks it before starting queued work and before delivering completed work, and persists it with project persistent agents and global templates. The immutable `activation` fact is a `hostEvent`, `direct`, or `mesh` activation; `current` contains `latestActivationSequence`, `mainRevision`, `taskRevision`, `idle`, and `now`. Main revisions advance on completed tools and lifecycle events, so a tool-error review can become stale after Main recovers. Return `false` or `{ valid: false, reason? }` to suppress stale work. Invalidated fire-and-forget work is recorded as a silent stale outbox entry; an invalidated `agents.ask()` rejects. Predicates cannot be async, call tools, or depend on closures because their source must execute after restoration.

```ts
return agents.create({
  name: "fresh-reviewer",
  instructions: "Review only the latest useful parent-session event.",
  events: ["tool_error", "agent_settled"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  validWhile: ({ activation, current }) => {
    if (activation.kind !== "hostEvent") return true;
    if (activation.sequence !== current.latestActivationSequence) {
      return { valid: false, reason: "a newer activation exists" };
    }
    if (activation.event === "tool_error") {
      const signal = JSON.stringify(activation.signal ?? {});
      const incidental = /ENOENT|no matches found|exit code 1/i.test(signal);
      if (incidental && activation.mainRevision !== current.mainRevision) return false;
    }
    return activation.taskRevision === current.taskRevision;
  },
});
```

Pi persistent agents keep model context in their Fabric-owned Pi session file. Claude persistent agents persist the session ID emitted by the official CLI, reapply tools/permissions/schema/system-prompt flags on every activation, and use `--resume <id>` after the first message; Fabric also keeps a runner-neutral stream transcript instead of reading Claude's private JSONL format. Each persistent agent's reasoning effort is its `thinking` level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), defaulting to `agents.thinking` (`medium`); set it at creation or change it later with `e` from the dashboard. Its `tools` array is a persisted allowlist: set it at creation, replace it with `agents.setTools({ id, tools })`, or press `o` in the dashboard. An empty list disables optional tools; Pi persistent agents retain the host-required `fabric_exec` capability for mailbox and mesh coordination unless created with `extensions: false`. Set `extensions: false` at creation to opt a Pi persistent agent out of Fabric entirely — the activation runs without `fabric_exec`, `agents.*`, or `mesh.*`, while the host still manages its mailbox and delivery. This does not make the persistent agent read-only by itself: `tools` still defaults to `agents.defaultTools`. For a read-only persistent agent, also set `tools: ["read", "grep", "find", "ls"]`; use `tools: []` for a persistent agent with no tools.

### Response modes and delivery

Two response modes are available:

- `text`: every non-empty response becomes a persistent agent outbox message.
- `directive`: validated `{ action: "silent" | "message" | "stop", message?, data? }` output lets the persistent agent decide whether intervention is useful.

Delivery can remain in `mailbox` or enter the main session as `steer`, `followUp`, or `nextTurn`. `steer` and `followUp` require an explicit `triggerTurn: true | false`: `true` starts Main when it is idle, while `false` is passive and is visibly labeled as not starting Main. `mailbox` and `nextTurn` never start Main and reject `triggerTurn: true`. This explicit policy prevents a delivered persistent agent message from looking like a stalled continuation. Fabric no longer imposes an additional 8,000-character truncation on local agent messages from either lifecycle to Main; normal model-context, provider, and cross-mesh event-size limits still apply.

Every completed persistent agent output includes a durable `deliveryReceipt` with independent mesh and Main status, attempt count, timestamp, and error. Accepted queued and in-flight activations are written to the persistent agent's atomic `inbox.json` before acknowledgement and replay at least once under the same activation ID after restart or ownership transfer. Configured one-for-one persistent agent run retry applies only to startup failures with zero turns, tool calls, and token usage; `runAttempts` exposes the outcome, while effectful failures remain terminal. Mesh output publication uses the outbox message ID as an idempotency key. Main delivery retries with configured exponential backoff and jitter; repeated terminal failures open a persisted circuit, suppress delivery during cooldown, and permit one half-open probe. Full inboxes follow the configured reject, source-coalesce, drop-oldest, or dead-letter policy, with explicit terminal records for displaced activation IDs. Use `agents.retryDelivery({ id, messageId })` to retry a still-failed channel explicitly; three failed total attempts dead-letter it.

The persistent agent cannot escalate delivery in its own response, but the owner can update a live persistent agent or global template without losing history:

```ts
await agents.setDeliveryPolicy({
  id: persistentAgent.id,
  delivery: "steer",
  triggerTurn: true,
});
```

Pass `scope: "global"` to update a reusable template. In the dashboard, press `y` on a persistent agent or template to choose among mailbox, passive/active steer, passive/active follow-up, and next-turn delivery. Use `agents.setModel({ id, model? })` and `agents.setThinking({ id, thinking? })` to migrate a persistent agent for its next activation without replacing its Pi/Claude runner session; omit the override to return to configured defaults. Persistent agent creation accepts `budget: { lifetimeActivations?, windowActivations?, windowMs? }`. Admission is checked centrally for direct messages, host events, and mesh topics; counters survive restart and `agents.telemetry()` reports aggregate activations, observed tokens, and quota rejections. Zero or omission means unlimited.

Use `agents.ask()` for a blocking exchange, `agents.tell()` for fire-and-forget mail, `agents.messages()` for history, and `agents.remove()` for cleanup. Direct ask/tell activations participate in the enclosing run's agent/token reservations and inherit its trace parent; finite reservations inject a per-activation `maxTokens` ceiling.

## Paged agent logs

`agents.log()` reads JSONL logs in bounded pages instead of loading the complete file. The first call returns the newest entries. When `hasMore` (or `sessionHasMore` for a persistent agent session) is true, pass the returned `before` (or `sessionBefore`) cursor to load the next older page:

```ts
const newest = await agents.log({ id, type: "run", lines: 100 });
if ("before" in newest && newest.hasMore) {
  const older = await agents.log({ id, type: "run", lines: 100, before: newest.before });
  return older;
}
return newest;
```

Log-line `offset` values and page cursors are byte offsets into the JSONL file.

## Agent templates

Persistent agents live in a project mesh, but a persona worth reusing across projects belongs in a project-independent **template library** stored in your agent dir (`~/.pi/agent/fabric/persistentAgents/`). Templates carry only a persistent-agent definition — name, instructions, subscriptions, and run settings — never any history (mailbox, session transcript, or run logs). They are not live; importing one creates a fresh persistent agent.

```ts
// Save a reusable persona to the global registry (not a live agent).
return agents.create({
  name: "security-reviewer",
  instructions: "Review changes for security defects. Reply with a directive only for material drift.",
  events: ["agent_settled"],
  responseMode: "directive",
  scope: "global",
});

// List templates, then stamp one into the current project as a fresh persistent agent.
const [template] = await agents.templates();
return agents.import({ name: template.name });                       // fresh: no inherited history
return agents.import({ name: "security-reviewer", as: "security-reviewer-2" }); // rename on collision

// Promote a tuned persistent agent back to the global library (no history).
return agents.export({ id: persistentAgentId, overwrite: true });

// Refine a template's default instruction and continuation policy.
await agents.setInstructions({ id: template.id, instructions: "Be brief.", scope: "global" });
return agents.setDeliveryPolicy({
  id: template.id,
  delivery: "steer",
  triggerTurn: false,
  scope: "global",
});
```

`agents.setInstructions` also edits a live project persistent agent (`scope: "project"`, the default); the new instruction takes effect on the persistent agent's next queued message. History never crosses the project⇄global boundary — import and export move only the definition. Slash commands mirror the API: `/fabric global` lists templates, `/fabric import <name> [as <new>]` stamps one into the project, and `/fabric export <id> [--overwrite]` promotes a project persistent agent. The dashboard lists global templates alongside live persistent agents and lets you import, export, delete, edit instructions, and change delivery policy without writing code. Legacy persisted agents/templates still load as passive, but new active delivery definitions must state `triggerTurn` explicitly.

## Outcomes and evaluation

When enabled, terminal Fabric executions and ambient persistent agent activations append bounded derived metrics without prompts, result bodies, media, gate reasons, or judge prose. `outcomes.list/status` reads them. `outcomes.evaluate` appends exact, contains, or numeric fixture verdicts. `outcomes.judge` stores only an external model score/verdict. `outcomes.recommend` withholds candidates below `outcomes.minRecommendationSamples`, reports quality/cost/latency plus Wilson confidence bounds, and never changes model defaults automatically.

## Councils

```ts
return council.run({
  task: "Review the current implementation and recommend whether it is ready to merge.",
  roles: ["correctness reviewer", "security reviewer", "test reviewer"],
  transport: "localterm",
  synthesize: true,
});
```

Council members run concurrently under the global agent semaphore. With `synthesize: true`, a final child agent reconciles their reports. See [`/skill:fabric-council`](../skills/fabric-council/SKILL.md).

## Recursive queries

```ts
return rlm.query({
  runner: "pi",
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` is `agents.run({ runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are intentionally rejected for recursive Fabric. Recursion is rejected at `agents.maxDepth`. Approval of the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own configured concurrency and timeout limits. When `agents.budgetUsd` is set, a shared append-only cost ledger bounds total spend across the whole recursion tree: every node records the cost of the children it spawns into one ledger file inherited via environment, and each node rejects a new child when the accumulated spend reaches the budget. The check is best-effort (concurrent children can each pass before any cost lands, so a tree may slightly overshoot); the race-free ceiling remains `agents.maxPerExecution`. The result and live status of every recursive child carry a `budget` summary (`limit`, `spent`, `remaining`, `tokens`). Fabric also keeps the latest bounded nested-agent status tree in memory, so completed recursive leaves remain visible in **Topology · Run** after the child process removes its temporary nested run directories. The snapshot is released when the parent run is cleaned up or the Fabric session shuts down.

`agents.maxTokensPerChild` (0 = disabled) bounds each child's cumulative token usage. The wall-clock `timeoutMs` and the cost `budgetUsd` bound time and money; this bounds a single runaway child's context before the host session compacts, terminating it with the same `timed_out` status and a `token limit` error. See [`/skill:fabric-rlm`](../skills/fabric-rlm/SKILL.md).

## Durable mesh coordination

The `mesh` API is a project-scoped, event-sourced coordination substrate:

```ts
const event = await mesh.publish({
  topic: "team.auth",
  kind: "finding",
  text: "Refresh-token rotation is not atomic",
  data: { path: "src/auth/refresh.ts" },
});

const task = await mesh.put({
  key: "tasks/auth-review",
  value: { status: "ready", owner: null },
  ifVersion: 0,
});

const claimed = await mesh.put({
  key: task.key,
  value: { status: "claimed", owner: "security-reviewer" },
  ifVersion: task.version,
});
return { event, claimed };
```

Topics provide durable channel and direct-message semantics with sequence cursors. `mesh.members({ scope?, kinds? })` returns the same unified participant directory as `agents.members()`. Versioned `get`/`put`/`delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. Together with persistent agents, these are sufficient to express messenger-style swarms in Fabric code without a daemon or fixed planner/worker roles. See [`/skill:fabric-swarm`](../skills/fabric-swarm/SKILL.md) for the pattern and [`references/mesh.md`](../skills/fabric-exec/references/mesh.md) for the full API.
