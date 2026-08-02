---
name: fabric-exec
description: >-
  Troubleshooting and advanced API reference for `fabric_exec` TypeScript
  programs, dynamic providers, agents, and schema recovery. Routine `pi.*`
  coding calls are documented by ambient guidance; load this skill only after
  an argument-shape error or when an advanced surface needs exact contracts.
---

# fabric_exec — core reference

One type-checked TS program in a fresh executor (isolated QuickJS by default). Only the `return` value reaches the model; `print()`/`console.log` go to the activity panel. `π` is not a tool.

## `pi` core tools (full code mode only)
`pi.<tool>(arg)` — single arg: bare string (primary field) or options object. Multi-arg positional calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`); one-field tools (`read`/`bash`/`ls`) stay single-arg — a 2-arg call on those is a type error so the extra arg isn't silently dropped.

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` | `string` |
| `bash` | `command` \| `{command,timeout?}` | `{ok:true,output,details}`; rejects on a nonzero exit (`settle:true` returns `{ok:false,output,details:null,exitCode,error}` instead) |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` | `string` |
| `edit` | `{path,edits:[{oldText,newText,all?}],all?}` \| `{path,oldText,newText,all?}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

For `pi.edit`, entry-level `all:true` applies that replacement to every non-overlapping occurrence; top-level `all:true` applies every entry that way. Omit it for unique anchors.

`bash` rejects on an ordinary nonzero exit; pass `settle:true` to get `{ok:false,output,details:null,exitCode,error}` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject. Other Pi core tool errors reject normally.

Aliases (normalized to canonical before the host validates args): `cmd`/`shell`/`cmdline`→`command`; Bash `timeout` is in seconds, while `timeoutMs` is converted from milliseconds to `timeout`; `query`/`regex`/`search`→`pattern`; `ic`/`caseInsensitive`→`ignoreCase`; `globPattern`→`glob`; `ctx`→`context`; `max`→`limit`; `file`/`dir`→`path`; `start`→`offset`; `old`→`oldText`; `new`/`replacement`→`newText`; `contents`/`body`/`text`→`content`. Misspelled keys still fail the excess-property type check.

## Read economy

Search before reading. Run `pi.grep`/`pi.find` first, then `pi.read({ path, offset, limit })` the matching range instead of unbounded whole-file reads:

```ts
// Locate the symbol, then read only the window around the hit.
const hits = await pi.grep({ pattern: "targetSymbol", path: "src", context: 2 });
const window = await pi.read({ path: "src/engine.ts", offset: 120, limit: 80 });
```

An unbounded `pi.read('/x')` returns at most 2000 lines or 50KB (whichever is hit first); truncated output ends with a `[Showing lines a-b of N. Use offset=n to continue.]` notice — continue with `offset` only when you truly need the full file. Reserve whole-file reads for small files you will use in full (configs, tests or files you are about to edit, sources under a few hundred lines). Batching several large whole-file reads into one program inflates the single tool result, and that enlarged result stays in every later turn's context.

Keep multiline or syntax-heavy payloads out of `code`: pass them through `strings` and read `π.key` (for example, `await pi.write("path", π.content)`). TypeScript still parses template-literal contents, including shell heredocs.

## First-class provider calls
Use direct proxies when the action is known. No-argument actions such as `schema.status()`, `state.get()`, and `compact.status()` take no options object. Provider calls still cross the same registry validation, approval, audit, timeout, and cancellation path as generic calls.

### Stable provider return shapes

All calls return promises. Fields ending in `?` are optional; `unknown` marks provider data whose nested schema is not stable at this surface.

| Call | Resolves to |
|------|-------------|
| `memory.recall(args?)` | `{scope?,branches?,query?,queryMode?,matchMode?,structuralFilters?,matchedCount?,totalMatches?,totalItems?,segmentCount?,segments?,digestHits?,items?,page?,pageSize?,hasNext?,coverage?,text?,error?}` |
| `memory.expand(args)` | `{session?,sourceHash?,branches?,lineageFingerprint?,expanded?:unknown[],error?}` |
| `memory.sessions(args?)` | `{scope?,branches?,sessions?:SessionInfo[],error?}`; slice `result.sessions ?? []`, not the wrapper |
| `state.transition(args)` | `{event:FabricMeshEvent,head:unknown}` |
| `state.get()` | `{head,goal,complexity,certification,recentLabels:string[]}` |
| `state.history(args?)` | `{transitions:unknown[],labels:string[],certifications:unknown[]}` |
| `state.complexity(args?)` | `{files:ComplexityFile[],netDelta:number}` |
| `state.verify(args?)` | `{certified,violated,certificationStatus,results,failures,certificate?,reportingError?,evidenceDigest,resultDigest}` |
| `state.goal(args)` | mesh state entry `{key,value,version,updatedAt,updatedBy}` |
| `state.checkGoal(args?)` | `{passed:boolean,output:string,exitCode:number\|null,error?}` |
| `schema.status()` | `{mode,certificateTtlMs,maxFiles,maxBytes,trustedCommands,generation,lastOutcome,hypotheses}` |
| `schema.hypothesize(args)` | `{hypothesisId,status,state,fingerprint,generation}` |
| `schema.verify(args)` | `{verified,hypothesisId,certificate?,issuedAt?,expiresAt?,reason?,results}` |
| `schema.commit(args)` | `{outcome,transactionId,generation?,paths?,postconditions?,complexityReductionCertified?,stateTransition?,error?,rollbackError?}` |
| `schema.abort(args)` | `{aborted:true,hypothesisId}` |
| `compact.request(args?)` | `{requested:true,intent:{reason?,instructions?,preserve?,requestedBy,requestedAt}}` |
| `compact.status()` | `{pending?:CompactIntent,last?:{at,requestedBy,status,summary?,tokensBefore?,estimatedTokensAfter?,error?}}` |
| `compact.cancel()` | `{cancelled:true}` |
| `leases.acquire(args)` | `{leases:FabricPathLease[]}`; active foreign leases block `pi.edit/write` before mutation |
| `leases.release(args)` | `{released:string[]}` for current-run leases |
| `leases.list()` | active project `FabricPathLease[]` |
| `outcomes.list(args?)` / `outcomes.status(args)` | bounded prompt-free terminal run records |
| `outcomes.evaluate(args)` / `outcomes.judge(args)` | updated record with score/verdict only |
| `outcomes.recommend()` | sample-gated candidate metrics and Wilson confidence bounds |

`memory.recall` structural filters (`ref`, `provider`, `action`, `outcome`) use exact persisted trace fields. With no `query`, `matchMode` is `"structural"`; with a lexical/regex query it is `"combined"`. Use `tools.catalog()`/`tools.search()` only to choose a current action head—catalog descriptions are navigation metadata and never become session evidence.

`SessionInfo` is `{id,file,cwd,mtime,entryCount,tier:"hot"|"cold",branches,lineageFingerprint}`. Memory failures are returned in `error: {code,message,...}`; ambiguous-session failures may return only `{error}`. Check `error` before relying on optional success fields.

### Dynamic provider return shapes

- `mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to the server-defined result, commonly `{text:string,content:unknown[],structuredContent:unknown}`; for example `mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" })`. `/Users/monotykamary/VCS/working-remote/open-source/pi-fabric/skills/fabric-exec/references/mcp.md` is a branch pointer for MCP naming and management only when the task needs MCP.
- `extensions.<tool>(args)` in full code mode resolves to `{content:Array<{type,text?,...}>,text:string,details?,isError:boolean,terminate?,source:{path,source,scope,origin,baseDir?}}`.

The guest TypeScript declarations contain the complete argument and return contracts. For a discovered or dynamic action, use `tools.describe({ref})`; inspect `outputSchema` when supplied, otherwise treat the result as `unknown`.

## `tools` — discovery & generic calls
Refs are namespaced (`pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`); bare names are rejected. `tools.providers()`→`[{name,description}]` · `tools.catalog({provider?,limit?})`→current provider/action head tree (navigation metadata, not session evidence) · `tools.search({query,limit?})`→`FabricAction[]`(`ref,name,description,inputSchema,risk`) · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})`→Claude Code runtime models with canonical `claude/<value>` keys. Use `tools.call()` for refs discovered or computed at runtime, or names that cannot use property access—not as the default for known actions. Calling a core-tool name on `tools` (e.g. `tools.read(...)`) throws with a hint to use `pi.read(...)`.

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: bare ref (`grep`→`pi.grep`); 2 positional args on `read`/`bash`/`ls` (use an options object — positional is supported only for `grep`/`find`/`write`/`edit`).

## Context-aware consultation

`consult.run(args)` is the one core exception to the user-only advanced-skill rule. Main may call it autonomously when a material decision genuinely benefits from fresh context, but host admission starts at **zero workers** and permits **at most one** Consult attempt in one `fabric_exec` execution. A task being difficult is not enough.

Call it only when all three admission fields are concrete:

- `independence`: each question can be answered without Main's hidden in-flight reasoning;
- `justification`: `context_capacity`, `independent_verification`, or `structural_diversity`;
- `couldChange`: the exact Main decision or next action the result can alter.

Choose the smallest reduction mode:

- **Partition**: 2–3 non-overlapping path scopes for separable context. `mode: "auto"` selects it for `context_capacity`. An unscoped request needs host-observed context pressure; explicit non-overlapping scopes may be admitted earlier.
- **Challenge**: exactly one perspective and a concrete `proposal`. The worker must use the silent stance when no material evidence-backed issue exists. `mode: "auto"` selects it for `independent_verification`.
- **Compare**: 2–3 structurally distinct perspectives, proven by non-overlapping evidence scopes or distinct model keys. It preserves disagreement and never invents a winner. `mode: "auto"` selects it for `structural_diversity`.

```ts
const review = await consult.run({
  objective: "Review the authentication boundary",
  decision: "Ship the refresh-token design or revise it",
  mode: "partition",
  admission: {
    justification: "context_capacity",
    independence: "Token and session modules can be inspected independently",
    couldChange: "The ship decision and which module must be revised",
  },
  perspectives: [
    { id: "tokens", question: "Inspect token rotation", scope: ["src/auth/tokens"] },
    { id: "sessions", question: "Inspect invalidation", scope: ["src/auth/sessions"] },
  ],
});
return review;
```

The host fixes every admitted worker to Pi, fresh depth-one execution, `recursive: false`, discovered extensions off, and read-only `read`/`grep`/`find`/`ls`. It loads only a host scope guard, which realpath-checks every child tool path against the project and that perspective before execution. Request fields cannot add tools, writes, shell, network, or another delegation layer. Every accepted non-silent finding also needs a host-resolvable project-relative file address; missing files, invalid lines, scope escapes, traversal, and symlink escapes are discarded. Canonical file snapshots are cached under a cumulative evidence-read budget. Raw worker records do not return.

Treat `status: "not_admitted"` as a decision to continue inline, not a reason to retry or fall back to manual fan-out. Treat `partial` as usable evidence plus explicit missing coverage. `inconclusive` means workers completed but no finding survived evidence validation. Challenge silence is a successful no-issue result. Consult outcome telemetry stores only mode/status/counts/context ratio/tokens/cost, never prompts, findings, or worker prose. Exact types and failure statuses are in `<skill-dir>/references/agents.md`.

## Orchestration surfaces (opt-in)
Advanced workflow skills are user-invoked; never load them autonomously. When the user has explicitly invoked an agent or mesh workflow, read `<skill-dir>/references/agents.md` and `<skill-dir>/references/mesh.md` for low-level API detail.

`agents.self()` and `agents.members({scope?,kinds?})` expose one leased directory of roots and Agents; `agents.list({ lifecycle })` is the lifecycle-aware public inventory. `agents.main()` and `agents.peers()` are compatibility views of root participants. **Peer is a reserved Fabric term for another root Pi session, not a child agent.** When the user says “peer,” query `agents.peers()` first; do not infer peer state from `agents.list()` or from `agents.members({ kinds: ["agent"] })`. `agents.list()` defaults to local one-shot agents; set `lifecycle: "persistent" | "all"` for the other lifecycle or both, and use `scope: "lineage" | "project"` for federated discovery. Cross-process `steer`, `followUp`, and `stop` resolve `ownerHostId` and return only after the owner acknowledges. `agents.subscribe()` creates a durable source-qualified Pi/run lifecycle route; use it instead of model-authored status polling when another participant boundary should notify Main or an agent. Detached `agents.spawn()` already sends Main a terminal follow-up by default unless the caller later waits.

For an explicit implementation handoff, `agents.handoff({ model, task?, when? })` schedules a visible Pi child at the completed outer `fabric_exec` boundary; later calls in the same program still run, and Main blocks only after the finalized native outer result is ready. `when` is a guest-only pure synchronous predicate over immutable earlier successful-call facts from any resolved Fabric provider and is stripped before the host call. `/fabric prewalk [task]` defaults to in-place Main model switching plus a hidden same-session continuation; child trajectory mode is an opt-in setting. Failed handoffs preserve the task in a blocked state for explicit `/fabric prewalk --retry`; successful hidden continuations are identity-checked and re-arm or restore the configured previous model only after settlement. In-place selection may use the bounded configured fallback chain; trajectory work is never auto-retried. Read `<skill-dir>/references/agents.md` for the full lifecycle API.

`workflow.context()` returns the safe run/trace/span envelope and reservation snapshot. `workflow.durable.run(...)` executes guest phase closures over the mesh-backed lease/DAG store; persisted records retain only phase metadata, evidence, output digests, and owner run/trace/span. Use `leases.acquire/release` around shared-workspace `pi.edit/write`; leases do not inspect bash.

Agent requests may declare capability requirements/fallbacks, an admission reason/expected artifact, and a host capability profile. Host policy can require admission. Profiles fix tools and inherited recursive risk grants; requests cannot elevate them. `workflow.gate(...)` records ordered evidence; unresolved revise, abort, revision exhaustion, and gate crashes fail closed. Finite `agentBudget`/`tokenBudget` values reserve before agent launch; set explicit `maxTokens` partitions on concurrent calls.

Pi model-provider extensions registered in the host ModelRegistry are automatically available through `tools.models()`, `agents.models({ runner: "pi" })`, and model pickers. Ordinary Pi children load installed provider extensions by default; `extensions: false` deliberately disables them. Agent requests and persistent agents accept `runner: "pi" | "claude"`. Pi is the default and is required for `recursive: true`, `rlm.query()`, and persistent agents that must call Fabric or mesh APIs themselves. Claude invokes the official `claude -p` harness; it supports mapped Claude Code tools and host-managed persistent agents, but not recursive/direct Fabric APIs. Use `agents.models({ runner: "claude" })` for runtime-enumerated `claude/<value>` model keys. Persistent agent outputs expose durable delivery receipts; retry a failed channel with `agents.retryDelivery({ id, messageId })` rather than regenerating the persistent agent response.

Omit `timeoutMs` for agents across both lifecycles unless requesting longer than the configured `agents.timeoutMs` (60 minutes by default). Per-call values below the configured default are ignored.
