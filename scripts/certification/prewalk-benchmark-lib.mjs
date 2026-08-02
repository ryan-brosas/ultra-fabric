import { wilsonInterval } from "./rpc-lib.mjs";

const VARIANTS = ["in-place", "research"];
const MAX_RUNS = 10_000;
const RUN_FIELDS = [
  "taskId",
  "repeat",
  "variant",
  "acceptance",
  "unsupportedClaims",
  "missedConstraints",
  "contextTokensBeforeRequests",
  "parentContextTokens",
  "executorContextTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "requestCount",
  "wallMs",
  "totalTokens",
  "costUsd",
  "protocol",
];
const PROTOCOL_FIELDS = [
  "checklistItems",
  "firstMutationBoundary",
  "planningInstructionPruned",
  "executorVerified",
  "planQualityScore",
  "planEvaluator",
];
const PROVENANCE_FIELDS = [
  "collector",
  "manifestDigest",
  "frontier",
  "executor",
  "piVersion",
  "fabricVersion",
  "seed",
  "repeats",
  "observedCostUsd",
  "observedTokens",
  "generatedAt",
];
const LIMITATIONS = [
  "A comparison-ready report does not establish general superiority.",
  "Representative-task coverage is operator-attested rather than inferred from task content.",
  "Plan-quality scores depend on the named external evaluator and rubric.",
  "Results apply only to the recorded repositories, models, providers, versions, and repeats.",
];

const record = (value, name) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Prewalk benchmark ${name} must be an object`);
  }
  return value;
};

const strictFields = (value, allowed, name) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Prewalk benchmark ${name} has unknown field ${unknown[0]}`);
  }
};

const finite = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Prewalk benchmark ${name} must be a finite nonnegative number`);
  }
  return value;
};

const integer = (value, name, minimum = 0) => {
  const parsed = finite(value, name);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`Prewalk benchmark ${name} must be an integer >= ${minimum}`);
  }
  return parsed;
};

const boundedText = (value, name, pattern) => {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error(`Prewalk benchmark ${name} must be a nonempty string <= 128 characters`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new Error(`Prewalk benchmark ${name} has an invalid format`);
  }
  return normalized;
};

const parseAcceptance = (value) => {
  const input = record(value, "acceptance");
  strictFields(input, ["completed", "total"], "acceptance");
  const total = integer(input.total, "acceptance.total", 1);
  const completed = integer(input.completed, "acceptance.completed");
  if (completed > total) {
    throw new Error("Prewalk benchmark acceptance.completed cannot exceed total");
  }
  return { completed, total };
};

const parseProtocol = (value) => {
  const input = record(value, "protocol");
  strictFields(input, PROTOCOL_FIELDS, "protocol");
  const checklistItems = integer(input.checklistItems, "protocol.checklistItems", 5);
  if (checklistItems > 9) {
    throw new Error("Prewalk benchmark protocol.checklistItems must be between 5 and 9");
  }
  for (const field of [
    "firstMutationBoundary",
    "planningInstructionPruned",
    "executorVerified",
  ]) {
    if (typeof input[field] !== "boolean") {
      throw new Error(`Prewalk benchmark protocol.${field} must be boolean`);
    }
  }
  const planQualityScore = finite(input.planQualityScore, "protocol.planQualityScore");
  if (planQualityScore > 1) {
    throw new Error("Prewalk benchmark protocol.planQualityScore must be <= 1");
  }
  return {
    checklistItems,
    firstMutationBoundary: input.firstMutationBoundary,
    planningInstructionPruned: input.planningInstructionPruned,
    executorVerified: input.executorVerified,
    planQualityScore,
    planEvaluator: boundedText(input.planEvaluator, "protocol.planEvaluator"),
  };
};

const parseModelIdentity = (value, name) => {
  const input = record(value, name);
  strictFields(input, ["provider", "model"], name);
  return {
    provider: boundedText(input.provider, `${name}.provider`),
    model: boundedText(input.model, `${name}.model`),
  };
};

const parseProvenance = (value) => {
  const input = record(value, "provenance");
  strictFields(input, PROVENANCE_FIELDS, "provenance");
  const generatedAt = boundedText(input.generatedAt, "provenance.generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Prewalk benchmark provenance.generatedAt must be an ISO timestamp");
  }
  return {
    collector: boundedText(input.collector, "provenance.collector"),
    manifestDigest: boundedText(
      input.manifestDigest,
      "provenance.manifestDigest",
      /^[a-f0-9]{64}$/,
    ),
    frontier: parseModelIdentity(input.frontier, "provenance.frontier"),
    executor: parseModelIdentity(input.executor, "provenance.executor"),
    piVersion: boundedText(input.piVersion, "provenance.piVersion"),
    fabricVersion: boundedText(input.fabricVersion, "provenance.fabricVersion"),
    seed: boundedText(input.seed, "provenance.seed"),
    repeats: Math.max(1, integer(input.repeats, "provenance.repeats", 1)),
    observedCostUsd: finite(input.observedCostUsd, "provenance.observedCostUsd"),
    observedTokens: integer(input.observedTokens, "provenance.observedTokens"),
    generatedAt,
  };
};

export const parsePrewalkBenchmarkRun = (value) => {
  const input = record(value, "run");
  strictFields(input, RUN_FIELDS, "run");
  const variant = input.variant;
  if (!VARIANTS.includes(variant)) {
    throw new Error(`Prewalk benchmark variant must be one of: ${VARIANTS.join(", ")}`);
  }
  if (!Array.isArray(input.contextTokensBeforeRequests) ||
      input.contextTokensBeforeRequests.length < 1 ||
      input.contextTokensBeforeRequests.length > 256) {
    throw new Error("Prewalk benchmark contextTokensBeforeRequests requires 1-256 values");
  }
  const requestCount = integer(input.requestCount, "requestCount", 1);
  if (requestCount !== input.contextTokensBeforeRequests.length) {
    throw new Error("Prewalk benchmark requestCount must match contextTokensBeforeRequests length");
  }
  if (variant === "in-place" && input.protocol !== undefined) {
    throw new Error("Prewalk benchmark in-place run must not include protocol evidence");
  }
  const protocol = variant === "research" && input.protocol !== undefined
    ? parseProtocol(input.protocol)
    : undefined;
  if (variant === "research" && !protocol) {
    throw new Error("Prewalk benchmark research run requires protocol evidence");
  }
  return {
    taskId: boundedText(input.taskId, "taskId", /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    repeat: integer(input.repeat, "repeat", 1),
    variant,
    acceptance: parseAcceptance(input.acceptance),
    unsupportedClaims: integer(input.unsupportedClaims, "unsupportedClaims"),
    missedConstraints: integer(input.missedConstraints, "missedConstraints"),
    contextTokensBeforeRequests: input.contextTokensBeforeRequests.map((tokens, index) =>
      integer(tokens, `contextTokensBeforeRequests[${index}]`)
    ),
    parentContextTokens: integer(input.parentContextTokens, "parentContextTokens"),
    executorContextTokens: integer(input.executorContextTokens, "executorContextTokens"),
    inputTokens: integer(input.inputTokens, "inputTokens"),
    outputTokens: integer(input.outputTokens, "outputTokens"),
    cacheReadTokens: integer(input.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: integer(input.cacheWriteTokens, "cacheWriteTokens"),
    requestCount,
    wallMs: finite(input.wallMs, "wallMs"),
    totalTokens: integer(input.totalTokens, "totalTokens"),
    costUsd: finite(input.costUsd, "costUsd"),
    ...(protocol ? { protocol } : {}),
  };
};

const average = (values) => {
  if (values.length === 0) return 0;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(12));
};

const rate = (count, total) => total === 0 ? 0 : Number((count / total).toFixed(12));

const summarizeVariant = (runs, variant) => {
  const selected = runs.filter((run) => run.variant === variant);
  const fullAcceptance = selected.filter(
    (run) => run.acceptance.completed === run.acceptance.total,
  ).length;
  const criteriaCompleted = selected.reduce(
    (total, run) => total + run.acceptance.completed,
    0,
  );
  const criteriaTotal = selected.reduce((total, run) => total + run.acceptance.total, 0);
  const runContextTotals = selected.map((run) =>
    run.contextTokensBeforeRequests.reduce((total, value) => total + value, 0)
  );
  const runContextAverages = selected.map((run) => average(run.contextTokensBeforeRequests));
  const runContextPeaks = selected.map((run) => Math.max(...run.contextTokensBeforeRequests));
  const planScores = selected.flatMap((run) => run.protocol ? [run.protocol.planQualityScore] : []);
  return {
    runs: selected.length,
    tasks: new Set(selected.map((run) => run.taskId)).size,
    fullAcceptance,
    fullAcceptanceRate: rate(fullAcceptance, selected.length),
    fullAcceptanceRate95: wilsonInterval(fullAcceptance, selected.length),
    criteriaCompleted,
    criteriaTotal,
    criteriaCompletionRate: rate(criteriaCompleted, criteriaTotal),
    unsupportedClaims: selected.reduce((total, run) => total + run.unsupportedClaims, 0),
    missedConstraints: selected.reduce((total, run) => total + run.missedConstraints, 0),
    averageRequestContextTokens: average(runContextAverages),
    averageRunContextTokens: average(runContextTotals),
    averagePeakRequestContextTokens: average(runContextPeaks),
    averageParentContextTokens: average(selected.map((run) => run.parentContextTokens)),
    averageExecutorContextTokens: average(selected.map((run) => run.executorContextTokens)),
    averageInputTokens: average(selected.map((run) => run.inputTokens)),
    averageOutputTokens: average(selected.map((run) => run.outputTokens)),
    averageCacheReadTokens: average(selected.map((run) => run.cacheReadTokens)),
    averageCacheWriteTokens: average(selected.map((run) => run.cacheWriteTokens)),
    averageWallMs: average(selected.map((run) => run.wallMs)),
    averageTotalTokens: average(selected.map((run) => run.totalTokens)),
    averageCostUsd: average(selected.map((run) => run.costUsd)),
    ...(planScores.length > 0 ? { averagePlanQualityScore: average(planScores) } : {}),
  };
};

const comparison = (pairs, value, higherIsBetter) => {
  const result = { researchWins: 0, inPlaceWins: 0, ties: 0 };
  for (const pair of pairs) {
    const research = value(pair.research);
    const inPlace = value(pair["in-place"]);
    if (research === inPlace) result.ties += 1;
    else if ((research > inPlace) === higherIsBetter) result.researchWins += 1;
    else result.inPlaceWins += 1;
  }
  return result;
};

const protocolSummary = (researchRuns) => {
  const count = researchRuns.length;
  const matching = (field) => researchRuns.filter((run) => run.protocol[field] === true).length;
  const firstMutationBoundaryRate = rate(matching("firstMutationBoundary"), count);
  const planningInstructionPrunedRate = rate(matching("planningInstructionPruned"), count);
  const executorVerifiedRate = rate(matching("executorVerified"), count);
  return {
    mechanicallyCompatible: count > 0 && firstMutationBoundaryRate === 1 &&
      planningInstructionPrunedRate === 1 && executorVerifiedRate === 1,
    researchRuns: count,
    firstMutationBoundaryRate,
    planningInstructionPrunedRate,
    executorVerifiedRate,
  };
};

export const summarizePrewalkBenchmark = (values, options = {}) => {
  if (!Array.isArray(values)) throw new Error("Prewalk benchmark runs must be an array");
  if (values.length > MAX_RUNS) {
    throw new Error(`Prewalk benchmark run limit exceeded (${MAX_RUNS.toLocaleString("en-US")})`);
  }
  const runs = values.map(parsePrewalkBenchmarkRun);
  const minimumTasks = Math.max(20, integer(options.minimumTasks ?? 20, "minimumTasks", 1));
  const representativeTaskSet = options.representativeTaskSet === true;
  const byKey = new Map();
  for (const run of runs) {
    const key = `${run.taskId}:${run.repeat}:${run.variant}`;
    if (byKey.has(key)) throw new Error(`Duplicate Prewalk benchmark run: ${key}`);
    byKey.set(key, run);
  }
  const pairKeys = [...new Set(runs.map((run) => `${run.taskId}:${run.repeat}`))].sort();
  const pairs = [];
  const missingPairs = [];
  for (const key of pairKeys) {
    const separator = key.lastIndexOf(":");
    const taskId = key.slice(0, separator);
    const repeat = Number(key.slice(separator + 1));
    const pair = Object.fromEntries(VARIANTS.flatMap((variant) => {
      const found = byKey.get(`${key}:${variant}`);
      return found ? [[variant, found]] : [];
    }));
    const missing = VARIANTS.filter((variant) => !pair[variant]);
    if (missing.length > 0) missingPairs.push({ taskId, repeat, missing });
    else pairs.push(pair);
  }
  const uniqueTasks = new Set(runs.map((run) => run.taskId)).size;
  const protocol = protocolSummary(runs.filter((run) => run.variant === "research"));
  const coverageReady = uniqueTasks >= minimumTasks && missingPairs.length === 0;
  const status = !coverageReady
    ? "insufficient_coverage"
    : !representativeTaskSet
      ? "unrepresentative_tasks"
      : !protocol.mechanicallyCompatible
        ? "protocol_mismatch"
        : "comparison_ready";
  return {
    schemaVersion: 1,
    status,
    representativeTaskSet,
    ...(options.provenance ? { provenance: parseProvenance(options.provenance) } : {}),
    coverage: {
      requiredTasks: minimumTasks,
      uniqueTasks,
      completePairs: pairs.length,
      missingPairs,
    },
    variants: {
      "in-place": summarizeVariant(runs, "in-place"),
      research: summarizeVariant(runs, "research"),
    },
    protocol,
    paired: {
      fullAcceptance: comparison(
        pairs,
        (run) => run.acceptance.completed === run.acceptance.total ? 1 : 0,
        true,
      ),
      criteriaCompletion: comparison(
        pairs,
        (run) => run.acceptance.completed / run.acceptance.total,
        true,
      ),
      unsupportedClaims: comparison(pairs, (run) => run.unsupportedClaims, false),
      missedConstraints: comparison(pairs, (run) => run.missedConstraints, false),
      runContextTokens: comparison(
        pairs,
        (run) => run.contextTokensBeforeRequests.reduce((total, value) => total + value, 0),
        false,
      ),
      peakRequestContextTokens: comparison(
        pairs,
        (run) => Math.max(...run.contextTokensBeforeRequests),
        false,
      ),
      inputTokens: comparison(pairs, (run) => run.inputTokens, false),
      outputTokens: comparison(pairs, (run) => run.outputTokens, false),
      totalTokens: comparison(pairs, (run) => run.totalTokens, false),
      costUsd: comparison(pairs, (run) => run.costUsd, false),
      wallMs: comparison(pairs, (run) => run.wallMs, false),
    },
    limitations: [...LIMITATIONS],
  };
};

export const parsePrewalkBenchmarkDataset = (value) => {
  const input = record(value, "dataset");
  strictFields(input, ["representativeTaskSet", "minimumTasks", "provenance", "runs"], "dataset");
  if (typeof input.representativeTaskSet !== "boolean") {
    throw new Error("Prewalk benchmark representativeTaskSet must be boolean");
  }
  if (!Array.isArray(input.runs)) throw new Error("Prewalk benchmark dataset.runs must be an array");
  if (input.runs.length > MAX_RUNS) {
    throw new Error(`Prewalk benchmark run limit exceeded (${MAX_RUNS.toLocaleString("en-US")})`);
  }
  return {
    representativeTaskSet: input.representativeTaskSet,
    minimumTasks: input.minimumTasks === undefined
      ? 20
      : Math.max(20, integer(input.minimumTasks, "minimumTasks", 1)),
    ...(input.provenance ? { provenance: parseProvenance(input.provenance) } : {}),
    runs: input.runs.map(parsePrewalkBenchmarkRun),
  };
};
