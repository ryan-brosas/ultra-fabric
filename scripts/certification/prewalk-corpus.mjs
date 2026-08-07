import { fileURLToPath } from "node:url";

export const PREWALK_REFERENCE_EVALUATOR = fileURLToPath(
  new URL("./prewalk-reference-evaluator.mjs", import.meta.url),
);

const verifierSource = (cases) => `import assert from "node:assert/strict";
import { solve } from "./src/contract.mjs";

const cases = ${JSON.stringify(cases, null, 2)};
for (const testCase of cases) {
  const args = structuredClone(testCase.args);
  if (testCase.throws) {
    let error;
    try { await solve(...args); } catch (caught) { error = caught; }
    assert.ok(error, testCase.name + " should throw");
    assert.match(String(error?.message ?? error), new RegExp(testCase.throws, "i"), testCase.name);
  } else {
    assert.deepStrictEqual(await solve(...args), testCase.expected, testCase.name);
  }
}
`;

const task = ({ id, domain, sourcePaths, requirements, cases, solution }) => ({
  id,
  domain,
  sourcePaths,
  prompt: [
    "Implement the exported solve function in src/contract.mjs.",
    "Read CONTRACT.md, preserve protected files, add no dependencies or files, and run node verify.mjs.",
    "Handle every documented success and controlled-failure case; do not hard-code only the examples.",
  ].join(" "),
  initialFiles: {
    "CONTRACT.md": `# ${id}\n\nDomain: ${domain}\n\n${requirements.trim()}\n`,
    "src/contract.mjs": `export const solve = async () => {\n  throw new Error("${id} is not implemented");\n};\n`,
    "verify.mjs": verifierSource(cases),
  },
  protectedPaths: ["CONTRACT.md", "verify.mjs"],
  solutionFiles: { "src/contract.mjs": solution.trim() + "\n" },
});

const tasks = [
  task({
    id: "prewalk-checklist-normalization",
    domain: "prewalk",
    sourcePaths: ["src/prewalk/checklist.ts", "tests/prewalk-checklist.test.ts"],
    requirements: `solve(input) validates input.items as an array of 5 through 9 objects. Each task and validation must be a non-empty string after trimming and no field may exceed 1000 characters. Return { items } with trimmed fields. Throw an Error mentioning 5-9 for a count violation and concrete for a missing field.`,
    cases: [
      { name: "normalizes five items", args: [{ items: Array.from({ length: 5 }, (_, index) => ({ task: `  task ${index}  `, validation: `  check ${index}  ` })) }], expected: { items: Array.from({ length: 5 }, (_, index) => ({ task: `task ${index}`, validation: `check ${index}` })) } },
      { name: "rejects too few", args: [{ items: Array.from({ length: 4 }, () => ({ task: "x", validation: "y" })) }], throws: "5-9" },
      { name: "rejects blank validation", args: [{ items: [{ task: "1", validation: "ok" }, { task: "2", validation: "ok" }, { task: "3", validation: " " }, { task: "4", validation: "ok" }, { task: "5", validation: "ok" }] }], throws: "concrete" },
    ],
    solution: String.raw`export const solve = (input) => {
  if (!input || typeof input !== "object" || !Array.isArray(input.items) || input.items.length < 5 || input.items.length > 9) throw new Error("checklist requires 5-9 items");
  return { items: input.items.map((item) => {
    if (!item || typeof item !== "object") throw new Error("concrete checklist item required");
    const task = typeof item.task === "string" ? item.task.trim() : "";
    const validation = typeof item.validation === "string" ? item.validation.trim() : "";
    if (!task || !validation) throw new Error("concrete task and validation required");
    if (task.length > 1000 || validation.length > 1000) throw new Error("checklist field exceeds 1000 characters");
    return { task, validation };
  }) };
};`,
  }),
  task({
    id: "prewalk-continuation-ownership",
    domain: "prewalk",
    sourcePaths: ["src/prewalk/continuation.ts", "tests/prewalk-continuation.test.ts"],
    requirements: `solve({ messages, acceptedIds, keepPlanning }) preserves ordinary messages, removes research-plan custom messages unless keepPlanning is true, and keeps continuation custom messages only when details.continuationId is a non-empty accepted ID. Return { messages, changed }.`,
    cases: [
      { name: "filters stale phase messages", args: [{ keepPlanning: false, acceptedIds: ["good"], messages: [{ role: "user", text: "task" }, { role: "custom", customType: "pi-fabric-prewalk-research-plan" }, { role: "custom", customType: "pi-fabric-prewalk-continue", details: { continuationId: "good" } }, { role: "custom", customType: "pi-fabric-prewalk-continue", details: { continuationId: "stale" } }] }], expected: { messages: [{ role: "user", text: "task" }, { role: "custom", customType: "pi-fabric-prewalk-continue", details: { continuationId: "good" } }], changed: true } },
      { name: "preserves unrelated context", args: [{ keepPlanning: true, acceptedIds: [], messages: [{ role: "user", text: "task" }] }], expected: { messages: [{ role: "user", text: "task" }], changed: false } },
    ],
    solution: String.raw`export const solve = ({ messages, acceptedIds, keepPlanning }) => {
  const accepted = new Set(acceptedIds);
  const filtered = messages.filter((message) => {
    if (message.role !== "custom") return true;
    if (message.customType === "pi-fabric-prewalk-research-plan") return keepPlanning;
    if (message.customType !== "pi-fabric-prewalk-continue") return true;
    const id = message.details && typeof message.details === "object" ? message.details.continuationId : undefined;
    return typeof id === "string" && id.length > 0 && accepted.has(id);
  });
  return { messages: filtered, changed: filtered.length !== messages.length };
};`,
  }),
  task({
    id: "persistent-delivery-policy",
    domain: "persistent-agents",
    sourcePaths: ["src/agents/persistent/delivery-policy.ts", "tests/persistent-agent-delivery-policy.test.ts"],
    requirements: `solve(input) resolves delivery to mailbox by default. Active steer/followUp delivery requires an explicit boolean triggerTurn. Passive mailbox/nextTurn can never use triggerTurn true and resolve false otherwise. Reject unknown delivery. Return { delivery, triggerTurn }.`,
    cases: [
      { name: "defaults mailbox", args: [{}], expected: { delivery: "mailbox", triggerTurn: false } },
      { name: "active explicit", args: [{ delivery: "steer", triggerTurn: true }], expected: { delivery: "steer", triggerTurn: true } },
      { name: "active requires intent", args: [{ delivery: "followUp" }], throws: "explicit" },
      { name: "passive never starts main", args: [{ delivery: "nextTurn", triggerTurn: true }], throws: "never starts" },
    ],
    solution: String.raw`const active = new Set(["steer", "followUp"]);
const passive = new Set(["mailbox", "nextTurn"]);
export const solve = ({ delivery = "mailbox", triggerTurn } = {}) => {
  if (!active.has(delivery) && !passive.has(delivery)) throw new Error("invalid delivery");
  if (active.has(delivery)) {
    if (typeof triggerTurn !== "boolean") throw new Error("active delivery requires explicit trigger intent");
    return { delivery, triggerTurn };
  }
  if (triggerTurn === true) throw new Error("passive delivery never starts Main");
  return { delivery, triggerTurn: false };
};`,
  }),
  task({
    id: "persistent-delivery-notice",
    domain: "persistent-agents",
    sourcePaths: ["src/agents/persistent/delivery-policy.ts", "tests/persistent-agent-delivery-policy.test.ts"],
    requirements: `solve({ delivery, triggerTurn }) returns deferred for nextTurn, passive for steer/followUp with triggerTurn false, and null for an active triggered continuation.`,
    cases: [
      { name: "deferred", args: [{ delivery: "nextTurn", triggerTurn: false }], expected: "deferred" },
      { name: "passive", args: [{ delivery: "steer", triggerTurn: false }], expected: "passive" },
      { name: "active", args: [{ delivery: "followUp", triggerTurn: true }], expected: null },
    ],
    solution: String.raw`export const solve = ({ delivery, triggerTurn }) => delivery === "nextTurn" ? "deferred" : triggerTurn ? null : "passive";`,
  }),
  task({
    id: "retry-bounded-backoff",
    domain: "reliability",
    sourcePaths: ["src/retry.ts", "tests/retry.test.ts"],
    requirements: `solve(input) simulates bounded retry. failures is the number of transient failures before success, terminalAt optionally marks an attempt permanent, and samples supplies deterministic 0-1 jitter samples. Delay after failed attempt n is min(baseDelayMs*2^(n-1), maxDelayMs) + sample*jitterMs. Return attempts, delays, and outcome success, terminal, or exhausted.`,
    cases: [
      { name: "first success", args: [{ maxAttempts: 4, failures: 0, baseDelayMs: 100, maxDelayMs: 250, jitterMs: 20, samples: [] }], expected: { attempts: 1, delays: [], outcome: "success" } },
      { name: "capped with jitter", args: [{ maxAttempts: 4, failures: 3, baseDelayMs: 100, maxDelayMs: 250, jitterMs: 20, samples: [0.5, 1, 0.25] }], expected: { attempts: 4, delays: [110, 220, 255], outcome: "success" } },
      { name: "terminal stops", args: [{ maxAttempts: 5, failures: 5, terminalAt: 2, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0, samples: [0] }], expected: { attempts: 2, delays: [10], outcome: "terminal" } },
      { name: "exhausts", args: [{ maxAttempts: 2, failures: 5, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0, samples: [0] }], expected: { attempts: 2, delays: [10], outcome: "exhausted" } },
    ],
    solution: String.raw`export const solve = (input) => {
  const delays = [];
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    if (input.terminalAt === attempt) return { attempts: attempt, delays, outcome: "terminal" };
    if (attempt > input.failures) return { attempts: attempt, delays, outcome: "success" };
    if (attempt === input.maxAttempts) return { attempts: attempt, delays, outcome: "exhausted" };
    const exponential = Math.min(input.baseDelayMs * 2 ** (attempt - 1), input.maxDelayMs);
    delays.push(exponential + (input.samples[attempt - 1] ?? 0) * input.jitterMs);
  }
  return { attempts: 0, delays, outcome: "exhausted" };
};`,
  }),
  task({
    id: "persistent-validity-decision",
    domain: "persistent-agents",
    sourcePaths: ["src/agents/persistent/predicate.ts", "tests/persistent-agent-valid-while.test.ts"],
    requirements: `solve(value) normalizes a synchronous validity decision. A boolean returns { valid }. An object requires boolean valid and may include a trimmed non-empty reason. Reject arrays, promises represented by { then: true }, and malformed values with an Error mentioning boolean.`,
    cases: [
      { name: "boolean", args: [true], expected: { valid: true } },
      { name: "diagnostic", args: [{ valid: false, reason: "  stale activation  " }], expected: { valid: false, reason: "stale activation" } },
      { name: "blank reason omitted", args: [{ valid: true, reason: " " }], expected: { valid: true } },
      { name: "malformed rejected", args: [{ valid: "yes" }], throws: "boolean" },
      { name: "async-like rejected", args: [{ valid: true, then: true }], throws: "synchronous" },
    ],
    solution: String.raw`export const solve = (value) => {
  if (typeof value === "boolean") return { valid: value };
  if (value && typeof value === "object" && "then" in value) {
    throw new Error("validity decision must return synchronously");
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.valid === "boolean") {
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    return { valid: value.valid, ...(reason ? { reason } : {}) };
  }
  throw new Error("decision must be a boolean or object with boolean valid");
};`,
  }),
  task({
    id: "run-envelope-validation",
    domain: "run-context",
    sourcePaths: ["src/run/context.ts", "tests/run-context.test.ts"],
    requirements: `solve(value) returns true only for a version-1 run envelope with non-empty runId, traceId, spanId, objectiveDigest, cancellationOwner, finite numeric startedAt/deadline, and optional string parentRunId/parentSpanId. Arrays and malformed fields return false.`,
    cases: [
      { name: "valid", args: [{ version: 1, runId: "run", traceId: "trace", spanId: "span", objectiveDigest: "digest", startedAt: 1, deadline: 2, cancellationOwner: "main", parentRunId: "parent" }], expected: true },
      { name: "empty identity", args: [{ version: 1, runId: "", traceId: "trace", spanId: "span", objectiveDigest: "digest", startedAt: 1, deadline: 2, cancellationOwner: "main" }], expected: false },
      { name: "wrong numeric type", args: [{ version: 1, runId: "run", traceId: "trace", spanId: "span", objectiveDigest: "digest", startedAt: "1", deadline: 2, cancellationOwner: "main" }], expected: false },
    ],
    solution: String.raw`export const solve = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const text = (field) => typeof value[field] === "string" && value[field].length > 0;
  return value.version === 1 && text("runId") && text("traceId") && text("spanId") && text("objectiveDigest") && text("cancellationOwner") &&
    Number.isFinite(value.startedAt) && Number.isFinite(value.deadline) &&
    (value.parentRunId === undefined || typeof value.parentRunId === "string") &&
    (value.parentSpanId === undefined || typeof value.parentSpanId === "string");
};`,
  }),
  task({
    id: "path-lease-conflicts",
    domain: "coordination",
    sourcePaths: ["src/leases/path-leases.ts", "tests/path-leases.test.ts"],
    requirements: `solve({ left, right }) determines whether two canonical POSIX lease requests conflict. Equal paths conflict. A tree conflicts with any descendant path. A file lease does not own descendants. Sibling prefixes such as src/a and src/ab do not overlap.`,
    cases: [
      { name: "same file", args: [{ left: { path: "/repo/a", scope: "file" }, right: { path: "/repo/a", scope: "file" } }], expected: true },
      { name: "tree descendant", args: [{ left: { path: "/repo/src", scope: "tree" }, right: { path: "/repo/src/a.ts", scope: "file" } }], expected: true },
      { name: "file no descendants", args: [{ left: { path: "/repo/src", scope: "file" }, right: { path: "/repo/src/a.ts", scope: "file" } }], expected: false },
      { name: "prefix sibling", args: [{ left: { path: "/repo/src/a", scope: "tree" }, right: { path: "/repo/src/ab/x", scope: "file" } }], expected: false },
    ],
    solution: String.raw`const within = (root, target) => target === root || target.startsWith(root.endsWith("/") ? root : root + "/");
export const solve = ({ left, right }) => left.path === right.path || (left.scope === "tree" && within(left.path, right.path)) || (right.scope === "tree" && within(right.path, left.path));`,
  }),
  task({
    id: "durable-workflow-readiness",
    domain: "workflows",
    sourcePaths: ["src/workflows/durable.ts", "tests/durable-workflow.test.ts"],
    requirements: `solve(phases) clones phases, changes pending phases to ready only when every dependency is completed, then reports workflow status: completed when all complete; partial when failed and any complete; failed when failed and none complete; running when any running; otherwise queued.`,
    cases: [
      { name: "diamond readiness", args: [[{ id: "a", deps: [], status: "completed" }, { id: "b", deps: ["a"], status: "pending" }, { id: "c", deps: ["a"], status: "pending" }, { id: "d", deps: ["b", "c"], status: "pending" }]], expected: { phases: [{ id: "a", deps: [], status: "completed" }, { id: "b", deps: ["a"], status: "ready" }, { id: "c", deps: ["a"], status: "ready" }, { id: "d", deps: ["b", "c"], status: "pending" }], status: "queued" } },
      { name: "partial failure", args: [[{ id: "a", deps: [], status: "completed" }, { id: "b", deps: ["a"], status: "failed" }]], expected: { phases: [{ id: "a", deps: [], status: "completed" }, { id: "b", deps: ["a"], status: "failed" }], status: "partial" } },
      { name: "complete", args: [[{ id: "a", deps: [], status: "completed" }]], expected: { phases: [{ id: "a", deps: [], status: "completed" }], status: "completed" } },
    ],
    solution: String.raw`export const solve = (input) => {
  const phases = structuredClone(input);
  const completed = new Set(phases.filter((phase) => phase.status === "completed").map((phase) => phase.id));
  for (const phase of phases) if (phase.status === "pending" && phase.deps.every((id) => completed.has(id))) phase.status = "ready";
  let status = "queued";
  if (phases.every((phase) => phase.status === "completed")) status = "completed";
  else if (phases.some((phase) => phase.status === "failed")) status = phases.some((phase) => phase.status === "completed") ? "partial" : "failed";
  else if (phases.some((phase) => phase.status === "running")) status = "running";
  return { phases, status };
};`,
  }),
  task({
    id: "context-qos-supersession",
    domain: "context-qos",
    sourcePaths: ["src/context/qos.ts", "tests/context-qos.test.ts"],
    requirements: `solve(entries) receives result summaries with id, key, name, body, and optional error/evidence/recent flags. Only read/grep/find/ls entries may retire. Replace an old non-protected duplicate body with a marker naming the newest equivalent ID. Return entries plus retired and protected counts.`,
    cases: [
      { name: "retires only old safe duplicate", args: [[{ id: "1", key: "read:a", name: "read", body: "old" }, { id: "2", key: "read:a", name: "read", body: "new" }, { id: "3", key: "write:a", name: "write", body: "mutation" }]], expected: { entries: [{ id: "1", key: "read:a", name: "read", body: "[retired by 2]" }, { id: "2", key: "read:a", name: "read", body: "new" }, { id: "3", key: "write:a", name: "write", body: "mutation" }], retired: 1, protected: 1 } },
      { name: "protects errors evidence and recent", args: [[{ id: "1", key: "read:a", name: "read", body: "error", error: true }, { id: "2", key: "read:a", name: "read", body: "evidence", evidence: true }, { id: "3", key: "read:a", name: "read", body: "recent", recent: true }]], expected: { entries: [{ id: "1", key: "read:a", name: "read", body: "error", error: true }, { id: "2", key: "read:a", name: "read", body: "evidence", evidence: true }, { id: "3", key: "read:a", name: "read", body: "recent", recent: true }], retired: 0, protected: 3 } },
    ],
    solution: String.raw`const retriable = new Set(["read", "grep", "find", "ls"]);
export const solve = (input) => {
  const entries = structuredClone(input);
  const latest = new Map();
  let protectedCount = 0;
  entries.forEach((entry, index) => {
    if (!retriable.has(entry.name) || entry.error || entry.evidence || entry.recent) protectedCount++;
    if (retriable.has(entry.name) && !entry.error && !entry.evidence) latest.set(entry.key, { index, id: entry.id });
  });
  let retired = 0;
  entries.forEach((entry, index) => {
    const replacement = latest.get(entry.key);
    if (!retriable.has(entry.name) || entry.error || entry.evidence || entry.recent || !replacement || replacement.index === index) return;
    entry.body = "[retired by " + replacement.id + "]";
    retired++;
  });
  return { entries, retired, protected: protectedCount };
};`,
  }),
  task({
    id: "capability-aware-model-route",
    domain: "routing",
    sourcePaths: ["src/routing/model-router.ts", "tests/model-router.test.ts"],
    requirements: `solve(input) considers requestedModel then unique fallbacks. Eligibility requires available, authenticated, all required input modalities, optional reasoning, minimum context/output, and maximum costs. A fallback that loses primary context/output/reasoning/input is a quality downgrade and must be rejected unless allowed. Return selectedModel, kind, quality, and downgradeReasons or throw no eligible.`,
    cases: [
      { name: "capability fallback", args: [{ requestedModel: "primary", fallbackModels: ["vision"], requirements: { input: ["image"] }, allowQualityDowngrade: false, candidates: [{ key: "primary", available: true, authenticated: true, input: ["text"], reasoning: true, contextWindow: 100, maxTokens: 50, inputCost: 1, outputCost: 1 }, { key: "vision", available: true, authenticated: true, input: ["text", "image"], reasoning: true, contextWindow: 100, maxTokens: 50, inputCost: 1, outputCost: 1 }] }], expected: { selectedModel: "vision", kind: "fallback", quality: "preserved", downgradeReasons: [] } },
      { name: "blocks downgrade", args: [{ requestedModel: "primary", fallbackModels: ["small"], requirements: {}, allowQualityDowngrade: false, candidates: [{ key: "primary", available: true, authenticated: false, input: ["text"], reasoning: true, contextWindow: 100, maxTokens: 50, inputCost: 1, outputCost: 1 }, { key: "small", available: true, authenticated: true, input: ["text"], reasoning: false, contextWindow: 50, maxTokens: 25, inputCost: 0.5, outputCost: 0.5 }] }], throws: "no eligible" },
      { name: "allows downgrade", args: [{ requestedModel: "primary", fallbackModels: ["small"], requirements: {}, allowQualityDowngrade: true, candidates: [{ key: "primary", available: true, authenticated: false, input: ["text"], reasoning: true, contextWindow: 100, maxTokens: 50, inputCost: 1, outputCost: 1 }, { key: "small", available: true, authenticated: true, input: ["text"], reasoning: false, contextWindow: 50, maxTokens: 25, inputCost: 0.5, outputCost: 0.5 }] }], expected: { selectedModel: "small", kind: "fallback", quality: "downgraded", downgradeReasons: ["smaller_context", "smaller_output", "reasoning_lost"] } },
    ],
    solution: String.raw`const hard = (candidate, req) => !candidate.available || !candidate.authenticated || (req.input ?? []).some((kind) => !candidate.input.includes(kind)) || (req.reasoning && !candidate.reasoning) || (req.minContextWindow !== undefined && candidate.contextWindow < req.minContextWindow) || (req.minOutputTokens !== undefined && candidate.maxTokens < req.minOutputTokens) || (req.maxInputCost !== undefined && candidate.inputCost > req.maxInputCost) || (req.maxOutputCost !== undefined && candidate.outputCost > req.maxOutputCost);
const quality = (primary, candidate) => [...(candidate.contextWindow < primary.contextWindow ? ["smaller_context"] : []), ...(candidate.maxTokens < primary.maxTokens ? ["smaller_output"] : []), ...(primary.reasoning && !candidate.reasoning ? ["reasoning_lost"] : []), ...primary.input.filter((kind) => !candidate.input.includes(kind)).map((kind) => "input_lost:" + kind)];
export const solve = (input) => {
  const byKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate]));
  const primary = byKey.get(input.requestedModel);
  for (const [index, key] of [...new Set([input.requestedModel, ...input.fallbackModels])].entries()) {
    const candidate = byKey.get(key);
    if (!candidate || hard(candidate, input.requirements ?? {})) continue;
    const downgradeReasons = index > 0 && primary?.available ? quality(primary, candidate) : [];
    if (downgradeReasons.length && !input.allowQualityDowngrade) continue;
    return { selectedModel: key, kind: index === 0 ? "primary" : "fallback", quality: downgradeReasons.length ? "downgraded" : "preserved", downgradeReasons };
  }
  throw new Error("no eligible model route");
};`,
  }),
  task({
    id: "quality-language-detection",
    domain: "quality",
    sourcePaths: ["src/quality/languages.ts", "tests/quality-languages.test.ts"],
    requirements: `solve({ filePath, content, overrides }) returns a normalized language. Binary NUL content wins. Exact lowercase basename or extension overrides win next. Recognize TypeScript, JavaScript, Python, Dockerfile variants, Makefile, and extensionless shell/python/node shebangs; otherwise unknown.`,
    cases: [
      { name: "typescript", args: [{ filePath: "src/a.TS", content: "" }], expected: "typescript" },
      { name: "docker variant", args: [{ filePath: "Dockerfile.dev", content: "" }], expected: "dockerfile" },
      { name: "shebang", args: [{ filePath: "bin/tool", content: "#!/usr/bin/env python3\nprint('x')" }], expected: "python" },
      { name: "override", args: [{ filePath: "schema.foo", content: "", overrides: { ".foo": "Custom" } }], expected: "custom" },
      { name: "binary", args: [{ filePath: "a.ts", content: "x\u0000y" }], expected: "binary" },
    ],
    solution: String.raw`import path from "node:path";
export const solve = ({ filePath, content = "", overrides = {} }) => {
  if (content.includes("\0")) return "binary";
  const basename = path.posix.basename(filePath.replaceAll("\\", "/")).toLowerCase();
  const extension = path.posix.extname(basename).toLowerCase();
  const override = overrides[basename] ?? overrides[extension];
  if (typeof override === "string" && override.trim()) return override.trim().toLowerCase();
  if (basename === "dockerfile" || basename === "containerfile" || basename.startsWith("dockerfile.") || basename.startsWith("containerfile.")) return "dockerfile";
  if (basename === "makefile") return "makefile";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if ([".py", ".pyi"].includes(extension)) return "python";
  const first = content.startsWith("#!") ? content.split("\n", 1)[0] : "";
  if (/python[0-9.]*/i.test(first)) return "python";
  if (/\b(?:bash|dash|zsh|ksh|sh)\b/i.test(first)) return "shell";
  if (/\b(?:node|deno|bun)\b/i.test(first)) return "javascript";
  return "unknown";
};`,
  }),
  task({
    id: "quality-check-planning",
    domain: "quality",
    sourcePaths: ["src/quality/policy.ts", "tests/quality-policy.test.ts"],
    requirements: `solve({ changedFiles, definitions, ignoredLanguages }) deduplicates changed paths using the last entry, normalizes language case, ignores configured languages, plans each definition once for matching languages or wildcard *, and returns languages, checks with id/languages/paths, and uncoveredLanguages in encounter order.`,
    cases: [
      { name: "plans and reports coverage", args: [{ changedFiles: [{ path: "a.ts", language: "TypeScript" }, { path: "a.ts", language: "typescript" }, { path: "b.foo", language: "custom" }, { path: "x.bin", language: "binary" }], definitions: [{ id: "ts", languages: ["typescript"] }, { id: "all", languages: ["*"] }], ignoredLanguages: ["binary"] }], expected: { languages: ["typescript", "custom"], checks: [{ id: "ts", languages: ["typescript"], paths: ["a.ts"] }, { id: "all", languages: ["typescript", "custom"], paths: ["a.ts", "b.foo"] }], uncoveredLanguages: [] } },
      { name: "uncovered", args: [{ changedFiles: [{ path: "a.rs", language: "rust" }], definitions: [], ignoredLanguages: [] }], expected: { languages: ["rust"], checks: [], uncoveredLanguages: ["rust"] } },
    ],
    solution: String.raw`const unique = (values) => [...new Set(values)];
export const solve = ({ changedFiles, definitions, ignoredLanguages }) => {
  const ignored = new Set(ignoredLanguages.map((value) => value.trim().toLowerCase()));
  const files = [...new Map(changedFiles.map((file) => [file.path, { path: file.path, language: file.language.trim().toLowerCase() || "unknown" }])).values()].filter((file) => !ignored.has(file.language));
  const languages = unique(files.map((file) => file.language));
  const covered = new Set();
  const checks = [];
  for (const definition of definitions) {
    const accepted = new Set(definition.languages.map((value) => value.trim().toLowerCase()));
    const matching = files.filter((file) => accepted.has("*") || accepted.has(file.language));
    if (!matching.length) continue;
    const matched = unique(matching.map((file) => file.language));
    matched.forEach((language) => covered.add(language));
    checks.push({ id: definition.id, languages: matched, paths: matching.map((file) => file.path) });
  }
  return { languages, checks, uncoveredLanguages: languages.filter((language) => !covered.has(language)) };
};`,
  }),
  task({
    id: "quality-policy-verdict",
    domain: "quality",
    sourcePaths: ["src/quality/policy.ts", "tests/quality-policy.test.ts"],
    requirements: `solve({ mode, plan, executions }) returns off with no issues in off mode. Otherwise every uncovered language is an issue; each planned check without a result is crashed; non-passed outcomes remain distinct. No issues means pass, audit issues mean warn, and enforce issues mean block.`,
    cases: [
      { name: "off", args: [{ mode: "off", plan: { uncoveredLanguages: ["ts"], checks: ["a"] }, executions: [] }], expected: { decision: "off", issues: [] } },
      { name: "pass", args: [{ mode: "enforce", plan: { uncoveredLanguages: [], checks: ["a"] }, executions: [{ checkId: "a", outcome: "passed" }] }], expected: { decision: "pass", issues: [] } },
      { name: "audit warns", args: [{ mode: "audit", plan: { uncoveredLanguages: ["rust"], checks: ["a"] }, executions: [{ checkId: "a", outcome: "timed_out" }] }], expected: { decision: "warn", issues: [{ kind: "uncovered", language: "rust" }, { kind: "check", checkId: "a", outcome: "timed_out" }] } },
      { name: "missing crashes", args: [{ mode: "enforce", plan: { uncoveredLanguages: [], checks: ["a"] }, executions: [] }], expected: { decision: "block", issues: [{ kind: "check", checkId: "a", outcome: "crashed" }] } },
    ],
    solution: String.raw`export const solve = ({ mode, plan, executions }) => {
  if (mode === "off") return { decision: "off", issues: [] };
  const byId = new Map(executions.map((entry) => [entry.checkId, entry.outcome]));
  const issues = plan.uncoveredLanguages.map((language) => ({ kind: "uncovered", language }));
  for (const checkId of plan.checks) {
    const outcome = byId.get(checkId) ?? "crashed";
    if (outcome !== "passed") issues.push({ kind: "check", checkId, outcome });
  }
  return { decision: issues.length === 0 ? "pass" : mode === "enforce" ? "block" : "warn", issues };
};`,
  }),
  task({
    id: "memory-query-planning",
    domain: "memory",
    sourcePaths: ["src/memory/tokenize.ts", "tests/memory.test.ts"],
    requirements: `solve({ query, mode }) returns browse for null or blank. Regex mode preserves the exact nonblank pattern. Literal mode NFKC-normalizes Unicode, extracts letter/number/underscore tokens, lowercases them, and returns unique terms in first-seen order. Literal input is never compiled as regex.`,
    cases: [
      { name: "browse", args: [{ query: "  ", mode: "literal" }], expected: { kind: "browse" } },
      { name: "literal unicode", args: [{ query: "Ｆoo foo BÄR_2!", mode: "literal" }], expected: { kind: "terms", terms: ["foo", "bär_2"] } },
      { name: "regex exact", args: [{ query: "Foo.*BAR", mode: "regex" }], expected: { kind: "regex", pattern: "Foo.*BAR" } },
    ],
    solution: String.raw`const tokenize = (text) => [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0].toLowerCase());
export const solve = ({ query, mode = "literal" }) => {
  if (query === null || typeof query !== "string" || query.trim().length === 0) return { kind: "browse" };
  if (mode === "regex") return { kind: "regex", pattern: query };
  return { kind: "terms", terms: [...new Set(tokenize(query))] };
};`,
  }),
  task({
    id: "consult-path-normalization",
    domain: "consult",
    sourcePaths: ["src/consult/policy.ts", "tests/consult-policy.test.ts"],
    requirements: `solve(value) returns a portable normalized relative path or null. Trim, convert backslashes, remove repeated leading ./ and trailing slashes. Reject blank, absolute, home, drive-letter, dot, dot-dot, empty segments, NUL, and values over 1024 characters.`,
    cases: [
      { name: "normalizes", args: ["  ././src\\policy/test.ts///  "], expected: "src/policy/test.ts" },
      { name: "rejects parent", args: ["src/../secret"], expected: null },
      { name: "rejects absolute", args: ["/etc/passwd"], expected: null },
      { name: "rejects empty segment", args: ["src//file"], expected: null },
    ],
    solution: String.raw`export const solve = (value) => {
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) return null;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:\//.test(normalized) || parts.includes("..") || parts.includes(".") || parts.includes("")) return null;
  return normalized;
};`,
  }),
  task({
    id: "consult-admission-modes",
    domain: "consult",
    sourcePaths: ["src/consult/policy.ts", "tests/consult-policy.test.ts"],
    requirements: `solve(input) resolves auto justification independent_verification to challenge, structural_diversity to compare, otherwise partition. Enforce maxWorkers. Challenge requires exactly one perspective and proposal. Partition requires at least two; all-unscoped is allowed, mixed scoped/unscoped is rejected, and declared scopes must not overlap. Compare requires at least two; every overlapping pair needs distinct non-empty model IDs. Return { kind: admitted, mode } or { kind: not_admitted, code }.`,
    cases: [
      { name: "challenge", args: [{ mode: "auto", justification: "independent_verification", proposal: "ship", maxWorkers: 3, perspectives: [{ scope: [], model: "a/m" }] }], expected: { kind: "admitted", mode: "challenge" } },
      { name: "partition", args: [{ mode: "partition", justification: "context_capacity", maxWorkers: 3, perspectives: [{ scope: ["src/a"] }, { scope: ["src/b"] }] }], expected: { kind: "admitted", mode: "partition" } },
      { name: "all unscoped partition", args: [{ mode: "partition", justification: "context_capacity", maxWorkers: 3, perspectives: [{ scope: [] }, { scope: [] }] }], expected: { kind: "admitted", mode: "partition" } },
      { name: "mixed scope rejected", args: [{ mode: "partition", justification: "context_capacity", maxWorkers: 3, perspectives: [{ scope: [] }, { scope: ["src/a"] }] }], expected: { kind: "not_admitted", code: "overlapping_scope" } },
      { name: "overlap rejected", args: [{ mode: "partition", justification: "context_capacity", maxWorkers: 3, perspectives: [{ scope: ["src"] }, { scope: ["src/a"] }] }], expected: { kind: "not_admitted", code: "overlapping_scope" } },
      { name: "compare needs diversity", args: [{ mode: "compare", justification: "structural_diversity", maxWorkers: 3, perspectives: [{ scope: ["src"], model: "a/m" }, { scope: ["src/a"], model: "a/m" }] }], expected: { kind: "not_admitted", code: "insufficient_diversity" } },
    ],
    solution: String.raw`const overlap = (left, right) => left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
const declaredOverlap = (left, right) => left.scope.some((a) => right.scope.some((b) => overlap(a, b)));
const scopesOverlap = (left, right) => left.scope.length === 0 || right.scope.length === 0 || declaredOverlap(left, right);
export const solve = (input) => {
  const mode = input.mode !== "auto" ? input.mode : input.justification === "independent_verification" ? "challenge" : input.justification === "structural_diversity" ? "compare" : "partition";
  if (input.perspectives.length > input.maxWorkers) return { kind: "not_admitted", code: "worker_limit" };
  if (mode === "challenge") return input.perspectives.length === 1 && input.proposal ? { kind: "admitted", mode } : { kind: "not_admitted", code: input.proposal ? "insufficient_perspectives" : "challenge_requires_proposal" };
  if (input.perspectives.length < 2) return { kind: "not_admitted", code: "insufficient_perspectives" };
  if (mode === "partition") {
    const unscoped = input.perspectives.filter((entry) => entry.scope.length === 0).length;
    const mixed = unscoped > 0 && unscoped < input.perspectives.length;
    const overlapFound = input.perspectives.some((left, index) => input.perspectives.slice(index + 1).some((right) => declaredOverlap(left, right)));
    return mixed || overlapFound ? { kind: "not_admitted", code: "overlapping_scope" } : { kind: "admitted", mode };
  }
  const distinct = input.perspectives.every((left, index) => input.perspectives.slice(index + 1).every((right) => !scopesOverlap(left, right) || (left.model && right.model && left.model !== right.model)));
  return distinct ? { kind: "admitted", mode } : { kind: "not_admitted", code: "insufficient_diversity" };
};`,
  }),
  task({
    id: "deterministic-outcome-scoring",
    domain: "outcomes",
    sourcePaths: ["src/outcomes/store.ts", "tests/outcome-store.test.ts"],
    requirements: `solve(input) supports exact, contains, and numeric scoring. Exact compares recursively canonicalized JSON objects independent of key order. Contains requires two strings and substring inclusion. Numeric requires finite numbers and absolute difference <= nonnegative finite tolerance default 0. Return { score: 0|1, passed }.`,
    cases: [
      { name: "canonical exact", args: [{ scorer: "exact", actual: { b: 2, a: { y: 2, x: 1 } }, expected: { a: { x: 1, y: 2 }, b: 2 } }], expected: { score: 1, passed: true } },
      { name: "contains", args: [{ scorer: "contains", actual: "alpha beta", expected: "beta" }], expected: { score: 1, passed: true } },
      { name: "numeric tolerance", args: [{ scorer: "numeric", actual: 10.1, expected: 10, tolerance: 0.11 }], expected: { score: 1, passed: true } },
      { name: "numeric miss", args: [{ scorer: "numeric", actual: 10.2, expected: 10, tolerance: 0.1 }], expected: { score: 0, passed: false } },
    ],
    solution: String.raw`const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const solve = (input) => {
  let passed = false;
  if (input.scorer === "exact") passed = JSON.stringify(canonical(input.actual)) === JSON.stringify(canonical(input.expected));
  else if (input.scorer === "contains") passed = typeof input.actual === "string" && typeof input.expected === "string" && input.actual.includes(input.expected);
  else {
    const tolerance = Number.isFinite(input.tolerance) && input.tolerance >= 0 ? input.tolerance : 0;
    passed = Number.isFinite(input.actual) && Number.isFinite(input.expected) && Math.abs(input.actual - input.expected) <= tolerance;
  }
  return { score: passed ? 1 : 0, passed };
};`,
  }),
  task({
    id: "retention-root-decision",
    domain: "retention",
    sourcePaths: ["src/storage/retention.ts", "tests/retention.test.ts"],
    requirements: `solve(input) classifies a temporary run root. current roots and live owners stay keep. Closed owners return prune_terminal_runs. A dead owner without orphanedAt returns mark_orphaned. A dead owner whose orphan age reaches retention returns remove_root, otherwise keep. A missing owner is removed only when empty and age reaches retention.`,
    cases: [
      { name: "current", args: [{ current: true, owner: null, empty: true, ageMs: 100, retentionMs: 10 }], expected: "keep" },
      { name: "closed", args: [{ current: false, owner: { alive: false, closedAt: 1 }, empty: false, ageMs: 0, retentionMs: 10 }], expected: "prune_terminal_runs" },
      { name: "mark dead", args: [{ current: false, owner: { alive: false }, empty: false, ageMs: 20, retentionMs: 10 }], expected: "mark_orphaned" },
      { name: "remove orphan", args: [{ current: false, owner: { alive: false, orphanAgeMs: 10 }, empty: false, ageMs: 0, retentionMs: 10 }], expected: "remove_root" },
      { name: "missing stale empty", args: [{ current: false, owner: null, empty: true, ageMs: 10, retentionMs: 10 }], expected: "remove_root" },
    ],
    solution: String.raw`export const solve = ({ current, owner, empty, ageMs, retentionMs }) => {
  if (current) return "keep";
  if (!owner) return empty && ageMs >= retentionMs ? "remove_root" : "keep";
  if (owner.closedAt !== undefined) return "prune_terminal_runs";
  if (owner.alive) return "keep";
  if (owner.orphanAgeMs === undefined) return "mark_orphaned";
  return owner.orphanAgeMs >= retentionMs ? "remove_root" : "keep";
};`,
  }),
  task({
    id: "budget-ledger-rollup",
    domain: "reliability",
    sourcePaths: ["tests/support/budget-ledger-detail.ts", "tests/budget-ledger.test.ts"],
    requirements: `solve(lines) tolerantly parses JSONL-like strings or object rows. Count only rows with string id and finite numeric cost, tokens, and ts. Sum cost/tokens and attribute each valid row to runner or unknown. Malformed rows are ignored. Return { cost, tokens, byRunner }.`,
    cases: [
      { name: "tolerant attribution", args: [[{ id: "a", cost: 1.5, tokens: 10, ts: 1, runner: "pi" }, "not json", "{\"id\":\"b\",\"cost\":0.5,\"tokens\":4,\"ts\":2}", { id: "bad", cost: "x", tokens: 2, ts: 3 }]], expected: { cost: 2, tokens: 14, byRunner: { pi: { cost: 1.5, tokens: 10 }, unknown: { cost: 0.5, tokens: 4 } } } },
      { name: "empty", args: [[]], expected: { cost: 0, tokens: 0, byRunner: {} } },
    ],
    solution: String.raw`export const solve = (lines) => {
  const result = { cost: 0, tokens: 0, byRunner: {} };
  for (const line of lines) {
    let entry;
    try { entry = typeof line === "string" ? JSON.parse(line) : line; } catch { continue; }
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !Number.isFinite(entry.cost) || !Number.isFinite(entry.tokens) || !Number.isFinite(entry.ts)) continue;
    result.cost += entry.cost;
    result.tokens += entry.tokens;
    const key = typeof entry.runner === "string" && entry.runner ? entry.runner : "unknown";
    const rollup = result.byRunner[key] ??= { cost: 0, tokens: 0 };
    rollup.cost += entry.cost;
    rollup.tokens += entry.tokens;
  }
  return result;
};`,
  }),
];

export const PREWALK_CONTRACT_CORPUS = Object.freeze({
  version: 1,
  tasks: Object.freeze(tasks),
});

export const buildPrewalkCorpusManifest = (options = {}) => ({
  format: 1,
  representativeTaskSet: options.attestRepresentative === true,
  minimumTasks: 20,
  evaluator: {
    id: "ultra-prewalk-structural-rubric-v1",
    billable: false,
    command: process.execPath,
    args: [PREWALK_REFERENCE_EVALUATOR],
    timeoutMs: 5_000,
    env: [],
  },
  tasks: tasks.map((entry) => ({
    id: entry.id,
    prompt: entry.prompt,
    initialFiles: structuredClone(entry.initialFiles),
    expectedFiles: {},
    protectedPaths: [...entry.protectedPaths],
    test: {
      command: process.execPath,
      args: ["verify.mjs"],
      timeoutMs: 5_000,
      env: [],
    },
  })),
});
