# Certification and benchmarks

This repository has four separate evaluation paths:

- `pnpm certify:context` is deterministic, offline, and non-billable.
- `pnpm benchmark:prewalk` validates operator-supplied, prompt-free Prewalk comparison evidence and never invokes a model.
- `pnpm benchmark:prewalk:real` is an opt-in, billable paired Prewalk collector. Its default behavior is a safe skip.
- `pnpm benchmark:real-resume` is an opt-in, billable Pi RPC benchmark. Its default behavior is a safe skip.

`pnpm benchmark:prewalk:corpus` materializes the bundled non-billable 20-task contract corpus for the Prewalk collector. None of these commands is part of `pnpm test`; corpus qualification itself remains covered by the normal offline suite.

## Deterministic certification

Run on Node 24 or newer:

```sh
pnpm certify:context
pnpm certify:context -- --json /tmp/pi-fabric-certification.json
```

The package command builds `dist/` first, then runs `scripts/certify-context.mjs`. It prints a human summary followed by the complete JSON report and exits nonzero when any threshold fails.

### Compaction endurance

The harness creates a persisted session through Pi's `SessionManager`, appends messages and compactions through its public methods, and reads the active parent-linked branch with `getBranch()`. It performs exactly 100 Fabric compactions under deterministic settings (`contextWindow=64`, `reserveTokens=63`, `keepRecentTokens=1`). Before every hook event it calculates Pi's built context, applies `shouldCompact`, and requires Pi's own `prepareCompaction` to return a preparation. It then invokes the callback registered by `registerCompactionHook` with Pi's event shape, branch, preparation token count, reason, retry state, and signal.

Pi 0.80.6 publicly exports `SessionManager`, `buildContextEntries`, `buildSessionContext`, and `shouldCompact`. It implements and declares `prepareCompaction`, and `AgentSession` uses it, but the package root/export map does not export it. Certification therefore resolves the exact installed 0.80.6 internal module, verifies the installed version and function shape, and reports `prepareCompactionPubliclyExported: false`. There is no public API that supplies a preparation without running an `AgentSession` with a model; claiming otherwise would be inaccurate.

Every persisted summary receives a cycle-unique `PRIOR_SUMMARY_POISON_991_…` suffix in the actual `CompactionEntry`. On the next cycle Pi's preparation must expose that exact stored previous summary. A proxy around the event preparation records whether the registered Fabric callback reads `previousSummary`; the result is derived from those accesses rather than hardcoded. Fabric must not read it or emit its poison. No summary is manually converted to a user message.

Every cycle also checks:

- the original goal, constraint, and pinned Unicode rare fact;
- cumulative source, file, and unresolved-error addresses;
- tool-call/result closure at the kept boundary;
- that every nonempty `firstKeptEntryId` exists on the active branch;
- exact persisted summary/details round trips;
- `SessionManager.buildContextEntries()` and public `buildContextEntries()` agreement;
- after the compaction and after each subsequent append, the built context is exactly the latest `compaction` entry followed by the retained live entries;
- a valid UTF-8 summary size no larger than 32 KiB.

The last 20 summary sizes must have a range no larger than 512 bytes and an absolute least-squares slope no larger than 16 bytes per cycle. These bounds detect late unbounded growth without requiring every cycle to have the same size.

Six explicit eligible closure fixtures must each execute at least once: normal, compact-all, Pi split-turn preparation, parallel/delayed results, reverse-order call/result, and malformed prior boundary. Every resulting Fabric cut is checked for call/result closure.

A separate approximately 330 KiB maximal source uses multibyte goals, instructions, paths, errors, turns, and typed Fabric activity. It must produce at least 24 KiB of summary output, remain at most 32 KiB, and round-trip through a fatal UTF-8 decoder. This exercises the bound near its reachable projection saturation rather than relying on the endurance fixture's natural approximately 5.8 KiB plateau.

This proves deterministic cumulative projection, actual Pi eligibility/context behavior, closure handling for the named fixtures, and byte-safe saturation for the generated typed event streams. It does not prove semantic quality for arbitrary human conversations or model behavior.

### Cross-layer memory

The same run creates 1,000 additional persisted Pi sessions. The unique rare-fact session receives an old source mtime and must be classified cold while only eight sessions remain hot. Certification calls `MemoryProvider` directly rather than parsing shell output.

The pass conditions are:

- at least 1,000 eligible sessions and complete indexing coverage;
- exact lexical recall of the cold rare fact;
- exact structural selection of a cold `pi.grep` operation by persisted ref/outcome, followed by source- and lineage-bound hydration;
- a nonexistent-ref structural negative control with zero results;
- exact source expansion by its stable entry ID;
- exact expansion of every distinct entry ID emitted by the 100 compaction summaries or their structured details;
- 100% address expansion agreement with a fresh normalization of the source JSONL;
- V6 `sourceHash` integrity checks on both cold hydration and context address expansion.

The JSON report includes eligible/indexed/stale counts, emitted/expanded address counts, and cache/source byte sizes.

This proves lexical addressability and exact capability-head addressability through the current cache, digest, search, and source-expansion layers. It does not prove fuzzy semantic retrieval, ranking under unrelated corpora, cache performance on all filesystems, or recovery after source deletion.

### Continuation QA

Continuation QA creates two small temporary repositories. Each has exact expected final files, an executable Node oracle, and files that must remain byte-identical. A no-model handoff simulator receives only:

1. the compacted summary and structured compaction details; and
2. constrained current-session pointer and expansion APIs backed by `MemoryProvider`.

The source phase persists a handoff envelope containing the compacted context and current Pi session ID, not task operations or a captured session path. The resume phase reads that output, constructs a fresh `MemoryProvider`, asks it for a V6 integrity-bound current-session pointer, derives the cumulative source entry ID from compaction details, and expands that address with `expectedSourceHash`. The `addressResolved` score comes from the returned entry, never a constant. No callback closes over `manager.getSessionFile()`.

Only after exact source expansion does the simulator decode `CERT_TASK_V1` and apply its operations. If an exact operation or file payload is unavailable, it throws and fails instead of inventing success. The external oracle then scores exact filesystem state, forbidden-file integrity, and process exit status; it never supplies `task.operations` to the simulator.

This proves that the emitted address, current persisted session identity, and allowed memory operations can carry these mechanically executable tasks across a fresh handoff. Pi's compaction result does not itself expose a session ID or source hash, so those come respectively from persisted current-session context and `MemoryProvider`; the report does not claim they are emitted by Pi. It does not claim that arbitrary prose can be converted into operations, that a model will choose to recall, or that the two fixtures represent all software work.

## Prewalk comparison analyzer

The Prewalk analyzer applies the repository's minimum 20-task evidence gate without making model calls:

```sh
pnpm benchmark:prewalk
pnpm benchmark:prewalk -- /absolute/path/to/prewalk-results.json
```

Without a result file the command exits zero with `SKIP`. With a file it validates every record strictly, prints a deterministic aggregate report, and exits nonzero unless the report reaches `comparison_ready`.

The top-level JSON object contains `representativeTaskSet`, optional `minimumTasks` (never lower than 20), optional bounded model/version/cost `provenance`, and `runs`. Real collections include a SHA-256 digest of the parsed private manifest, binding results to the exact corpus without publishing its prompts or fixture bytes. Every task/repeat must have one `in-place` and one `research` run. A run stores only a bounded task identifier, acceptance counts, unsupported-claim and missed-constraint counts, request and parent context-token counts, latency, total tokens, USD cost, and research protocol evidence. Unknown fields such as raw prompts, outputs, credentials, or unrestricted prose fail closed. Input is capped at 8 MiB and 10,000 run records before aggregation.

Research records additionally require:

- a checklist count between 5 and 9;
- observed first-mutation boundary, planning-instruction pruning, and executor verification booleans;
- a 0–1 plan-quality score plus the bounded evaluator/rubric identifier that produced it.

The report includes Wilson 95% full-acceptance intervals, paired wins/ties for acceptance, constraints, claims, tokens, cost, and latency, protocol compliance rates, and average plan quality. `representativeTaskSet: true` is an explicit operator attestation; the analyzer cannot infer representativeness from a task ID.

### Opt-in real collector

Validate a manifest and inspect its paired schedule without credentials or model calls:

```sh
pnpm benchmark:prewalk:real -- --dry-run /absolute/path/to/prewalk-manifest.json
```

#### Bundled contract corpus

Materialize the portable corpus with machine-local absolute Node and evaluator paths:

```sh
pnpm benchmark:prewalk:corpus -- --output /absolute/path/to/prewalk-manifest.json
pnpm benchmark:prewalk:real -- --dry-run /absolute/path/to/prewalk-manifest.json
```

The corpus contains 20 source-mapped contract tasks across Prewalk, persistent Agents, reliability, run context, path coordination, durable workflows, Context QoS, routing, quality, memory, Consult, outcomes, and retention. Every fixture includes a protected contract and executable verifier. Repository tests prove each fixture fails with its stub and passes with its reference solution; source paths and hidden solution bytes are excluded from the generated manifest.

The default manifest sets `representativeTaskSet: false`. The tasks cover current backend contracts but are not historical maintenance work. Only an operator who accepts that scope for a specific decision should add the explicit attestation:

```sh
pnpm benchmark:prewalk:corpus -- \
  --output /absolute/path/to/prewalk-manifest.json \
  --attest-representative
```

That switch changes only the analyzer evidence flag; it does not improve the corpus or establish general representativeness.

A manifest is strict JSON with a maximum of 100 tasks. Every task supplies a bounded prompt, initial and exact expected text files, protected initial files, and one literal-argv test command. `.pi` and `.git` fixture paths, path traversal, symlink satisfaction, unknown fields, oversized files, and malformed commands fail closed. The runner creates a separate temporary trusted project for every task/repeat/variant and removes it after collection.

The manifest also supplies one independent evaluator command:

```json
{
  "format": 1,
  "representativeTaskSet": false,
  "minimumTasks": 20,
  "evaluator": {
    "id": "independent-rubric-v1",
    "billable": false,
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/evaluator.mjs"],
    "timeoutMs": 5000,
    "env": []
  },
  "tasks": [
    {
      "id": "task-01",
      "prompt": "Implement the exact fixture behavior.",
      "initialFiles": { "verify.mjs": "..." },
      "expectedFiles": { "verify.mjs": "...", "src/value.js": "..." },
      "protectedPaths": ["verify.mjs"],
      "test": {
        "command": "/absolute/path/to/node",
        "args": ["verify.mjs"],
        "timeoutMs": 15000,
        "env": []
      }
    }
  ]
}
```

The evaluator receives the task, research checklist, final response, and exact oracle result through stdin only. It returns `unsupportedClaims` and, for research runs, `planQualityScore`. Its prompt, checklist, response, and explanation are never written to the result dataset. `billable` must be `false`; model-judge spending is not covered by this collector's Pi-arm budget.

A real run requires both explicit trust gates, configured frontier/executor credentials, repeat count, task timeout, and a positive observed-cost stop:

```sh
PI_FABRIC_PREWALK_REAL=1 \
PI_FABRIC_PREWALK_TRUST_MANIFEST=1 \
PI_FABRIC_BENCH_PROVIDER=anthropic \
PI_FABRIC_BENCH_MODEL=claude-opus-4-6 \
PI_FABRIC_BENCH_KEY_ENV=ANTHROPIC_API_KEY \
PI_FABRIC_PREWALK_EXECUTOR_PROVIDER=anthropic \
PI_FABRIC_PREWALK_EXECUTOR_MODEL=claude-sonnet-4-6 \
PI_FABRIC_PREWALK_EXECUTOR_KEY_ENV=ANTHROPIC_API_KEY \
PI_FABRIC_BENCH_REPEATS=1 \
PI_FABRIC_BENCH_MAX_USD=10 \
PI_FABRIC_BENCH_TASK_TIMEOUT_MS=600000 \
pnpm benchmark:prewalk:real -- /absolute/path/to/prewalk-manifest.json --output /absolute/path/to/prewalk-results.json
```

The collector verifies that Pi loaded `/fabric`, disables unrelated context files, skills, prompt templates, extensions, agents, MCP, quality hooks, and Schema enforcement, and pins both model thinking levels to off. `--output` requires an absolute, not-yet-existing path and writes a mode-0600 pure JSON dataset through a same-directory atomic link, so it can be passed directly to `pnpm benchmark:prewalk -- <results.json>`. A trailing probe records only request context counts, model IDs, checklist count, mutation count, and planning/continuation presence. It never records message or checklist content. Each complete run is revalidated through the analyzer schema before output.

The USD limit is an observed stop checked before each next arm, not a provider-side hard cap; one in-flight arm can overshoot. Missing commands, timeouts, malformed evaluator output, absent probe evidence, or unloaded Fabric are benchmark infrastructure failures rather than task failures. Model/task failures remain scored as incomplete acceptance, missed constraints, or unsupported claims.

### Observed real-run findings (2026-08-08)

The first real collector runs on the operator stack were attempted and produced reproducible findings:

- The omniroute provider extension loads headless via `PI_FABRIC_PREWALK_EXTRA_EXTENSIONS`; the probe observes checklist counts because the trace projection now carries `fabric.prewalk.checklist` item structure (counts and dispositions, never plan text); and `prewalk.planningEscapes: false` forces the full 5-9 item protocol in benchmark configs.
- The research arm still cannot complete headless: the executor continuation is queued with `sendMessage({ deliverAs: "followUp", triggerTurn: true })`, which is interactive-only, and a resume prompt hangs the RPC session. The executor phase never runs, so no research record can reach `comparison_ready`.
- The bundled 20-task corpus is too small for the research protocol: a capable frontier model correctly trivial-escapes single-function contract fixtures, so those records cannot carry 5-9 item checklists even with escapes disabled.
- The pinned `openai-codex/gpt-5.6-sol` is rejected by a ChatGPT-account Codex ("not supported when using Codex with a ChatGPT account") and `gpt-5.5` reports "usage limit reached"; the working route is the operator omniroute gateway (`opencode-go/deepseek-v4-flash`), which reports zero USD cost to Pi, so the token budget is the enforced stop.

### What remains missing


- The bundled corpus is source-qualified contract coverage, not an independently sampled set of historical repository changes.
- Its bundled evaluator scores checklist structure, artifact specificity, and unsupported success claims after oracle failure; it does not establish semantic plan quality.
- Representative-task attestation remains an explicit operator decision and is not independently verified.
- No real collector run has been performed in this repository, so no cost, quality, or success-rate comparison is established.

The protocol target is the primary Stencil article: [“You only need the frontier model for one single edit”](https://stencil.so/blog/prewalk). Mechanical protocol compatibility is necessary for comparison, not evidence that plan quality is correct or that Ultra reproduces the article's reported outcomes.

## Real Pi RPC benchmark

The benchmark compares three arms in deterministic randomized paired order:

- `baseline`: resume the full, uncompacted context;
- `fabric`: compact with Fabric, terminate that process, then resume in a fresh process;
- `pi-vcc`: issue `compact` with the exact `__pi_vcc__` sentinel while both Fabric and the configured pi-vcc extension are loaded, terminate that process, then resume in a fresh process.

The resumed process receives exactly:

```text
Resume and complete the task.
```

A filesystem/test oracle outside the model scores the result. Reports capture pass/fail diff reasons, tokens, USD cost, tool calls, recall calls, wall time, summary bytes, Wilson 95% pass-rate intervals, and paired win/tie rates. Reports include the credential variable's name but never its value. Session and repository data live in a temporary directory and are removed after the run.

The RPC reader implements strict LF JSONL framing. It splits only on `\n`, strips an optional trailing `\r`, preserves U+2028/U+2029 inside JSON strings, and does not use Node's `readline`.

### Safety gate

Running this command without configuration exits zero and reports `SKIP`:

```sh
pnpm benchmark:real-resume
```

A billable run requires every gate below:

```sh
PI_FABRIC_REAL_RESUME=1 \
PI_FABRIC_BENCH_PROVIDER=anthropic \
PI_FABRIC_BENCH_MODEL=claude-sonnet-4-5 \
PI_FABRIC_BENCH_KEY_ENV=ANTHROPIC_API_KEY \
PI_FABRIC_BENCH_REPEATS=3 \
PI_FABRIC_BENCH_MAX_USD=5 \
PI_VCC_EXTENSION=/absolute/path/to/pi-vcc/extension.ts \
pnpm benchmark:real-resume
```

`PI_FABRIC_BENCH_KEY_ENV` names an already-set credential environment variable. The benchmark checks observed session cost before starting each next arm and stops once the configured budget has been reached. A single in-flight request can exceed the remaining budget, so the maximum is a stop boundary, not a provider-side hard spending cap.

The benchmark proves end-to-end behavior only for the selected model, provider, fixture, extension versions, and repeats. Small samples have wide confidence intervals. It does not establish general superiority or isolate every source of provider variance.

## Relationship to pi-vcc stress tooling

The neighboring pi-vcc stress scripts informed the useful ideas of repeated compaction, late-size measurements, paired real-session comparisons, and explicit recall accounting. This harness does not copy their regex-based section scoring, feed the previous rendered summary as the next source, or claim their assumptions. Fabric certification instead uses Pi parent-linked session entries, structured compaction details, direct memory APIs, exact source expansion, and executable continuation oracles.

## Test coverage

`tests/certification/` covers:

- strict LF JSONL parsing, including split UTF-8 and Unicode line separators;
- the default skip gate and complete opt-in gate;
- deterministic paired order and benchmark confidence/paired reporting;
- executable continuation oracle passes and forbidden-change failures;
- certification rejection when eligibility, poison exclusion, address resolution, or the external oracle is sabotaged;
- certification report threshold failures.
