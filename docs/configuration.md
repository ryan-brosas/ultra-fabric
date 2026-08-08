# Configuration

Pi Fabric reads configuration from two JSON files. Project values override global values.

1. `~/.pi/agent/fabric.json` — global defaults.
2. `<project>/.pi/fabric.json` — project overrides, only for **trusted** projects.

`/fabric settings` writes changes to the same files: trusted projects write to `<project>/.pi/fabric.json`; untrusted sessions write to the global `~/.pi/agent/fabric.json`.

Configuration documents are versioned with `configVersion`. Fabric migrates each applicable file independently before applying global/project precedence, then atomically rewrites migrated files. Version 0—the historical unversioned format—migrates its removed child-Agent section to `agents`; when both sections exist, `agents` wins conflicts while non-conflicting values are preserved. Trusted project files are migrated, while untrusted project files are neither read nor rewritten. Future schema changes should be added as sequential migrations rather than runtime aliases.

`executor.runtime` selects `"quickjs"` (the default isolated WASM runtime) or `"node-process"` (a disposable native V8 process). QuickJS memory limits are capped at `4294967295` bytes because its WASM32 `size_t` cannot represent 4 GiB; larger values are rejected rather than wrapped. Node process limits may be set as high as detected physical memory and are passed to V8 as `--max-old-space-size`.

`node-process` is an explicit trusted-code escape hatch, not a security sandbox. It preserves Fabric's IPC host bridge, approvals, audit records, timeout, and cancellation, but Node's `vm` API is not a security boundary. Enable it only for workloads and projects whose generated code you are willing to run with the local user account's authority. Each invocation receives a fresh child process and is forcibly terminated when it settles, times out, or is cancelled. Schema enforce mode always forces `quickjs`. Large limits in either runtime can exhaust system memory or destabilize the machine.

## Full reference

```json
{
  "configVersion": 3,
  "fullCodeMode": true,
  "executor": {
    "runtime": "quickjs",
    "timeoutMs": 120000,
    "memoryLimitBytes": 67108864,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000,
    "maxGateRevisions": 2,
    "maxRunEvidence": 256,
    "maxRunTransitions": 512,
    "resultFormat": "auto"
  },
  "approvals": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "network": "allow",
    "agent": "allow"
  },
  "capture": {
    "enabled": true,
    "hideFromModel": true,
    "keepVisible": ["fabric_exec"],
    "defaultRisk": "execute",
    "risks": {
      "read": "read",
      "grep": "read",
      "find": "read",
      "ls": "read",
      "edit": "write",
      "write": "write",
      "bash": "execute"
    }
  },
  "mcp": {
    "enabled": true,
    "disableOAuth": true,
    "allowDynamicServers": true,
    "callTimeoutMs": 120000
  },
  "prewalk": {
    "alwaysRearm": true,
    "triggerRisks": [],
    "triggerEffects": ["workspace"],
    "triggerRefs": ["pi.edit", "pi.write", "schema.commit", "fabric.prewalk.checklist"]
  },
  "agents": {
    "enabled": true,
    "runner": "pi",
    "transport": "process",
    "fallbackModels": [],
    "allowQualityDowngrade": false,
    "requireAdmissionIntent": false,
    "capabilityProfiles": {},
    "claude": {
      "binary": "claude"
    },
    "thinking": "medium",
    "maxConcurrent": 4,
    "maxPerExecution": 100,
    "maxDepth": 2,
    "timeoutMs": 3600000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "retainRuns": false,
    "notifyOnComplete": true,
    "budgetUsd": 0,
    "maxTokensPerChild": 0
  },
  "consult": {
    "enabled": true,
    "maxWorkers": 3,
    "contextPressureThreshold": 0.6,
    "maxFindingsPerWorker": 8,
    "maxEvidencePerFinding": 8,
    "maxEvidenceFileBytes": 2097152,
    "maxEvidenceBytesPerConsult": 8388608,
    "maxTokensPerWorker": 8000
  },
  "ui": {
    "enabled": true,
    "widget": "auto",
    "maxRows": 6,
    "refreshMs": 500,
    "eventHistory": 80,
    "haltOnEscape": true,
    "showNestedToolCalls": true,
    "nestedToolDebounceMs": 100
  },
  "compaction": {
    "engine": "fabric",
    "cooldownMs": 0
  },
  "quality": {
    "mode": "off",
    "maxOutputChars": 20000,
    "maxProbeBytes": 8192,
    "ignoredLanguages": ["binary"],
    "languageOverrides": {},
    "checks": []
  },
  "outcomes": {
    "enabled": true,
    "maxRecords": 1000,
    "minRecommendationSamples": 5
  },
  "retention": {
    "orphanedTempRunMs": 21600000,
    "oneShotRunMs": 86400000,
    "persistentAgentRunArchiveMs": 604800000
  },
  "mesh": {
    "enabled": true,
    "persistentAgentScope": "project",
    "maxEventBytes": 262144,
    "maxReadEvents": 500,
    "persistentAgentPollMs": 250,
    "persistentAgentQueueLimit": 32,
    "persistentAgentOverflowPolicy": "reject",
    "persistentAgentRunMaxAttempts": 1,
    "persistentAgentRunBaseDelayMs": 250,
    "persistentAgentRunMaxDelayMs": 5000,
    "persistentAgentRunJitterMs": 100,
    "persistentAgentDeliveryMaxAttempts": 3,
    "persistentAgentDeliveryBaseDelayMs": 100,
    "persistentAgentDeliveryMaxDelayMs": 2000,
    "persistentAgentDeliveryJitterMs": 50,
    "persistentAgentCircuitFailureThreshold": 3,
    "persistentAgentCircuitCooldownMs": 30000,
    "eventContextChars": 40000,
    "persistentAgentContextEntries": 14
  }
}
```

## Prewalk executor

Prewalk trigger matching is host-owned. `prewalk.triggerEffects` defaults to `["workspace"]`; `prewalk.triggerRefs` preserves `pi.edit`, `pi.write`, `schema.commit`, and `fabric.prewalk.checklist` (so checklist acceptance alone claims the handoff boundary). Optional `prewalk.triggerRisks` is broad and defaults empty because write-risk state bookkeeping is not necessarily a workspace mutation. A successful audit triggers when any configured set matches. Captured/external mutations participate when they declare `effect: "workspace"` or are named explicitly. Bash stays opaque unless explicitly named.

`prewalk.model` is the optional Pi `provider/model` selected by `/fabric prewalk`. Prewalk runs one in-session path: the frontier model plans and submits a checklist, then the host hands the same Main session to the executor for implementation and verification, then restores the frontier model on settle.

`prewalk.autoScout` defaults to `false` (explicit opt-in): when enabled, a cheap scout pass injects a bounded 2k-character context brief before planning, with spend attributed in the budget ledger under `prewalk:scout`; without a host scout runner the pass is skipped and never blocks arming. The prewalk prompts carry no delegation discipline — recon and research stay on Main, and support roles or `consult.run` workers run only on explicit request. The learning and retirement levers — `prewalk.reuseChecklists`, `prewalk.failureMemory`, and `prewalk.handoffRetirement` — remain opt-in pending the Slice 8 benchmark gate. See [agents](agents.md#automatic-prewalk) for the full lever semantics.

`codemap.cgc` (default off) enables the read-only CodeGraphContext bridge on the codemap tool: `enabled: true`, optional `context` (a path prefix such as `<root>/inspo/<repo>` that scopes the cypher queries via `STARTS WITH`, or a registered CGC named context), and `timeoutMs` (default 30000). The bridge is a separate namespace: CGC results never merge into the project's ast-grep graph, so reference symbol names cannot collide with project ones. See [code map research](code-map-research.md#cgc-reference-mode).

The arming instruction asks Main to call `prewalk.checklist({ items })` inside `fabric_exec` with 5-9 ordered items. Every item needs a concrete task and a specific validation. The host rejects matching mutations until the checklist is accepted, so the executor inherits a validated plan. A gated verification revision keeps its scoped feedback instead, because that revision must stay narrow.

```json
{
  "prewalk": {
    "model": "anthropic/claude-haiku-4-5",
    "fallbackModels": ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
    "thinking": "high",
    "alwaysRearm": true
  }
}
```

`prewalk.fallbackModels` is an optional ordered list of at most eight unique Pi `provider/model` keys. The host tries each model in order before switching Main, so a configured fallback covers model outages without losing the session. The selected fallback is visible in the result and lifecycle. A failed switch does not retry automatically, because the executor may already have changed the workspace.

`prewalk.thinking` is the optional reasoning effort (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`) for the in-session executor, clamped to each model's supported levels. When unset, the executor inherits `agents.thinking`.

`prewalk.alwaysRearm` defaults to `true`. Each re-arm reads the configuration in force at that moment, so changing `prewalk.model` between tasks takes effect on the next arm rather than repeating the arm that just finished. When enabled (the default), prewalk returns to an armed, taskless state after the matching hidden continuation reaches `agent_settled` or after a triggerless task settles. It does not re-arm inside the continuation's own work. Set it to `false` for one-shot arming: the single arm stays armed across turns until it claims its first mutation, is superseded by an explicit handoff, or is cancelled, so a later write in the same session can still hand off. A failed handoff enters a blocked state that preserves its task and attempt. It never retries automatically. Use `/fabric prewalk --status` to inspect the failure and `/fabric prewalk --retry` after correcting it. The settings UI labels an unset model **Ask each time**. Non-interactive sessions must configure a model. Prewalk does not spawn a child agent and does not require `agents.enabled`.

Set `prewalk.verificationMode` to `"gated"` to require an identity-owned verification continuation to finish through `workflow.gate()`. A passing evidence gate settles the task; `revise` returns only scoped failure evidence to the executor; abort, crash, missing evidence, or exceeding `prewalk.maxPhaseRevisions` blocks without losing task intent. The compatibility default remains prompt-only verification when the field is omitted. `maxPhaseRevisions` defaults to 2 and is bounded to 0–8.

Prewalk always restores Main to its original model once the identity-owned continuation settles, so the frontier and executor alternate per task. An unavailable or unauthenticated return model is reported visibly and the completed task is not rerun.

## Run context and gates

Every `fabric_exec` creates one bounded run envelope with run, trace, span, optional parent, objective digest, deadline, and cancellation-owner identity. The envelope crosses provider and child-agent boundaries; recursive Pi children and direct persistent Agent ask/tell activations inherit the same trace. Host calls that legitimately extend the sandbox timeout also extend the immutable envelope snapshot monotonically before provider invocation. `executor.maxRunEvidence` bounds evidence refs; `executor.maxRunTransitions` bounds both typed transitions and ordered gate results, with terminal entries replacing the last non-terminal entry when necessary. `executor.maxGateRevisions` bounds failed `revise` dispositions; an unresolved revision prevents successful settlement, while a crashed gate aborts as infrastructure failure.

A finite per-call `tokenBudget` is admission-enforced rather than merely observed. Concurrent agent calls reserve before invocation and each child receives a hard `maxTokens` ceiling. Sequential calls reclaim unused reserved tokens. The existing `agents.budgetUsd` ledger remains settlement-based because model cost has no defensible hard pre-run estimate.

## Quality enforcement

`quality.mode` is `"off"`, `"audit"`, or `"enforce"`. The default is `"off"`. Valid checks name one executable, an argv array, one or more detected language IDs, `fileMode: "append" | "none"`, and a bounded timeout. Commands from a project file load only when Pi trusts that project.

After an eligible successful `fabric_exec` mutation, Fabric detects the final changed-file languages, runs matching checks serially with no shell, and records a host-owned `quality` gate. Audit failures add a warning while enforce failures make the result unsuccessful. Uncovered languages block enforce mode. Binary files are ignored by default and unknown text is not.

Automatic attribution is limited to successful `pi.write`, `pi.edit`, and committed `schema.commit` paths inside the execution cwd. Shell effects, direct orchestration-only tools, child-agent writes, and concurrent processes are not guessed. See [quality enforcement](quality.md) for the full configuration, HTML and CSS examples, built-in language IDs, bounds, and limitations.

## Result formatting

`executor.resultFormat` sets the default for `fabric_exec` return values and is available under `/fabric settings` → **Executor**. `"auto"` keeps strings as text and renders structured values as syntax-highlighted YAML. `"yaml"`, `"json"`, and `"text"` force the corresponding behavior. A call-level `resultFormat` parameter overrides the configured default.

The compaction engine is available under `/fabric settings` → **Compaction**. Select `"fabric"` for Fabric-owned model routing with a deterministic portable summary, or `"pi"` to delegate to Pi core.

## Code modes

With the default full code mode, `fabric_exec` exclusively owns Pi core tool execution. The parent model sees one programmable tool instead of direct `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` schemas. Fabric programs use those capabilities through `pi.*`:

```ts
const files = await pi.find({ pattern: "**/*.ts", path: "src" });
const matches = await pi.grep({ pattern: "TODO", path: "src" });
return { files, matches };
```

Independent calls should be parallel:

```ts
const [packageJson, readme] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.read({ path: "README.md" }),
]);
return {
  package: JSON.parse(packageJson).name,
  readmeLines: readme.split("\n").length,
};
```

Pi core calls reject when the native tool reports an error; the `{ ok: true, output, details }` shape describes successful `bash`, `edit`, and `write` calls. Catch a rejection when recovery is local. `bash` rejects on an ordinary nonzero exit; pass `settle: true` (for example `pi.bash({ command, settle: true })`) to get `{ ok: false, output, details: null, exitCode, error }` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject.

### Full code mode (default)

`fullCodeMode: true` is the default. Fabric removes active Pi core tools from the parent model and exposes their implementations only inside `fabric_exec` through `pi.*`. Registered overrides such as security gates and code previews are captured too, so `pi.read()` continues to route through the override rather than bypassing it.

Fabric remembers which native core tools were active before taking ownership. Switching to orchestration-only mode or unloading Fabric restores that selection. Full-mode ownership is applied only when the session initializes or the mode changes. Fabric does not reset an explicitly selected active tool set from input, agent-start, turn-end, or settled lifecycle hooks; the system prompt carries the full-mode execution rule.

Pi core normally includes its model-visible skill catalog only while the native `read` tool is active. Full code mode instead restores a bounded view from Pi's structured registry: up to 12 task-relevant model-invocable descriptions plus a compact name/root index capped at 8,000 characters for on-demand discovery. The loader instruction uses `pi.read` inside `fabric_exec`, and native core tools remain hidden. Packaged skills mark cross-document paths with `<skill-dir>`; Fabric replaces that marker inline from Pi's expanded skill `location` or the actual `SKILL.md` read path, without matching skill names or enumerating directories. Ordinary document reads are unchanged. When an expanded skill invokes another installed skill, Fabric also adds an exact name-to-path resolution hint for that turn so the delegated `SKILL.md` is loaded before task work.

### Orchestration-only mode

Users who want Fabric for MCP, agents, ambient persistent Agents, parallel workflows, councils, and recursive delegation — but want Pi's core tools to remain entirely native — can opt out of full code mode:

```json
{
  "fullCodeMode": false
}
```

In orchestration-only mode:

- Pi's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on Pi's normal model-facing and execution paths. Fabric applies the configured risk approval policy through Pi's native `tool_call` preflight without replacing their execution or rendering.
- Registered extension tools also remain in Pi's native registry; Fabric does not hide, wrap, or expose them through `extensions.*`. Model-requested direct calls use exact `capture.risks` overrides or the conservative `capture.defaultRisk` approval class.
- `pi.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, including when TypeScript checks are bypassed.
- MCP and stable Fabric providers remain available through `mcp.*`, `memory.*`, `state.*`, `schema.*`, and `compact.*`; generic discovery and computed refs remain available through `tools.*`. One-shot and recursive agents, persistent ambient persistent Agents, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI also remain available.
- Child agents continue using their allowed Pi tools directly, so parallel and ambient setups do not route their coding operations back through Fabric code mode.

### Where to set it

`fullCodeMode` defaults to `true`. A project can set the flag in `.pi/fabric.json`, or a user can set it globally in `~/.pi/agent/fabric.json`. `/fabric settings` toggles it too.

## Captured extension tools

When `fullCodeMode` is enabled, Fabric intercepts Pi's `ExtensionRunner.getAllRegisteredTools()` registry chokepoint. This captures tools registered by other extensions at startup or later through `pi.registerTool()`, regardless of whether those extensions load before or after Fabric.

Captured custom tools are removed from Pi's model-facing registry by default, so their schemas, snippets, and guidelines do not consume the parent model context. The extension itself remains loaded: its commands, event handlers, state, and UI continue to work. Only tool discovery and invocation become lazy.

```ts
const matches = await tools.search({ query: "deployment status" });
const schema = await tools.describe({ ref: matches[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { environment: "staging" },
});
return result;
```

For tool names valid as JavaScript properties, use the shorter proxy:

```ts
const result = await extensions.project_status({ verbose: true });
return result.text;
```

The result preserves `content`, text content as `text`, `details`, `isError`, `terminate`, and source provenance. Fabric runs the captured definition's `prepareArguments()` and original executor with its owning extension context. Pi's `tool_call`, `tool_result`, and `tool_execution_*` lifecycle handlers are also applied to nested captured calls.

Extension overrides of core tools are captured and hidden with their built-in counterparts in full code mode. Inside Fabric, `pi.read`, `pi.bash`, and the other built-ins automatically route through a captured override when one exists; `extensions.read` exposes the override's full native result shape. `capture.keepVisible` can retain non-core extension tools in Pi's direct registry, but core tool names are always excluded while full code mode owns them.

## Approvals and risk

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`; approval policy values are `allow`, `ask`, `auto`, or `deny`. Policies apply both to actions invoked inside `fabric_exec` and to top-level model-requested tools left on Pi's native path. Native calls keep Pi's original implementation, result shape, and renderer; only the supported pre-execution interception hook is added.

- Captured and directly registered tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`.
- Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them.
- `capture.keepVisible` names stay in both Fabric and Pi's direct registry, except that Pi core names are always Fabric-owned in full code mode.
- An `ask` policy emits a warning notification and opens an explicit **Allow once** / **Allow for this session** / **Deny** permission prompt, matching Claude-style approval scopes. **Allow once** authorizes only the requested action. **Allow for this session** authorizes that risk class until the current Pi session ends. The TUI uses an inline wizard; RPC clients receive the equivalent `select` dialog.
- Concurrent requests are serialized so a one-time approval never silently widens to sibling calls. Session-wide grants are shared between native calls and `fabric_exec`. Escape, dismissal, unavailable interactive UI, and session restart all fail closed.

### Auto approval mode

An `auto` policy routes each validated call and its prepared arguments through a separate Pi model before invocation. Configure **Auto model** under `/fabric settings` → **Approvals**, or set the optional canonical `provider/model` key in `fabric.json`:

```json
{
  "approvals": {
    "model": "anthropic/claude-opus-4-6",
    "write": "auto",
    "execute": "auto",
    "network": "auto",
    "agent": "auto"
  }
}
```

Choosing **Inherit** in the model picker omits `approvals.model` and uses the active Pi session model. Built-in and custom models dispatch through Pi's effective provider runtime, including providers with custom API identifiers; older supported Pi versions fall back to their compatibility provider registry. Read access remains independently configurable and is normally left as `allow`.

The classifier receives the exact action, bounded prepared arguments, cwd, user-message text, and assistant tool calls. Assistant prose and tool outputs are excluded so model-authored reasoning and retrieved hostile content cannot directly instruct the classifier. It has no executable tools and must return a structured `allow` or `escalate` verdict. `allow` applies only to that call. `escalate`, malformed output, missing authentication, timeout, cancellation, or any classifier error falls back to the explicit **Allow once** / **Allow for this session** / **Deny** prompt; headless runs fail closed when that prompt cannot be shown. Classifier token usage and cost are attached to the resulting `fabric_exec` or native tool result, and Fabric execution traces record each nested verdict as `fabric.approval.auto`.

`deny` remains deterministic and is evaluated before the classifier. Schema enforcement, project trust, budgets, and other host gates also remain authoritative. Auto mode is a model-based policy advisor, not a stronger sandbox boundary. Its initial conservative policy escalates destructive or irreversible actions, shared/external/production changes, credential or sensitive-data exposure, safety bypasses, actions beyond explicit user intent, and actions whose safety is uncertain. This follows the architecture described in Claude Code’s [permission modes](https://code.claude.com/docs/en/permission-modes), [auto-mode configuration](https://code.claude.com/docs/en/auto-mode-config), and Anthropic’s [auto-mode engineering write-up](https://www.anthropic.com/engineering/claude-code-auto-mode), adapted to Pi’s model registry and Fabric’s existing per-risk policy gate.

## Temporal retention

Fabric clears inactive run artifacts by age rather than truncating active JSONL files. The defaults are:

- `retention.orphanedTempRunMs` — remove a temporary run root six hours after its owner process dies. Active roots carry a heartbeat marker and are never removed.
- `retention.oneShotRunMs` — retain terminal one-shot agent run artifacts for 24 hours. Explicit `agents.cleanup()` may remove them sooner; otherwise graceful shutdown marks their temporary root closed for temporal cleanup.
- `retention.persistentAgentRunArchiveMs` — retain terminal persistent-agent run archives for seven days. The latest run for each persistent agent is always preserved.

Cleanup runs during active Fabric sessions and when a new top-level run manager starts. It never truncates active run logs or persistent-agent `session.jsonl` files. `/fabric settings` exposes all three values under **Retention**; changing them requires `/fabric reload`.

## Agents

`agents.runner` selects the default harness (`"pi"` or `"claude"`). `agents.model` is the optional Pi `provider/id` override; `agents.claude.model` is the optional canonical Claude runtime key. `agents.claude.binary` defaults to `claude` and can be an absolute path or wrapper; `PI_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary in the background and stores the two runner defaults independently.

`agents.fallbackModels` is an ordered list of at most eight Pi `provider/id` alternatives. A run or handoff opts into host routing by supplying `requirements` and/or `fallbackModels`. Requirements can constrain `input` (`text`/`image`), reasoning support, minimum context/output limits, and maximum input/output cost rates. Fabric checks model-registry availability and authentication before launch. Capability-preserving routes are automatic. A route that loses context, output ceiling, reasoning, or modalities is blocked unless host config sets `agents.allowQualityDowngrade: true`. A request may narrow that policy with `allowQualityDowngrade: false` but cannot elevate it. Handles and results include a typed route decision with bounded rejection reasons.

Fabric worker processes are JavaScript modules launched by a JS runtime. When Pi runs as a generic Node.js or Bun runtime (`process.execPath` is `node`/`bun`), that runtime is reused. When Pi ships as a Bun-compiled single-file binary (`process.execPath` is the `pi` executable, not node/bun), Fabric resolves a runtime from `PI_FABRIC_NODE_BINARY`, otherwise from the first `node` or `bun` on `PATH`, and only the resolved runtime launches workers — never the bundled binary itself. `PI_FABRIC_NODE_BINARY` overrides this for the current process. The Node-process executor (`executor.runtime: "node-process"`) always requires Node.js specifically, since its `--eval`/`--input-type=module` flags are Node-only.

Admission and capability controls:

- `requireAdmissionIntent` — when true, every one-shot run/spawn/handoff must declare `admission.reason` and `expectedArtifact`. The bounded reasons are independent context, separable parallel work, capability gap, long-running work, and independent verification.
- `capabilityProfiles` — named host profiles with fixed `tools` and recursive `risks`. A request supplies only the profile name; it cannot elevate that profile. Recursive workers receive the profile grants through the existing inherited-risk boundary.
- `fallbackModels` / `allowQualityDowngrade` — ordered capability-aware routing and host-only downgrade permission.

Other agent settings:

- `thinking` — default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), default `medium`.
- `maxConcurrent` — global child concurrency semaphore.
- `maxPerExecution` — hard cap on children per `fabric_exec` invocation.
- `maxDepth` — recursion depth bound for `rlm.query()`.
- `timeoutMs` — default per-child wall-clock budget and floor for per-call overrides (60 minutes by default). Lower per-call values are ignored; callers should only set `timeoutMs` to request a longer run.
- `extensions` — whether ordinary child runners load their normal extensions/customizations. It defaults to `true`; Pi model-provider plugins require it. Recursive Pi children force it on, while `false` starts Claude in safe mode and Pi with `--no-extensions`.
- `defaultTools` — the default tool allowlist for children.
- `budgetUsd` — shared append-only cost ledger across a recursion tree (0 disables).
- `maxTokensPerChild` — per-child cumulative token bound (0 disables).
- `notifyOnComplete` — send a follow-up completion message for a detached `agents.spawn()`.

See [agents & mesh](agents.md) for the runner and transport details.

## Ultra Consult

`consult.run()` is enabled by default and admits up to `consult.maxWorkers` (3 by default) per call, gated by justification, non-overlapping scopes, and the parent agent budget. It is a core context-management primitive, not a permission bypass: every admitted child consumes the normal execution agent/token reservation, is fixed to the Pi runner, receives only read/grep/find/ls, has extensions and recursion disabled, and cannot mutate the workspace.

- `enabled` — disables admission entirely when false.
- `maxWorkers` — one-call worker ceiling, clamped to 1–3 and further limited by the parent execution's remaining agent budget.
- `contextPressureThreshold` — occupancy ratio for unscoped `context_capacity` requests, clamped to 0.25–0.95. Explicit non-overlapping path partitions can be admitted before the threshold.
- `maxFindingsPerWorker` — accepted structured findings per worker, clamped to 1–16.
- `maxEvidencePerFinding` — candidate file addresses per finding, clamped to 1–16.
- `maxEvidenceFileBytes` — maximum bytes read from one file when validating cited line ranges, clamped to 1 KiB–16 MiB.
- `maxEvidenceBytesPerConsult` — cumulative descriptor-read ceiling across unique evidence files in one Consult, clamped to 1 KiB–64 MiB. Repeated citations reuse the cached file snapshot.
- `maxTokensPerWorker` — per-child ceiling before any smaller execution-wide token reservation is applied, clamped to 256–1,000,000.

One parent `fabric_exec` may attempt Consult once. A declined admission returns `status: "not_admitted"` with a machine-readable code and starts no child. Settings apply live; the **Ultra Consult** page in `/fabric settings` exposes every field.

## Outcomes and path leases

`outcomes.enabled` records derived terminal metrics in project mesh state. `maxRecords` bounds capacity and `minRecommendationSamples` prevents route recommendations from appearing early. Records contain identity digests, verdict, duration, usage, routes, admission reasons, optional prompt-free Consult coverage/context/cost metrics, and scores, never prompts, result bodies, Consult findings, media, gate reasons, or judge prose.

`leases.acquire`, `leases.release`, and `leases.list` are runtime APIs rather than static config. Active file/tree leases are owned by the current run and block foreign `pi.edit`/`pi.write` calls before mutation. They do not inspect shell commands; use worktrees for untrusted or opaque writers.

## MCP

- `mcp.disableOAuth` — when true, MCP calls may use cached credentials but cannot launch a new interactive OAuth flow.
- `mcp.callTimeoutMs` — per-call timeout bound.
- `mcp.allowDynamicServers` — permit `mcp.register()` of ephemeral servers.
- `mcp.enabled` — set to `false` to disable the MCP surface.

See the [`mcp` reference](../skills/fabric-exec/references/mcp.md) for the call surface.

## UI

- `ui.widget` is `auto`, `always`, or `hidden`. `auto` shows active or retained Fabric runs and worker activity. Active one-shot agents and persistent Agent workers occupy rows; their recent nested tools appear beneath them when enabled.
- `ui.showNestedToolCalls` defaults to `true` and controls one-shot/persistent-agent tool rows in both the parent `fabric_exec` card and widget.
- `ui.nestedToolDebounceMs` defaults to `100` and applies one execution-wide coalescing interval across regular nested calls. Continuous streams emit at most once per interval instead of postponing every render until completion. Set it to `0` to emit every update; accepted values are clamped to `0..2000`.
- The widget renders above the chat (like `pi-supervisor`); set `ui.enabled` to `false` to disable both the widget and dashboard controller.

See the [interface reference](interface.md).

## Mesh

Mesh data defaults to `<project>/.pi/fabric/mesh`. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and persistent Agent sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless the coordination log is intentionally versioned. Set `mesh.enabled` to `false` to disable both mesh actions and ambient persistent Agent restoration.

`mesh.persistentAgentScope` controls where persistent agent definitions, mailboxes, and child sessions are stored and restored from:

- `"project"` (default) keeps a shared persistent Agent registry at `.pi/fabric/mesh/persistentAgents/`, so persistent Agents survive `/new`. The participant directory chooses each live execution owner; other sessions keep passive views and reload on takeover. Registry writes are lock-serialized and merge only locally owned persistent Agent records.
- `"session"` isolates persistent Agents per Pi session (under `.pi/fabric/mesh/persistentAgents/<sessionId>/`). Use this when you run concurrent Pi sessions in one project and want each to own its own persistent Agents.

Each persistent agent writes accepted queued and in-flight activations to its atomic `inbox.json` before acknowledging them. Interrupted in-flight work re-enters the queue under the same ID. `mesh.persistentAgentQueueLimit` bounds pending activations. `mesh.persistentAgentOverflowPolicy` is `"reject"` (default), `"coalesce"` by source, `"drop-oldest"`, or `"dead-letter"`; displaced work gets an explicit terminal mailbox record rather than silent loss.

Zero-effect persistent Agent startup failures can retry one-for-one under `mesh.persistentAgentRunMaxAttempts` (default 1) with `mesh.persistentAgentRunBaseDelayMs`, `mesh.persistentAgentRunMaxDelayMs`, and `mesh.persistentAgentRunJitterMs`. Fabric retries only when the failed run reports zero turns, zero tool calls, and zero token usage; any observable model/tool activity remains terminal to avoid replaying possible effects. The resulting outbox message records `runAttempts`.

Persistent Agent output delivery uses `mesh.persistentAgentDeliveryMaxAttempts` with exponential delay from `mesh.persistentAgentDeliveryBaseDelayMs`, capped by `mesh.persistentAgentDeliveryMaxDelayMs`, plus up to `mesh.persistentAgentDeliveryJitterMs` jitter. Mesh publication is deduplicated by the persistent Agent outbox message ID. Exhausted channels become dead letters. After `mesh.persistentAgentCircuitFailureThreshold` terminal Main-delivery failures, the persisted circuit opens for `mesh.persistentAgentCircuitCooldownMs`; one half-open probe then closes or reopens it.

`mesh.eventContextChars` bounds the sanitized JSON context attached to each host-event activation. Images are extracted before this bound, represented by redacted descriptors in persistent Agent mailboxes and the registry, and forwarded out of band to the persistent Agent runner automatically; the configured character bound does not truncate their base64.

With project scope, each persistent Agent has one lifecycle owner and shared registry updates are ownership-aware and lock-serialized. Mesh topics, shared state, and the participant directory are always project-scoped. Every Fabric runtime publishes one short-lived host lease plus canonical records for the roots, agents, and persistent Agents it owns. `agents.members()` and `mesh.members()` read that directory; `agents.main()` and `agents.peers()` are root projections. If a host lease expires, all of its participant records disappear from normal discovery together. `mesh.persistentAgentPollMs` controls the fallback interval for persistent Agent events and owner-addressed control commands when filesystem notifications are unavailable.

## Compaction

The Fabric compaction controller is default-on. It always creates a deterministic, LLM-free portable summary; official OpenAI Responses models also receive a provider-native opaque artifact, exact Claude bridge models delegate to the bridge takeover, and other models use only the deterministic result. OpenAI native compaction can incur provider charges and persists its opaque artifact in the local session. Set `compaction.engine` to `"pi"` to restore pi-core compaction. When pi-vcc is also installed, Fabric takes precedence for automatic compaction, while an explicit `/pi-vcc` command always uses pi-vcc's engine. See [compaction](compaction.md) for routing, invariants, data handling, sections, and limits.
