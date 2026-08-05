# Lifecycle Loop: Research and Design for Slices A and B

**Status:** Proposed
**Date:** 2026-08-05
**Scope:** A per-feature artifact convention (Slice A) and operator-facing lifecycle commands (Slice B) for Ultra Fabric, grounded in the OpenCode inspo template's command/workflow structure but built natively on Ultra's durable runtime.

## Context

The inspo template at `inspo/template/.opencode` ships a development lifecycle loop: `/research` → `/create` → `/plan` → `/ship` → `/verify`, backed by per-feature artifact files under `artifacts/<slug>/` and an `.active` pointer. Ultra Fabric has no equivalent. Its 24 `/fabric` subcommands (`src/commands/fabric.ts:107-130`) are all runtime introspection and control. Prewalk is an in-turn control loop that dies at turn end; it does not remember what is being built across sessions.

Ultra already has stronger durable machinery than the template's flat markdown files: `workflow.durable.run` with leases and a DAG store, `outcomes` with evaluate/judge, `state` with goal/complexity/certification, `memory`, and `workflow.gate` with evidence and revise/abort. What is missing is the operator-facing loop and the artifact convention sitting on top of it.

This document is the detailed design for Slices A and B, written so implementation is mechanical. Slice C (bounded loop controller and `/pr`) is deferred.

---

## 1. System Fit: Three Seams

### 1.1 Command Dispatch

Ultra registers exactly one Pi command named `"fabric"` (`src/commands/fabric.ts:104`). Every subcommand is a string token parsed inside its handler.

**Handler signature** (`src/commands/fabric.ts:213`):

```ts
async handler(argumentsText, context) {
  await state.ensure(context);
  const [command = "dashboard", ...argumentsList] = argumentsText
    .trim()
    .split(/\s+/)
    .filter(Boolean);
```

`argumentsText: string` is the raw text after `/fabric `. `context: ExtensionContext` provides `context.ui`, `context.sessionManager`, `context.modelRegistry`, `context.hasUI`, `context.cwd`, `context.mode`. Handlers return `Promise<void>`; output is via `context.ui.notify`.

**FabricCommandDeps** (`src/commands/fabric.ts:13-19`):

```ts
interface FabricCommandDeps {
  state: FabricState;
  fabricUi: FabricUiController;
  capturedTools: CapturedToolCatalog;
  applyFabricMode: () => void;
  suspendToolCapture: () => void;
}
```

`state` (`FabricState` from `../fabric-state.js`) holds providers, config, `agents`, `persistentAgents`, `templates`, `prewalk`, `pathLeases`, `outcomes`, `registry`, `mesh`, and `ensure(context)`/`initialize(context)`. No new deps are needed for Slices A and B: all required providers are reachable through `state`.

**Dispatch construct** (`src/commands/fabric.ts:219-758`): an ordered `if` chain, not a switch or map. Each branch must `return` to prevent fall-through.

- `if (command === "reload")` — line 219
- `if (command === "prewalk")` — line 232
- `if (command === "dashboard" || command === "ui")` — line 299
- `if (command === "providers")` — line 303
- `if (command === "captured")` — line 311
- `if (command === "leases")` — line 338
- `if (command === "outcomes")` — line 379
- `if (command === "health")` — line 419
- `if (command === "agents")` — line 464
- `if (command === "messages")` — line 480
- `if (command === "log")` — line 511
- `if (command === "export-log")` — line 561
- `if (command === "clear-messages")` — line 608
- `if (command === "events")` — line 623
- `if (command === "stop")` — line 642
- `if (command === "remove" || command === "kill")` — line 665
- `if (command === "attach")` — line 689
- `if (command === "global")` — line 701
- `if (command === "import")` — line 713
- `if (command === "export")` — line 735
- **Terminal fallback:** `if (command !== "status")` — line 758, prints usage and returns. `status` is the implicit else.

**Autocomplete** (`src/commands/fabric.ts:107-130`): the `subcommands` array is the only canonical name list, used for completion only. Adding a subcommand requires appending to this array.

**Argument parsing**: each branch reads its own args off `argumentsList` by index. There is no shared option parser. `idCommands` (line 132-142) is autocomplete-only; the handler does not consult it.

### 1.2 Durable Persistence

Ultra has exactly one general-purpose durable key-value store: `MeshStore` (`src/mesh/store.ts`). It backs `<project>/.pi/fabric/mesh/state.json` with `events.jsonl`, `sequence`, `generation`, and `.lock`.

**Key rules** (`src/mesh/store.ts:55, 839-846`):

```ts
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

#validateKey(key: string): void {
  // ...
  const unsafeSegment =
    segment === "__proto__" || segment === "prototype" || segment === "constructor";
  if (!KEY_PATTERN.test(key) || unsafeSegment) {
    throw new Error(...);
  }
}
```

The pattern allows `/` in the character class, so slash-separated key prefixes work. The `work/` prefix makes the first-character rule always pass (starts with `w`). The only blocked segments are `__proto__`, `prototype`, and `constructor` (checked per `/`-segment).

**API surface** (`src/providers/mesh-provider.ts`, namespace `mesh`):

| Method | Signature | Risk |
|--------|-----------|------|
| `get` | `{ key: string }` → `MeshStateEntry \| null` | read |
| `list` | `{ prefix?: string, limit?: number }` → entries | read |
| `put` | `{ key: string, value: unknown, ifVersion?: number }` | agent |
| `delete` | `{ key: string, ifVersion?: number }` | agent |

`ifVersion` provides compare-and-swap; versions are monotonic per key.

**Existing precedent: the outcomes store** (`src/outcomes/store.ts`). `FabricOutcomeRecord` (line 50) extends `FabricOutcomeInput` (line 26) with `{ format: 1, id, verified, downgraded, admissionReasons, evaluations, recordedAt }`. The key is `outcomes/${id}` (line 212). Records are created via `mesh.put({ key, value, ifVersion: 0 })` (line 289) for idempotent CAS-create. Existing `runId` returns the stored record instead of overwriting (line 226). This is the pattern to mirror for per-feature work records.

**Why not the `state` provider**: `state` is a single global CAS head over one transition timeline (`src/state/store.ts`). It has no key namespace for parallel per-feature records and rejects `from`-mismatches against the one global head. It cannot hold multiple concurrent feature records.

**No existing per-feature concept**: a repo-wide search found zero occurrences of `slug`, `active`, `workspace`, or `artifact` as a per-feature workspace concept in source. The only hits are benchmark task identifiers in `bench/tasks/` and evidence-kind enum values.

### 1.3 Prewalk Arm Seam

The prewalk subcommand (`src/commands/fabric.ts:232-297`) is the model for how `/ship` will drive prewalk per task. The critical seam:

```ts
// src/commands/fabric.ts:288
armPrewalk(pi, state.prewalk, state.config.prewalk, context, model, task || undefined);
// ...
// src/commands/fabric.ts:296
if (task) pi.sendUserMessage(task);
```

`armPrewalk` is imported at `src/commands/fabric.ts:6` from `../prewalk/arm.js`. `resolvePrewalkModel` (line 63) resolves the model.

**Prewalk preconditions** (`src/commands/fabric.ts:259`):

```ts
if (!state.config.fullCodeMode || state.config.schema.mode === "enforce") {
  context.ui.notify(
    "Fabric prewalk requires full code mode and Schema enforce mode disabled.",
    "error",
  );
  return;
}
```

`/ship` must check the same preconditions before arming prewalk per task.

---

## 2. Slice A: Per-Feature Record Convention

### 2.1 Record Schema

A new `FabricWorkRecord` type over mesh KV under the `work/` key prefix, mirroring `FabricOutcomeRecord`'s format-version + CAS-create + idempotency pattern.

```ts
interface FabricWorkRecord {
  format: 1;
  slug: string;              // sanitized feature identifier
  phase: "research" | "create" | "plan" | "ship" | "verify" | "done";
  title: string;              // human-readable description
  createdAt: number;           // epoch ms
  updatedAt: number;           // epoch ms
  research?: string;          // digest or inline summary
  spec?: string;              // PRD digest or inline
  plan?: string;              // task list digest or inline
  progress: string[];          // completed task summaries
  evidence: FabricWorkEvidence[];
  gates: FabricWorkGate[];
  status: "active" | "blocked" | "abandoned" | "done";
}

interface FabricWorkEvidence {
  phase: string;
  ref: string;                // file:line or command
  claim: string;
}

interface FabricWorkGate {
  gate: string;
  passed: boolean;
  sequence: number;
  recordedAt: number;
}
```

### 2.2 Key Convention

Key: `work/<slug>` where `<slug>` is sanitized from the feature title.

**Slug sanitization rules** (tested against `KEY_PATTERN` and the unsafe-segment check):

1. Lowercase the title.
2. Replace any run of characters outside `[a-z0-9._:/-]` with a single `-`.
3. Trim leading/trailing `-`.
4. Reject if any `/`-segment equals `__proto__`, `prototype`, or `constructor`.
5. Prefix with `work/`.

The `work/` prefix guarantees the first character is always `w`, so the pattern's first-char rule is always satisfied. Slashes in the slug are valid because `/` is in the key character class, but segments are individually checked for the three unsafe names.

**Validation results** (run in `fabric_exec` against the real `KEY_PATTERN`):

| Input slug | Key | Pattern match | Unsafe segment | Admitted |
|------------|-----|---------------|----------------|---------|
| `add-auth-refresh` | `work/add-auth-refresh` | yes | no | yes |
| `fix_prewalk_loop` | `work/fix_prewalk_loop` | yes | no | yes |
| `feat.2026.q3` | `work/feat.2026.q3` | yes | no | yes |
| `__proto__` | `work/__proto__` | yes | yes | no |
| `has space` | `work/has-space` (sanitized) | yes | no | yes |

A hostile slug containing `__proto__` is rejected by the unsafe-segment rule even though it passes the regex. Spaces are caught by the pattern and must be sanitized to `-` before the key is formed.

### 2.3 Active Work Pointer

A single mesh key `work/.active` holds the current slug. The lifecycle commands read it to determine which feature `/plan`, `/ship`, and `/verify` operate on. `/create` sets it. The value is a plain string (the slug), stored via `mesh.put({ key: "work/.active", value: slug })`.

Key `work/.active` passes validation: starts with `w`, no unsafe segments, matches the pattern.

### 2.4 API Calls

| Operation | Call |
|-----------|------|
| Create record | `mesh.put({ key: \`work/${slug}\`, value: record, ifVersion: 0 })` |
| Read record | `mesh.get({ key: \`work/${slug}\` })` |
| Update record | `mesh.put({ key, value, ifVersion: currentVersion })` (CAS) |
| List all work | `mesh.list({ prefix: "work/" })` |
| Set active | `mesh.put({ key: "work/.active", value: slug })` |
| Read active | `mesh.get({ key: "work/.active" })` |

### 2.5 Concurrency Guard

Mesh KV is shared across all roots and sessions in the project. Concurrent `/ship` runs on the same feature need `ifVersion` CAS plus the existing `leases` provider. `leases.acquire` (`src/runtime/guest-types.ts:1015`) takes `{ paths: Array<{ path: string; scope: "file" | "tree" }>, ttlMs: number }` and returns `{ leases: FabricPathLease[] }`. Active foreign leases block `pi.edit/write` before mutation. `/ship` should acquire a lease on the feature's affected paths before driving prewalk.

---

## 3. Slice B: Lifecycle Commands

Five new subcommands, each bound to a role from the live catalog. All roles are confirmed present via `agents.roles()`.

### 3.1 `/fabric research`

**Description:** Research a topic before implementation. Delegates retrieval to keep Main's context clean.

**Agent:** scout (one-shot, `read,grep,find,ls`)

**Args:**

| Argument | Default | Description |
|----------|---------|-------------|
| `<topic>` | required | The topic or question to research |

**Phases:**

1. **Delegate**: Spawn `agents.run({ role: "scout", task: topic, name: "research-<slug>" })`. Scout is read-only with a 6-turn budget. It returns evidence-backed findings with `file:line` references.
2. **Persist**: Store findings digest in the work record under `research` via `mesh.put` with CAS. If no active work record exists, create one with phase `"research"`.
3. **Report**: `context.ui.notify` with a summary and the work record key.

**Output contract:** Scout returns structured findings. Main stores the digest, not raw prose. The work record's `research` field holds the digest. Evidence entries are appended to `evidence[]`.

**Failure handling:** If the agent times out (`status: "timed_out"`), persist partial findings and notify the user. If no agent is available, fall back to inline retrieval and note the fallback.

### 3.2 `/fabric create`

**Description:** Create a specification (PRD) and define executable tasks. Ready for `/plan` or `/ship`.

**Agent:** planner (one-shot, `read,grep,find,ls`)

**Args:**

| Argument | Default | Description |
|----------|---------|-------------|
| `<description>` | required | What to build or fix (quoted string) |

**Phases:**

1. **Duplicate check**: `mesh.list({ prefix: "work/" })` for existing records with similar title. If found, ask the user whether to continue with `/ship` instead.
2. **Delegate**: Spawn `agents.run({ role: "planner", task: description, name: "create-<slug>" })`. Planner inspects current source and returns ordered changes, affected paths, test seams, and rollback boundaries.
3. **Persist**: Create the work record via `mesh.put({ key: \`work/${slug}\`, value: record, ifVersion: 0 })` with phase `"create"`. Set `work/.active` to the slug.
4. **Report**: Notify with the slug, spec summary, and next step (`/fabric plan` or `/fabric ship`).

**Output contract:** Planner returns a dependency-aware plan. Main stores the spec digest in `spec`, task list digest in `plan`, and affected paths in `evidence[]`. No implementation code is written.

**Failure handling:** If the description is vague, ask clarifying questions before delegating. If the planner returns empty, flag uncertainty with `[NEEDS CLARIFICATION]` markers rather than guessing.

### 3.3 `/fabric plan`

**Description:** Create a detailed implementation plan with TDD steps. Optional between `/create` and `/ship`.

**Agent:** planner (one-shot, `read,grep,find,ls`)

**Args:**

| Argument | Default | Description |
|----------|---------|-------------|
| none | — | Plans based on the active work record's spec |

**Phases:**

1. **Load active**: `mesh.get({ key: "work/.active" })` → slug → `mesh.get({ key: \`work/${slug}\` })`. If no active record or no spec, notify the user to run `/fabric create` first.
2. **Institutional research**: `memory.recall({ query: slug })` for prior decisions and failed approaches.
3. **Delegate**: Spawn `agents.run({ role: "planner", task: planTask, name: "plan-<slug>" })` with the spec digest as context.
4. **Persist**: Update the work record's `plan` field via CAS. Set phase to `"plan"`.
5. **Report**: Notify with the plan summary and next step (`/fabric ship`).

**Output contract:** Planner returns ordered tasks with file lists, dependencies, test seams, and rollback boundaries. Main stores the plan digest. No implementation code is written.

**Failure handling:** If memory recall fails, continue without it and note the gap. If the planner exceeds its turn budget, persist partial plan and flag incomplete coverage.

### 3.4 `/fabric ship`

**Description:** Execute spec tasks via prewalk, verify each passes, run review, mark complete.

**Agent:** worker (one-shot, `read,grep,find,ls,bash,edit,write`) — but driven through prewalk, not spawned directly.

**Args:**

| Argument | Default | Description |
|----------|---------|-------------|
| none | — | Ships the active work record's plan tasks |

**Phases:**

1. **Guards**: Check prewalk preconditions (`src/commands/fabric.ts:259`):
   ```ts
   if (!state.config.fullCodeMode || state.config.schema.mode === "enforce") {
     context.ui.notify("Fabric prewalk requires full code mode and Schema enforce mode disabled.", "error");
     return;
   }
   ```
2. **Load active**: `mesh.get({ key: "work/.active" })` → slug → `mesh.get({ key: \`work/${slug}\` })`. Verify `plan` exists. If not, notify to run `/fabric plan` or `/fabric create` first.
3. **Acquire lease**: `leases.acquire({ paths: affectedPaths, ttlMs: ... })` on the feature's affected paths.
4. **Drive prewalk per task**: For each task in the plan:
   ```ts
   const model = await resolvePrewalkModel(state, context);
   armPrewalk(pi, state.prewalk, state.config.prewalk, context, model, task);
   pi.sendUserMessage(task);
   ```
   Prewalk is the executor. It runs its plan → checklist → executor → verify loop per task. `/ship` does not replace prewalk; it drives it.
5. **Persist progress**: After each prewalk settlement, update the work record's `progress[]` and `evidence[]` via CAS.
6. **Release lease**: `leases.release({ ids: leaseIds })`.
7. **Report**: Notify with completion status and next step (`/fabric verify`).

**Output contract:** Each task produces a prewalk gate result. Main records the gate in `gates[]`, appends the task summary to `progress[]`, and stores evidence refs. The work record's phase advances to `"ship"`.

**Failure handling:** If a prewalk gate returns `passed: false`, persist the failure evidence and stop. Do not auto-retry permanent failures (AGENTS.md: "Never retry permanent failure automatically"). If the lease acquisition fails (another session holds the paths), notify and block.

### 3.5 `/fabric verify`

**Description:** Verify implementation completeness, correctness, and coherence against the spec.

**Agent:** reviewer (one-shot, `read,grep,find,ls,bash`)

**Args:**

| Argument | Default | Description |
|----------|---------|-------------|
| `[path|all]` | `all` | The path or keyword to verify |
| `--quick` | false | Gates only, skip coherence check |
| `--full` | false | Force full verification (non-incremental) |

**Phases:**

1. **Load active**: `mesh.get({ key: "work/.active" })` → slug → `mesh.get({ key: \`work/${slug}\` })`.
2. **Fingerprint cache**: Compute `sha256(git rev-parse HEAD + git diff)` and compare against the last gate's fingerprint in the work record. If unchanged and not `--full`, report cached PASS and skip.
3. **Run gates**: Execute `workflow.gate({ gate: "verify", passed: ..., disposition: "advise", evidence: [...] })` with the gate results.
4. **Delegate review**: Spawn `agents.run({ role: "reviewer", task: reviewTask, name: "verify-<slug>" })` for fresh-context review of the diff and spec.
5. **Persist**: Record the gate result in `gates[]`. If all gates pass and the reviewer finds no blockers, set phase to `"done"` and status to `"done"`.
6. **Report**: Notify with pass/fail per gate, reviewer findings, and next step.

**Output contract:** `workflow.gate` returns `{ decision: "continue" | "revise" | "abort", revision: number }`. The reviewer returns findings ordered by severity with `file:line` evidence. Main records both in the work record.

**Failure handling:** If a gate fails (`decision: "revise"`), persist the feedback and notify. If `decision: "abort"`, stop and set status to `"blocked"`. If the reviewer times out, persist partial findings and flag incomplete review.

---

## 4. Dispatch Insertion Point

New lifecycle commands insert into the `if` chain in `src/commands/fabric.ts` before the terminal fallback at line 758:

```
// ... existing subcommands ...
if (command === "export") { ... }   // line 735

// --- lifecycle commands (insert here) ---
if (command === "research") { ...; return; }
if (command === "create") { ...; return; }
if (command === "plan") { ...; return; }
if (command === "ship") { ...; return; }
if (command === "verify") { ...; return; }

if (command !== "status") { ... }    // line 758 (terminal fallback)
```

Each block must `return` to prevent fall-through into the status fallback.

The `subcommands` array at `src/commands/fabric.ts:107-130` must be extended with the five new names for autocomplete. The usage string at line 759 should be updated to list them.

No new `FabricCommandDeps` fields are needed. All required providers are reachable through `state`: `state.mesh`, `state.agents`, `state.prewalk`, `state.outcomes`, `state.config`.

---

## 5. Prewalk Integration Contract

`/ship` drives prewalk per task. It does not replace prewalk. The contract is:

1. Check prewalk preconditions (`src/commands/fabric.ts:259`):
   ```ts
   if (!state.config.fullCodeMode || state.config.schema.mode === "enforce") {
     context.ui.notify(
       "Fabric prewalk requires full code mode and Schema enforce mode disabled.",
       "error",
     );
     return;
   }
   ```
2. Resolve the model: `const model = await resolvePrewalkModel(state, context)` (line 282).
3. Arm prewalk: `armPrewalk(pi, state.prewalk, state.config.prewalk, context, model, task || undefined)` (line 288). Imported from `../prewalk/arm.js` at line 6.
4. Send the task: `pi.sendUserMessage(task)` (line 296).

Prewalk then owns the in-turn execution loop: plan, checklist, executor, verify. The executor model runs the implementation. Main records the result after settlement.

The `roleModels` config we built applies to the spawned agent roles (scout, planner, reviewer), not to the prewalk executor. The executor model comes from `resolvePrewalkModel` and the `prewalk.model` config.

---

## 6. Bounded-Loop Constraints and the `/pr` Gate

### 6.1 Loop Bounds

AGENTS.md (line 51) requires:

> Bound every loop by attempts, time, tokens, cost, concurrency, and effects.

The lifecycle loop must enforce:

- **Attempts**: A maximum number of `/ship` task iterations per feature (default: the plan's task count; hard cap configurable).
- **Time**: A per-task prewalk timeout from `agents.timeoutMs` (default 60 min).
- **Tokens**: `agents.maxTokensPerChild` caps a single agent. `agents.budgetUsd` caps the whole recursion tree.
- **Concurrency**: `agents.maxConcurrent` (default 4) bounds parallel agents. `/ship` tasks run sequentially via prewalk, one at a time.
- **Effects**: Prewalk's verification gate is non-negotiable. A failed gate stops the loop. AGENTS.md (line 51) also requires: "Never retry permanent failure automatically."

### 6.2 The `/pr` Gate

AGENTS.md (line 80) requires:

> Do not push, publish, release, or change repository visibility unless the user requests it.

`/pr` cannot be an autonomous loop step. It must be:

1. User-initiated only. The loop controller never calls it automatically after `/verify` passes.
2. Explicitly confirmed. Even when the user types `/fabric pr`, the command must show the diff and ask for confirmation before opening a PR.
3. Deferred to Slice C. Slices A and B do not implement `/pr`.

The loop after Slice B is: `/research` → `/create` → `/plan` → `/ship` → `/verify` → (user decides: `/pr` manually or loop back to `/research` for the next slice). The loop does not auto-advance. Each command is a discrete operator action.

---

## 7. Implementation Order

1. **Slice A first**: Create the work record store module (`src/work/store.ts` or `src/lifecycle/store.ts`) mirroring `src/outcomes/store.ts`. Add `FabricWorkRecord` types. Test slug sanitization and CAS create/update against a hermetic mesh.
2. **Slice B second**: Add the five lifecycle command handlers to `src/commands/fabric.ts` before line 758. Extend the `subcommands` array. Wire each to its role via `agents.run` and to the work record store.
3. **Slice C deferred**: Bounded loop controller, `/pr` command, fingerprint cache enforcement, and auto-advance bounds.

Each slice follows the test-first discipline: RED, implement minimum GREEN, refactor. The work record store gets its own test module. The command handlers get integration tests against a hermetic `FabricState`.

---

## 8. Confirmed APIs

Every call named in this document is verified against current source:

| API | Declaration location |
|-----|---------------------|
| `mesh.put` | `src/providers/mesh-provider.ts:110`, `src/mesh/store.ts:512` |
| `mesh.list` | `src/providers/mesh-provider.ts:96` |
| `mesh.get` | `src/providers/mesh-provider.ts:84` |
| `agents.run` | `src/runtime/guest-types.ts:612` |
| `agents.roles` | `src/runtime/guest-types.ts:613` |
| `workflow.gate` | `src/runtime/guest-types.ts:1340` (input: `FabricWorkflowGateInput:1232`) |
| `workflow.durable.run` | `src/runtime/guest-types.ts:1326` |
| `workflow.durable.create` | `src/runtime/guest-types.ts:1318` |
| `leases.acquire` | `src/runtime/guest-types.ts:1015` |
| `leases.release` | `src/runtime/guest-types.ts:1019` |
| `armPrewalk` | `src/commands/fabric.ts:6` (import), `src/prewalk/arm.ts` |
| `resolvePrewalkModel` | `src/commands/fabric.ts:63` |
| `pi.sendUserMessage` | Pi ExtensionAPI |

### Confirmed Roles

| Role | Lifecycle | Tools | Source |
|------|----------|-------|--------|
| scout | one-shot | read,grep,find,ls | `agents/scout.md` |
| explorer | one-shot | read,grep,find,ls,bash | `agents/explorer.md` |
| planner | one-shot | read,grep,find,ls | `agents/planner.md` |
| reviewer | one-shot | read,grep,find,ls,bash | `agents/reviewer.md` |
| worker | one-shot | read,grep,find,ls,bash,edit,write | `agents/worker.md` |

All five are repo-owned builtins in `agents/` and published via `package.json` `files`. All are confirmed live via `agents.roles()`.