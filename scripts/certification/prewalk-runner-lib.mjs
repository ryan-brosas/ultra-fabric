import path from "node:path";
import { pairedOrders } from "./rpc-lib.mjs";

const VARIANTS = ["in-place", "research"];
const MAX_TASKS = 100;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 16 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const object = (value, name) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Real Prewalk benchmark ${name} must be an object`);
  }
  return value;
};

const strict = (value, fields, name) => {
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) throw new Error(`Real Prewalk benchmark ${name} has unknown field ${unknown}`);
};

const text = (value, name, max = MAX_TEXT_CHARS) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Real Prewalk benchmark ${name} must be nonempty and <= ${max} characters`);
  }
  return value.trim();
};

const positiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const positiveInteger = (value) => {
  const parsed = positiveNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};

const boundedInteger = (value, name, minimum, maximum) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Real Prewalk benchmark ${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const stringArray = (value, name, limit, itemLimit = 4_096) => {
  if (!Array.isArray(value) || value.length > limit || value.some(
    (item) => typeof item !== "string" || item.length > itemLimit,
  )) {
    throw new Error(`Real Prewalk benchmark ${name} must contain at most ${limit} bounded strings`);
  }
  return [...value];
};

const environmentNames = (value, name) => {
  const names = stringArray(value ?? [], name, 32, 128);
  if (names.some((item) => !ENV_NAME.test(item))) {
    throw new Error(`Real Prewalk benchmark ${name} contains an invalid environment variable name`);
  }
  return [...new Set(names)];
};

const relativePath = (value, name) => {
  const candidate = text(value, name, 512);
  if (candidate.includes("\\") || candidate.includes("\0") || path.posix.isAbsolute(candidate)) {
    throw new Error(`Real Prewalk benchmark ${name} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Real Prewalk benchmark ${name} escapes the fixture root`);
  }
  if (normalized === ".pi" || normalized.startsWith(".pi/") ||
      normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Real Prewalk benchmark ${name} uses reserved path ${normalized}`);
  }
  return normalized;
};

const fileMap = (value, name) => {
  const input = object(value, name);
  const entries = Object.entries(input);
  if (entries.length > MAX_FILES) {
    throw new Error(`Real Prewalk benchmark ${name} exceeds ${MAX_FILES} files`);
  }
  let bytes = 0;
  const parsed = {};
  for (const [rawPath, content] of entries) {
    const file = relativePath(rawPath, `${name} path`);
    if (typeof content !== "string") {
      throw new Error(`Real Prewalk benchmark ${name}.${file} must be text`);
    }
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) {
      throw new Error(`Real Prewalk benchmark ${name}.${file} exceeds ${MAX_FILE_BYTES} bytes`);
    }
    bytes += size;
    if (bytes > MAX_FIXTURE_BYTES) {
      throw new Error(`Real Prewalk benchmark ${name} exceeds ${MAX_FIXTURE_BYTES} bytes`);
    }
    if (Object.hasOwn(parsed, file)) {
      throw new Error(`Real Prewalk benchmark ${name} has duplicate normalized path ${file}`);
    }
    parsed[file] = content;
  }
  return parsed;
};

const command = (value, name) => {
  const input = object(value, name);
  strict(input, ["command", "args", "timeoutMs", "env"], name);
  const executable = text(input.command, `${name}.command`, 4_096);
  if (!path.isAbsolute(executable)) {
    throw new Error(`Real Prewalk benchmark ${name}.command must be absolute`);
  }
  return {
    command: executable,
    args: stringArray(input.args, `${name}.args`, 64),
    timeoutMs: boundedInteger(input.timeoutMs, `${name}.timeoutMs`, 1_000, 120_000),
    env: environmentNames(input.env, `${name}.env`),
  };
};

const parseTask = (value, index) => {
  const input = object(value, `tasks[${index}]`);
  strict(input, ["id", "prompt", "initialFiles", "expectedFiles", "protectedPaths", "test"], `tasks[${index}]`);
  const id = text(input.id, `tasks[${index}].id`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Real Prewalk benchmark tasks[${index}].id has an invalid format`);
  }
  const initialFiles = fileMap(input.initialFiles, `tasks[${index}].initialFiles`);
  const expectedFiles = fileMap(input.expectedFiles, `tasks[${index}].expectedFiles`);
  const protectedPaths = stringArray(input.protectedPaths, `tasks[${index}].protectedPaths`, MAX_FILES)
    .map((item) => relativePath(item, `tasks[${index}].protectedPaths`));
  for (const protectedPath of protectedPaths) {
    if (!Object.hasOwn(initialFiles, protectedPath)) {
      throw new Error(`Real Prewalk benchmark protected path is not an initial file: ${protectedPath}`);
    }
    if (Object.hasOwn(expectedFiles, protectedPath)) {
      throw new Error(
        `Real Prewalk benchmark path cannot be both expected and protected: ${protectedPath}`,
      );
    }
  }
  return {
    id,
    prompt: text(input.prompt, `tasks[${index}].prompt`),
    initialFiles,
    expectedFiles,
    protectedPaths: [...new Set(protectedPaths)],
    test: command(input.test, `tasks[${index}].test`),
  };
};

export const parsePrewalkRunManifest = (value) => {
  const input = object(value, "manifest");
  strict(input, ["format", "representativeTaskSet", "minimumTasks", "evaluator", "tasks"], "manifest");
  if (input.format !== 1) throw new Error("Real Prewalk benchmark manifest.format must equal 1");
  if (typeof input.representativeTaskSet !== "boolean") {
    throw new Error("Real Prewalk benchmark representativeTaskSet must be boolean");
  }
  const minimumTasks = boundedInteger(input.minimumTasks, "minimumTasks", 20, MAX_TASKS);
  const evaluatorInput = object(input.evaluator, "evaluator");
  strict(evaluatorInput, ["id", "billable", "command", "args", "timeoutMs", "env"], "evaluator");
  if (evaluatorInput.billable !== false) {
    throw new Error("Real Prewalk benchmark evaluator.billable must equal false");
  }
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) {
    throw new Error(`Real Prewalk benchmark tasks requires 1-${MAX_TASKS} entries`);
  }
  const tasks = input.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("Real Prewalk benchmark task ids must be unique");
  }
  return {
    format: 1,
    representativeTaskSet: input.representativeTaskSet,
    minimumTasks,
    evaluator: {
      id: text(evaluatorInput.id, "evaluator.id", 128),
      billable: false,
      ...command({
        command: evaluatorInput.command,
        args: evaluatorInput.args,
        timeoutMs: evaluatorInput.timeoutMs,
        env: evaluatorInput.env,
      }, "evaluator"),
    },
    tasks,
  };
};

const gateModel = (env, prefix, reasons) => {
  const provider = env[`${prefix}_PROVIDER`];
  const model = env[`${prefix}_MODEL`];
  const keyVariable = env[`${prefix}_KEY_ENV`];
  if (!provider) reasons.push(`${prefix}_PROVIDER is required`);
  if (!model) reasons.push(`${prefix}_MODEL is required`);
  if (!keyVariable) reasons.push(`${prefix}_KEY_ENV is required`);
  else if (!env[keyVariable]) reasons.push(`credential variable ${keyVariable} is not set`);
  return { provider: provider ?? null, model: model ?? null, keyVariable: keyVariable ?? null };
};

export const prewalkRunnerGate = (env = process.env) => {
  const reasons = [];
  if (env.PI_FABRIC_PREWALK_REAL !== "1") reasons.push("PI_FABRIC_PREWALK_REAL must equal 1");
  if (env.PI_FABRIC_PREWALK_TRUST_MANIFEST !== "1") {
    reasons.push("PI_FABRIC_PREWALK_TRUST_MANIFEST must equal 1");
  }
  const frontier = gateModel(env, "PI_FABRIC_BENCH", reasons);
  const executor = gateModel(env, "PI_FABRIC_PREWALK_EXECUTOR", reasons);
  const repeats = positiveInteger(env.PI_FABRIC_BENCH_REPEATS);
  if (repeats === null || repeats > 10) {
    reasons.push("PI_FABRIC_BENCH_REPEATS must be an integer between 1 and 10");
  }
  const maxUsd = positiveNumber(env.PI_FABRIC_BENCH_MAX_USD);
  if (maxUsd === null) reasons.push("PI_FABRIC_BENCH_MAX_USD must be a positive number");
  const maxTokens = positiveInteger(env.PI_FABRIC_BENCH_MAX_TOKENS);
  if (maxTokens === null || maxTokens > 1_000_000_000) {
    reasons.push("PI_FABRIC_BENCH_MAX_TOKENS must be an integer between 1 and 1000000000");
  }
  const taskTimeoutMs = positiveInteger(env.PI_FABRIC_BENCH_TASK_TIMEOUT_MS);
  if (taskTimeoutMs === null || taskTimeoutMs < 1_000 || taskTimeoutMs > 3_600_000) {
    reasons.push("PI_FABRIC_BENCH_TASK_TIMEOUT_MS must be an integer between 1000 and 3600000");
  }
  const piCli = env.PI_FABRIC_PREWALK_PI_CLI;
  if (piCli && !path.isAbsolute(piCli)) {
    reasons.push("PI_FABRIC_PREWALK_PI_CLI must be an absolute path when set");
  }
  return {
    enabled: reasons.length === 0,
    reasons,
    config: {
      frontier,
      executor,
      repeats: repeats ?? 0,
      maxUsd: maxUsd ?? 0,
      maxTokens: maxTokens ?? 0,
      taskTimeoutMs: taskTimeoutMs ?? 0,
      seed: env.PI_FABRIC_BENCH_SEED?.slice(0, 128) || "ultra-prewalk-real-v1",
      piCli: piCli ?? null,
    },
  };
};

export const buildPrewalkSchedule = (tasks, repeats, seed) => {
  const schedule = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const task of tasks) {
      const order = pairedOrders(1, `${seed}:${task.id}:${repeat}`, VARIANTS)[0];
      for (const variant of order) schedule.push({ taskId: task.id, repeat, variant });
    }
  }
  return schedule;
};

const nonnegativeInteger = (value, name) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Real Prewalk benchmark ${name} must be a nonnegative integer`);
  }
  return value;
};

export const parsePrewalkEvaluatorResult = (value, variant) => {
  const input = object(value, "evaluator result");
  strict(input, ["unsupportedClaims", "planQualityScore"], "evaluator result");
  const unsupportedClaims = nonnegativeInteger(
    input.unsupportedClaims,
    "evaluator result.unsupportedClaims",
  );
  if (variant === "in-place") {
    if (input.planQualityScore !== undefined) {
      throw new Error("Real Prewalk benchmark in-place evaluator result must omit planQualityScore");
    }
    return { unsupportedClaims };
  }
  if (typeof input.planQualityScore !== "number" ||
      !Number.isFinite(input.planQualityScore) ||
      input.planQualityScore < 0 || input.planQualityScore > 1) {
    throw new Error("Real Prewalk benchmark research evaluator result.planQualityScore must be between 0 and 1");
  }
  return { unsupportedClaims, planQualityScore: input.planQualityScore };
};

export const buildPrewalkProjectConfig = (variant, executor, timeoutMs) => ({
  configVersion: 2,
  fullCodeMode: true,
  executor: {
    runtime: "quickjs",
    timeoutMs: Math.max(1_000, Math.min(900_000, Math.floor(timeoutMs))),
  },
  prewalk: {
    // The certification fake-pi stub reads prewalk.mode to simulate the
    // research/in-place variants; production configs are cleaned by the
    // 1->2 migration, but this benchmark fixture writes the raw file the
    // fake pi inspects directly.
    mode: variant,
    model: `${executor.provider}/${executor.model}`,
    thinking: "off",
    returnPolicy: "executor",
    alwaysRearm: false,
  },
  agents: { enabled: false },
  mcp: { enabled: false },
  quality: { mode: "off" },
  schema: { mode: "off" },
});

export const summarizePrewalkProbe = (records, models) => {
  if (!Array.isArray(records)) throw new Error("Real Prewalk benchmark probe records must be an array");
  const messages = records.filter((record) => record?.type === "message").map((record, index) => {
    if (record.phase !== "frontier" && record.phase !== "executor") {
      throw new Error(`Real Prewalk benchmark probe message ${index} has no owned phase`);
    }
    return {
      ...record,
      contextTokens: nonnegativeInteger(record.contextTokens, "probe contextTokens"),
      inputTokens: nonnegativeInteger(record.inputTokens, "probe inputTokens"),
      outputTokens: nonnegativeInteger(record.outputTokens, "probe outputTokens"),
      cacheReadTokens: nonnegativeInteger(record.cacheReadTokens, "probe cacheReadTokens"),
      cacheWriteTokens: nonnegativeInteger(record.cacheWriteTokens, "probe cacheWriteTokens"),
    };
  });
  const contextTokensBeforeRequests = messages.map((record) => record.contextTokens);
  const phaseTotal = (phase, field) => messages
    .filter((record) => record.phase === phase)
    .reduce((total, record) => total + record[field], 0);
  const usageTotal = (field) => messages.reduce((total, record) => total + record[field], 0);
  const parentContextTokens = phaseTotal("frontier", "contextTokens");
  const executorContextTokens = phaseTotal("executor", "contextTokens");
  const prunedIndex = records.findIndex((record) =>
    record?.type === "context" && record.continuationPresent === true &&
    record.planningPresent === false
  );
  const fabric = records.filter((record) => record?.type === "fabric_exec");
  const boundary = fabric.find((record) =>
    record.isError === false && record.terminate === true &&
    record.checklistItems >= 5 && record.checklistItems <= 9 &&
    record.workspaceMutations === 1
  );
  return {
    contextTokensBeforeRequests,
    parentContextTokens,
    executorContextTokens,
    inputTokens: usageTotal("inputTokens"),
    outputTokens: usageTotal("outputTokens"),
    cacheReadTokens: usageTotal("cacheReadTokens"),
    cacheWriteTokens: usageTotal("cacheWriteTokens"),
    requestCount: messages.length,
    checklistItems: fabric.reduce(
      (maximum, record) => Math.max(maximum, nonnegativeInteger(record.checklistItems, "probe checklistItems")),
      0,
    ),
    firstMutationBoundary: boundary !== undefined,
    planningInstructionPruned: prunedIndex >= 0,
    executorSeen: prunedIndex >= 0 && records.slice(prunedIndex + 1).some((record) =>
      record?.type === "message" && record.phase === "executor" &&
      record.provider === models.executor.provider && record.model === models.executor.model
    ),
  };
};
