# Fabric compaction

Pi Fabric owns compaction policy through `session_before_compact`. The default `"fabric"` engine always produces a deterministic, LLM-free portable summary, then selects a compatible model-native backend when one is available. Set `compaction.engine` to `"pi"` to disable Fabric routing and defer to Pi's compactor.

Fabric targets 65% of the model's advertised context window for its portable summary after compaction by default. This is configurable from `/fabric-settings` or `compaction.targetContextRatio` (bounded to `0.25`–`0.85`):

```json
{
  "compaction": {
    "engine": "fabric",
    "targetContextRatio": 0.65
  }
}
```

Use `{ "compaction": { "engine": "pi" } }` to disable the Fabric engine.

## Model-aware routing

With `engine: "fabric"`, Ultra Fabric owns one compaction decision and routes by exact active-model metadata:

| Active model | Backend | Portable fallback |
| --- | --- | --- |
| Official direct OpenAI Responses (`provider: "openai"`, `api: "openai-responses"`, `api.openai.com`) | OpenAI Responses `compaction_trigger` | deterministic Fabric summary |
| OpenAI Codex Responses (`api: "openai-codex-responses"`, official ChatGPT endpoint) | OpenAI Responses `compaction_trigger` | deterministic Fabric summary |
| Claude bridge (`baseUrl: "claude-bridge"`) | delegated to the bridge's own isolated compactor | bridge failure policy |
| Every other model, including OpenAI-compatible proxies and Azure | deterministic Fabric compactor | same result |

For supported OpenAI models, Fabric sends the current active history, system instructions, active tool schemas, and a trailing `compaction_trigger` to the same configured provider. The request uses `store: false`. Fabric retains recent whole user items within an 80 KB cap, the returned opaque compaction item, and provider token/cost usage under `details.remoteCompaction`. The deterministic summary remains in the normal Pi compaction fields for model switching, export, tree navigation, and recovery.

Compatible later OpenAI requests replay that provider-native history. Replay state is reconstructed from the active branch on resume, compaction, tree navigation, and model selection; malformed, oversized, or cross-model state is rejected. A later native compaction chains from the prior opaque item rather than compacting only the portable text. Provider failure, missing credentials, malformed streams, and unsupported endpoints fall back to the deterministic Fabric result. The explicit `__pi_vcc__` sentinel still bypasses all Fabric routing.

Native OpenAI compaction is a provider request and may incur token charges. Its opaque artifact is persisted in the local session JSONL and is not human-readable. No artifact is sent to a different provider or model key.

## Pre-threshold Context QoS

Before every model request, Context QoS deterministically retires the body of an old successful `read`, `grep`, `find`, or `ls` result only when a newer result has the same typed tool name and canonical arguments. It never removes a message, so tool-call/result pairing remains intact. The most-recent user turns, errors, mutation results, non-text content, and typed Fabric traces/gates/evidence remain exact. Retirement markers carry the newer call id and original character count; the host accumulates pass, retired-result, retired-character, and protected-result counters.

An oversized ceiling bounds the measured surge driver: an old successful result from a retirable tool (`read`, `grep`, `find`, `ls`, `fabric_exec`, or `codemap`) whose body exceeds `maxResultChars` is retired with a typed marker even when no newer equivalent result exists. A single huge unique result therefore cannot inflate context until compaction. The recent-turn window, errors, mutation results (for example `edit`/`write`/`bash`), evidence-bearing results, and non-text content stay byte-exact, and the pass is idempotent because markers are themselves protected.

```json
{
  "compaction": {
    "contextQos": {
      "enabled": true,
      "turnWindow": 2,
      "minResultChars": 4000,
      "maxResultChars": 24000
    }
  }
}
```

Keep delegated and exploration results small at the source: return structured evidence locators and bounded findings from `scout`/`explorer` roles and `consult.run` workers, prefer AST/graph navigation over whole-file reads, and read only the window you need. The QoS pass is the enforcement backstop, not a license to emit oversized tool output.

This pass is independent of the compaction engine. Set `enabled` to `false` for byte-for-byte legacy request context.

### Message-count ceiling

Providers also cap the request history by message count; for example one hosted endpoint rejects requests with `413 chat_history_too_large` when the chat history exceeds 800 messages. Token-pressure compaction cannot predict that rejection because occupancy stays low in long message-dense sessions, and the hosted endpoint's error text (`chat_history_too_large`, `payload_too_large`, `message_limit`) is not yet matched by Pi 0.84.1's overflow classifier, so the automatic compact-and-retry does not recover it.

Fabric therefore compacts proactively at a settled boundary when the active context reaches `compaction.messageThreshold` messages, before dispatch. The count is the compaction-aware active path (`sessionManager.buildContextEntries()`), counting every `message` entry, which mirrors what the provider sees in the request array. The default of `700` leaves safety room below an 800-message cap for injected prewalk continuation, checklist reminders, and skills.

```json
{
  "compaction": {
    "messageThreshold": 700
  }
}
```

The value is bounded to `200`–`1_000_000` and is independent of the occupancy thresholds: either condition compacts. If a session is already rejected, run `/compact` once to reduce the history, then retry the turn; the message ceiling prevents a repeat once Fabric is active.

`/fabric settings` also exposes a **Threshold** for the active model. Thresholds
are context-window occupancy ratios and are stored by canonical
`provider/model` key, so switching models selects that model's own value.
`Pi default` leaves Pi's built-in threshold unchanged.

```json
{
  "compaction": {
    "thresholds": {
      "anthropic/claude-sonnet-4-5": 0.8,
      "openai/gpt-5.4": 0.9
    }
  }
}
```

Configured values are bounded to `0.25`–`0.95`. Fabric triggers compaction at a
safe settled boundary when a configured threshold is lower than Pi's built-in
threshold. When Pi's built-in threshold is lower, Fabric defers that automatic
compaction until the model-specific threshold is reached; overflow and manual
compactions are never deferred.

## Invariants

1. **The session log is ground truth.** The summary is a bounded continuation view with stable entry-id and file addresses.
2. **Live cut and cumulative truth are separate.** The cut is selected from the window made live by the last compaction. The summary is rebuilt from every raw, typed, content-bearing entry on the supplied active branch prefix before the new kept boundary.
3. **Rendered summaries are never semantic input.** `compaction`, branch-summary prose, custom summary prose, and unknown roles produce no normalized events. A valid Fabric branch-summary details envelope may contribute its typed facts; its `summary` string never does. Top-level Pi `custom_message` entries are different: Pi puts them in model context, so Fabric preserves their typed `customType`, text content, visibility, and bounded JSON details. Non-context-bearing `custom` state entries remain excluded.
4. **Structure drives projection.** The core uses entry/message types, roles, content-part types, custom-message fields, tool names, JSON arguments, call ids, `isError`, exit codes, entry ids, ordering, valid Fabric execution traces, and valid Fabric branch-summary facts. It has no semantic regex over prose, code, shell commands, or tool output. Whitespace normalization, bounded truncation, exact identity comparisons, and path segmentation are mechanical operations.
5. **Serialization is deterministic and bounded.** Identical branch entries and instructions produce byte-identical output. The rendered result is at most 32 KiB in UTF-8.
6. **The nominal model window is the safety boundary.** Fabric calibrates Pi's structural token estimate against `preparation.tokensBefore`, retains as much recent raw context as fits the configured occupancy target, and reserves both Pi's response budget and an additional estimator-error margin. Undocumented provider headroom is never part of the budget.

This prevents both summary-chain drift and deterministic forgetting. Pi replaces the previous rendered summary, but Fabric re-derives the original goal, cumulative successful file addresses, error state, and user scope changes from raw branch history each time.

## Pipeline

```text
active branch entries ─┬─► live window ─► calibrated token budget ─► closure-safe cut ─► firstKeptEntryId
                       └─► raw cumulative prefix ─► normalize ─► project ─► bound/render
```

- `normalize.ts` converts raw message and top-level `custom_message` entries to typed events. Custom content is selected only from typed string/text parts; JSON details are depth/node/collection/string/byte bounded and malformed details are omitted without dropping otherwise valid content. Tool calls and results are paired only by `toolCallId`. A `fabric_exec` result contributes nested events only through a valid `details.trace` V1 guard, or through the separate strict legacy `details.audits` adapter when no `trace` field exists.
- `projections.ts` computes goal, file, operation-state, turn, status, and transcript views.
- `enrichers.ts` permits deterministic optional annotations. Fabric ships no built-in enrichers.
- `render.ts` independently bounds every rendered block and enforces the global UTF-8 limit.
- `hook.ts` computes the live cut, selects cumulative source, emits v2 details, and owns model/Pi/pi-vcc precedence.
- `openai-native.ts` validates official endpoints, serializes Pi context through the current Responses adapter, requests the native artifact, and bounds persisted history.
- `openai-native-replay.ts` validates and restores branch-local native history across lifecycle transitions and replaces only exact compatible provider payloads.

## Live cut and closure

The last compaction marker identifies the live window:

- a valid `firstKeptEntryId` starts the window at that entry;
- a compact-all marker or missing/orphan kept id starts it after the marker;
- without a marker, the whole supplied active path is live.

When Pi supplies the active model metadata, Fabric chooses the live cut by token budget rather than always preserving or discarding the whole latest user turn:

1. Sum Pi's public structural message estimates for the current context.
2. Calibrate that estimate with `preparation.tokensBefore`. This compensates for provider tokenization, system prompts, tool schemas, and other fixed context that a character heuristic cannot observe directly.
3. Reserve the maximum 32 KiB summary, then target `contextWindow × targetContextRatio` while honoring `keepRecentTokens` when it remains safe.
4. Cap the target below `contextWindow - reserveTokens` with an additional estimator-error margin, and below 95% of `tokensBefore` so a low-usage manual compaction cannot expand context. The advertised window is authoritative for threshold and manual compaction, even when a provider accepts larger requests. During overflow recovery the failed request is stronger evidence: an API rejection proves the effective window is below `tokensBefore`, so Fabric clamps the working window to 90% of the observed size before applying the same targets and ceilings. This lets a compact-and-retry fit providers whose real limit is lower than the advertised model window (for example proxied OpenAI deployments) instead of shrinking toward an unreachable ratio and losing the single automatic retry.
5. Select the earliest eligible boundary whose retained suffix fits the budget. User/custom boundaries and assistant boundaries are eligible, so a single enormous autonomous turn can be split instead of surviving compaction intact. On repeated compaction, the kept boundary must follow the previous compaction marker in raw log order; Pi replays entries contiguously from `firstKeptEntryId`, so allowing a boundary before that marker would replay the old rendered summary beside the new one.

Fabric computes structural spans for every call id across the supplied branch and rejects any candidate that separates an actual call/result pair. Therefore both directions are enforced:

- no summarized tool call has a kept result;
- no kept tool call has a summarized result.

This handles parallel calls, delayed results, reverse/malformed ordering, and malformed prior boundaries. If no non-crossing boundary fits, Fabric uses compact-all (`firstKeptEntryId: ""`), so no kept side remains to orphan either half. If the rendered deterministic summary itself makes the calibrated projection exceed the target, Fabric cancels rather than persisting an expanding or over-budget result. If model metadata is unavailable, the legacy latest-turn closure-safe cut remains as a compatibility fallback.

The live cut determines only what Pi keeps. Summary source is the raw active-branch prefix before that new boundary. Earlier compaction and branch-summary prose within that prefix is skipped by normalization.

## Bounded sections

The original first user goal is emitted first. Later user scope changes and potentially large file, operation-state, and earlier-turn collections use deterministic earliest-plus-latest sampling. Every omission records a count and a source entry-id range. File lines also carry the source call entry id.

Rendered block limits include their headers:

| Block | UTF-8 limit |
| --- | ---: |
| `[Session Goal]` | 4096 bytes |
| `[Compaction Request]` | 3072 bytes |
| `[Files And Changes]` | 4608 bytes |
| `[Fabric Activity]` | 2048 bytes |
| `[Outstanding Context]` | 4608 bytes |
| `[Earlier Turns]` | 3072 bytes |
| `[Current Status]` | 2048 bytes |
| collapsed transcript | 5120 bytes |
| footer | 1536 bytes |

The limits sum below 32 KiB, leaving room for separators. A final UTF-8 guard enforces the global limit. Projection limits are also finite: 24 later goals, 24 file addresses per operation kind, 32 operation-state records, 32 earlier turns, and 40 transcript events. Omitted source remains executable-addressable through entry-id ranges and the footer recall pointer.

## Sections

- **Session Goal**: up to three bounded lines from the original first user message, followed by sampled later user scope changes.
- **Compaction Request**: canonicalized, bounded custom instructions; see below.
- **Files And Changes**: successful typed file-tool addresses grouped as Created, Written, Modified, or Read. `edit` is Modified. `write` is Written unless a typed result explicitly proves creation.
- **Fabric Activity**: bounded phases and significant non-file nested operations, including bash, agents, workflow, mesh, state, MCP, and extension refs. Every line has a stable `entryId/subordinal` address.
- **Outstanding Context**: typed tool/bash failures and later exact structural resolutions. File failures require the same action and path, bash failures the same command, and generic failures the same ref and arguments. Explicit error text is quoted and bounded, never parsed or classified. Trace failures use only `operation.outcome` and `operation.error`.
- **Earlier Turns**: sampled user/custom context one-liners and tool-name counts.
- **Current Status**: the latest summarized user/custom context, modification address, and assistant line.
- **Transcript**: the latest 40 typed events, including quoted/bounded custom-message content and bounded structural details, plus an omission range when applicable.
- **Footer**: deterministic source timestamp, cumulative source range, and session-log recall guidance.

There is intentionally no commit projection. The core does not recognize `git commit` command prefixes and does not parse shell stdout for hashes or summaries. A caller that needs a commit ID across compaction must provide it explicitly through a valid typed `preserve` item or another typed state transition.

## Remaining structural text operations

The clean core retains only these mechanical text operations:

- select text from typed user, assistant, top-level custom-message, tool-result, command-argument, error, phase, ref, and path fields;
- split user text on literal newlines for bounded goal lines, or select the first line for one-line views;
- trim/collapse whitespace and truncate by fixed character or UTF-8 byte limits;
- quote bounded user/custom/assistant/tool/error text without interpreting its content;
- compare typed action/path, action/command, or ref/JSON-arguments identities exactly for resolution;
- segment typed paths on `/` or `\\` to compute display roots;
- split a typed Fabric ref once on `.` to expose provider/action identity;
- inspect the explicit typed `created: true` result field for write classification;
- match only the exact `__pi_vcc__` sentinel or exact typed-request prefix, then use a bounded structural JSON parser.

No command prefix, stdout/stderr line format, error wording, path-looking prose, commit-looking prose, source code, or tool-result rendering is recovered into semantic facts.

## Custom instructions

`customInstructions === "__pi_vcc__"` is an exact routing sentinel and is never rendered by Fabric.

Every other plain instruction is explicit user data, not a mini-language. Fabric canonicalizes whitespace, bounds the input, and includes it in `[Compaction Request]` without semantically parsing it.

`compact.request` may add typed `preserve: string[]` values. When present, the controller forwards an exact versioned prefix followed by JSON. The hook accepts only the exact prefix and a strict v1 object. Once that reserved prefix is present, malformed JSON/scalars, duplicate protocol keys (including escaped-key aliases), unknown fields or versions, invalid types, unpaired UTF-16 surrogates, excessive structure, or exceeded bounds produce a structured decode error and cancel the operation; the encoded payload is never reinterpreted or rendered as plain instructions. A UI/RPC context receives a bounded error notification when available.

Typed v1 limits are enforced before value mapping or canonicalization: instructions are at most 8192 characters and 8192 UTF-8 bytes; `preserve` has at most 16 items; each item is at most 2048 characters and 2048 UTF-8 bytes; and the complete prefix-plus-JSON source is at most 16 KiB. The decoder checks the aggregate source limit before invoking its bounded recursive-descent parser, rejects duplicate decoded keys while parsing, validates scalar grammar and surrogate pairing, and checks preserve count before iterating or canonicalizing values. Plain Pi/manual instructions remain explicit bounded text and are not subjected to the typed protocol parser.

## Compaction details v2

New summaries emit `details.compactor: "fabric"` and `details.version: 2` with:

- cumulative source and live-cut ranges;
- branch, source-entry, event, and live-cut counts, plus the number of tool-call/result pairs retained whole inside the summarized window (`counts.intactPairs`);
- prior recognized Fabric v1/v2 marker counts and the 1-based `ordinal` of this compaction (`priorFabricV1 + priorFabricV2 + 1`);
- per-projection omission counts, the typed preserve count (valid v1 requests cannot exceed the preserve limit), and the optional `duplicates` (collapsed repeated output) and `noise` (skipped bookkeeping tool pairs) counters;
- instruction mode, canonicalization, source size, truncation, and preserve counts;
- stable kept/source entry-id addresses and the source timestamp;
- when adaptive budgeting is active: advertised window, target ratio/tokens, Pi reserve and recent settings, raw estimate, calibration scale, fixed overhead, retained raw tokens, and Fabric's `projectedTokensAfter`. Pi core independently recomputes its own `estimatedTokensAfter` after persisting the compaction;
- for successful official OpenAI Responses routing: a versioned `remoteCompaction` envelope with the exact provider/API/model key, bounded recent user items, opaque replacement history, and provider-reported usage/cost.

Only exact Fabric versions 1 and 2 are recognized. v1 details and rendered prose are not reused as truth. On the next compaction, an old session naturally migrates to v2 because the new result is rebuilt from raw active-branch entries. V2 validation accepts the legacy commit-omission counter for old records, but new summaries do not emit a commit projection or counter. `counts.intactPairs` and `ordinal` are additive: entries persisted before their introduction remain valid, and new summaries always emit them.

## Adopted reference concepts

This section records which compaction ideas were adopted from the MIT-licensed reference projects and how each one fits the deterministic core.

- **Tool-output deduplication** (adopted from [`pi-dcp`](https://github.com/pi-vault/pi-dcp)): within the brief transcript, a repeated identical non-error tool result after the first occurrence renders as a stable `(same output as (#N))` reference and is counted in `omittedCounts.duplicates`. Failed diagnostics are never deduplicated, so error signatures survive exactly as in pi-dcp's prune policy.
- **Structural noise filtering** (adopted from [`pi-vcc`](https://github.com/monotykamary/pi-vcc) `filter-noise`): the bookkeeping tool pair set (`TodoWrite`, `TodoRead`) is skipped before projection and counted in `omittedCounts.noise`, and Pi-injected XML wrapper blocks (`<system-reminder>`, `<ide_opened_file>`, `<command-message>`, `<context-window-usage>`) are stripped from user text during normalization. Both matches are purely structural; no prose is inspected.
- **Compaction ordinal** (adopted from [`pi-vcc-tom`](https://github.com/monotykamary/pi-vcc-tom) `compaction-count`): `details.ordinal` is the 1-based count of prior recognized Fabric compactions plus one, matching the session-entry-based indexing convention.
- **Proactive threshold cooldown** (adopted from pi-vcc-tom `proactive-threshold` and pi-dcp nudge throttling): `compaction.cooldownMs` is an opt-in minimum interval between threshold-triggered compactions. The default `0` disables the guard entirely; the timestamp is set at trigger time so a failing compact cannot hammer the provider on consecutive `agent_settled` boundaries. `resetThresholdCooldown()` clears it and runs on `session_start`.

## Nested Fabric execution traces

For an outer `fabric_exec` tool result, normalization reads only `message.details.trace` through `readFabricExecutionTraceV1`. Operations are emitted in `operation.sequence` order with addresses such as `entry-id/0`; phases use `entry-id/phase:0`. Known `pi.read`, `pi.grep`, `pi.find`, `pi.ls`, `pi.edit`, `pi.write`, and `pi.bash` calls retain exact typed arguments and outcomes. Other refs remain typed Fabric activity.

A present but malformed or unknown trace version is ignored and is not reinterpreted as legacy data. When `trace` is absent, the legacy adapter accepts only an audit array whose records have typed `ref`, JSON `args`, boolean `success`, and optional string `error`; it never reads audit rendering or `result` prose. The outer tool conversation remains in the transcript, but `fabric_exec` source code and outer result prose cannot create file, failure, or activity facts.

## Deterministic branch summaries

When the Fabric engine is active, the same registration also handles `session_before_tree`. It returns nothing when `userWantsSummary` is false and compiles only `preparation.entriesToSummarize` when true. Tree custom instructions use the same plain/typed decoder and fail-closed limits as compaction. The exact `__pi_vcc__` value has routing meaning only for compaction; on the tree path it remains ordinary explicit request text.

`replaceInstructions: true` has Pi replacement-prompt semantics, not append-instructions semantics. A deterministic projection cannot execute an arbitrary replacement summarizer prompt, so Fabric returns `undefined` and defers to Pi or another handler. No Fabric summary or typed Fabric branch details are produced by Fabric in that explicit mode.

Branch details use `kind: "pi-fabric.branch-summary"`, `version: 1`, stable source addresses, and at most 256 bounded typed facts in a 128 KiB envelope. Facts cover source users, top-level custom messages, phases, and operations. Newly generated details record `source.oldLeafId` from `preparation.oldLeafId`; this is the canonical abandoned/from-leaf provenance. Older v1 envelopes without that field remain readable. Pi 0.80.6 writes generic `BranchSummaryEntry.fromId` from the navigation target position rather than the abandoned leaf, and a hook cannot correct that core-generated field, so consumers must use Fabric's typed `source.oldLeafId` when present.

Nested branch summaries re-emit only valid typed facts; branch summary prose is never normalized. Later compaction can therefore resolve abandoned-branch failures against later exact successes and retain custom context, files, and activity through navigation or forks without parsing prose. Since Pi supplies only the active path or the abandoned `entriesToSummarize` path to each compiler, sibling branches do not contaminate one another.

## Compactor precedence

Precedence is:

1. exact `__pi_vcc__` custom-instruction sentinel;
2. configured Fabric engine and its exact model route;
3. pi-vcc/default Pi behavior.

Within the Fabric route, an exact Claude bridge model is left unclaimed so the bridge's later takeover can run. Supported official OpenAI Responses models are handled inside Fabric. Every other model receives the deterministic Fabric summary.

Fabric marks claimed events with `_fabricCompaction`. If an earlier pi-vcc handler marked `_piVccOverriding` and Fabric has nothing to compact, Fabric does not return a cancellation that would erase the pi-vcc result. With engine `"pi"`, Fabric neither claims nor cancels the event.

Pi's public extension contract runs `session_before_*` handlers in extension load order and keeps the latest non-cancelling result. Therefore an unrelated handler loaded after Fabric can replace Fabric's compaction or tree result; a later cancellation also terminates dispatch. There is no supported public registration phase that can move one extension behind every subsequently loaded extension. Fabric preserves the explicit pi-vcc sentinel/marker cooperation above, but does not monkeypatch Pi's private runner. Deployments that require Fabric to win over arbitrary hooks must load Fabric after those extensions (while accounting for any intentionally later pi-vcc override).

## Reconstruction QA

`src/compaction/qa.ts` derives probes from normalized source events, never rendered sections. QA probes follow the same bounded sampling policy as projections: directly rendered samples are checked for content, while omitted collections are checked for count/range addressability. Mutation tests remove file, error, turn, and footer information to verify that the report detects loss.

Run:

```sh
pnpm vitest run tests/compaction-qa.test.ts
```
