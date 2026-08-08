import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { parsePrewalkBenchmarkRun } from "./prewalk-benchmark-lib.mjs";
import {
  buildPrewalkProjectConfig,
  buildPrewalkSchedule,
  parsePrewalkEvaluatorResult,
  summarizePrewalkProbe,
} from "./prewalk-runner-lib.mjs";

const MAX_PROBE_BYTES = 1024 * 1024;
const MAX_EVALUATOR_BYTES = 64 * 1024;
const MAX_FINAL_RESPONSE_CHARS = 64 * 1024;
const MAX_REPOSITORY_ENTRIES = 4_096;
const MAX_REPOSITORY_DEPTH = 32;
const MAX_REPOSITORY_BYTES = 32 * 1024 * 1024;
const PROBE_EXTENSION = fileURLToPath(new URL("./prewalk-probe.mjs", import.meta.url));
const PACKAGE_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");
// Optional comma-separated absolute extension paths loaded alongside fabric and
// the probe (for example the operator omniroute provider extension).
const EXTRA_EXTENSIONS = (process.env.PI_FABRIC_PREWALK_EXTRA_EXTENSIONS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const DEFAULT_PI_CLI = fileURLToPath(new URL("./cli.js", PACKAGE_ENTRY));
const PI_VERSION = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../package.json", PACKAGE_ENTRY)), "utf8"),
).version;
const FABRIC_VERSION = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;

const writeFile = (root, relative, content) => {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
};

export const scanPrewalkRepository = (root, limits = {}) => {
  const maxEntries = limits.maxEntries ?? MAX_REPOSITORY_ENTRIES;
  const maxDepth = limits.maxDepth ?? MAX_REPOSITORY_DEPTH;
  const maxBytes = limits.maxBytes ?? MAX_REPOSITORY_BYTES;
  const files = [];
  let entries = 0;
  let bytes = 0;
  let limit;

  const walk = (relative, depth) => {
    if (limit || depth > maxDepth) {
      limit ??= "depth";
      return;
    }
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    const handle = fs.opendirSync(directory);
    const children = [];
    try {
      let child;
      while ((child = handle.readSync()) !== null) {
        children.push(child);
        if (entries + children.length > maxEntries) {
          limit = "entries";
          return;
        }
      }
    } finally {
      handle.closeSync();
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      entries += 1;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else {
        bytes += fs.lstatSync(path.join(root, child)).size;
        if (bytes > maxBytes) {
          limit = "bytes";
          return;
        }
        files.push(child.split(path.sep).join("/"));
      }
      if (limit) return;
    }
  };

  walk("", 0);
  return limit
    ? { kind: "limit", reason: limit, files, entries, bytes }
    : { kind: "complete", files, entries, bytes };
};

const selectedEnvironment = (names, additions = {}) => ({
  ...Object.fromEntries(names.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )),
  ...additions,
});

const exactTextFile = (file, expected) => {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file, "utf8") === expected;
};

const runTestOracle = (repo, task, configText) => {
  const result = spawnSync(task.test.command, task.test.args, {
    cwd: repo,
    encoding: "utf8",
    timeout: task.test.timeoutMs,
    maxBuffer: MAX_EVALUATOR_BYTES,
    env: selectedEnvironment(task.test.env, { PI_OFFLINE: "1" }),
  });
  if (result.error) {
    throw new Error(`Real Prewalk benchmark test command failed: ${result.error.message}`);
  }
  const criteria = [];
  for (const [relative, expected] of Object.entries(task.expectedFiles)) {
    const file = path.join(repo, ...relative.split("/"));
    criteria.push({
      id: `expected:${relative}`,
      passed: exactTextFile(file, expected),
    });
  }
  for (const relative of task.protectedPaths) {
    const file = path.join(repo, ...relative.split("/"));
    criteria.push({
      id: `protected:${relative}`,
      passed: exactTextFile(file, task.initialFiles[relative]),
    });
  }
  criteria.push({ id: "test", passed: result.status === 0 });
  const allowed = new Set([
    ...Object.keys(task.initialFiles),
    ...Object.keys(task.expectedFiles),
    ".pi/fabric.json",
  ]);
  const repository = scanPrewalkRepository(repo);
  const unexpected = repository.files.filter((relative) => !allowed.has(relative));
  const repositoryFailure = repository.kind === "limit"
    ? `repository:${repository.reason}_limit`
    : undefined;
  const configPath = path.join(repo, ".pi", "fabric.json");
  const harnessConfigIntact = exactTextFile(configPath, configText);
  const failedCriteria = criteria.filter((criterion) => !criterion.passed);
  const missedConstraints = failedCriteria.length + unexpected.length +
    (repositoryFailure ? 1 : 0) + (harnessConfigIntact ? 0 : 1);
  return {
    acceptance: {
      completed: criteria.length - failedCriteria.length,
      total: criteria.length,
    },
    missedConstraints,
    passed: missedConstraints === 0,
    failed: [
      ...failedCriteria.map((criterion) => criterion.id),
      ...unexpected.map((relative) => `unexpected:${relative}`),
      ...(repositoryFailure ? [repositoryFailure] : []),
      ...(harnessConfigIntact ? [] : ["protected:.pi/fabric.json"]),
    ],
    testStatus: result.status,
  };
};

const readProbe = (probePath) => {
  if (!fs.existsSync(probePath)) throw new Error("Real Prewalk benchmark probe emitted no telemetry");
  const size = fs.statSync(probePath).size;
  if (size > MAX_PROBE_BYTES) throw new Error(`Real Prewalk benchmark probe exceeds ${MAX_PROBE_BYTES} bytes`);
  const lines = fs.readFileSync(probePath, "utf8").split("\n").filter(Boolean);
  if (lines.length > 10_000) throw new Error("Real Prewalk benchmark probe exceeds 10,000 records");
  return lines.map((line) => JSON.parse(line));
};

const checklistFromEvents = (events) => {
  for (const event of events) {
    if (event?.type !== "tool_execution_end" || event.toolName !== "fabric_exec") continue;
    const operations = event.result?.details?.trace?.operations;
    if (!Array.isArray(operations)) continue;
    const operation = operations.find((candidate) =>
      candidate?.ref === "fabric.prewalk.checklist" && candidate?.outcome === "succeeded"
    );
    const items = operation?.args?.items;
    if (!Array.isArray(items)) continue;
    const parsed = items.flatMap((item) =>
      typeof item?.task === "string" && typeof item?.validation === "string"
        ? [{ task: item.task.slice(0, 1_000), validation: item.validation.slice(0, 1_000) }]
        : []
    );
    if (parsed.length >= 5 && parsed.length <= 9) return parsed;
  }
  return [];
};

const runEvaluator = (evaluator, payload, variant) => {
  const result = spawnSync(evaluator.command, evaluator.args, {
    cwd: os.tmpdir(),
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: evaluator.timeoutMs,
    maxBuffer: MAX_EVALUATOR_BYTES,
    env: selectedEnvironment(evaluator.env),
  });
  if (result.error) {
    throw new Error(`Real Prewalk benchmark evaluator failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Real Prewalk benchmark evaluator exited ${result.status ?? "without status"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Real Prewalk benchmark evaluator returned invalid JSON");
  }
  return parsePrewalkEvaluatorResult(parsed, variant);
};

const prepareRepository = (repo, task, variant, config) => {
  fs.mkdirSync(repo, { recursive: true });
  for (const [relative, content] of Object.entries(task.initialFiles)) {
    writeFile(repo, relative, content);
  }
  const document = buildPrewalkProjectConfig(variant, config.executor, config.taskTimeoutMs);
  const configText = `${JSON.stringify(document, null, 2)}\n`;
  writeFile(repo, ".pi/fabric.json", configText);
  return configText;
};

const runVariant = async ({ entry, task, config, root, fabricExtension }) => {
  const repo = path.join(root, `repeat-${entry.repeat}`, task.id, entry.variant, "repo");
  const probePath = path.join(root, `repeat-${entry.repeat}`, task.id, entry.variant, "probe.jsonl");
  fs.mkdirSync(path.dirname(probePath), { recursive: true });
  const configText = prepareRepository(repo, task, entry.variant, config);
  const cliPath = config.piCli ? path.resolve(config.piCli) : DEFAULT_PI_CLI;
  const client = new RpcClient({
    cliPath,
    cwd: repo,
    provider: config.frontier.provider,
    model: config.frontier.model,
    env: {
      PI_FABRIC_PREWALK_PROBE_PATH: probePath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    args: [
      "--thinking", "off",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "--extension", fabricExtension,
      "--extension", PROBE_EXTENSION,
      ...EXTRA_EXTENSIONS.flatMap((entry) => ["--extension", entry]),
      "--approve",
      "--no-session",
    ],
  });
  const started = performance.now();
  let events;
  let stats;
  let finalResponse;
  try {
    await client.start();
    const commands = await client.getCommands();
    if (!commands.some((command) => command.name === "fabric" && command.source === "extension")) {
      throw new Error("Real Prewalk benchmark Pi process did not load the Fabric command");
    }
    events = await client.promptAndWait(`/fabric prewalk ${task.prompt}`, undefined, config.taskTimeoutMs);
    stats = await client.getSessionStats();
    finalResponse = await client.getLastAssistantText();
  } finally {
    await client.stop();
  }
  const wallMs = Math.round(performance.now() - started);
  const probe = summarizePrewalkProbe(readProbe(probePath), {
    frontier: config.frontier,
    executor: config.executor,
  });
  const checklist = entry.variant === "research" ? checklistFromEvents(events) : [];
  const oracle = runTestOracle(repo, task, configText);
  const evaluation = runEvaluator(config.evaluator, {
    format: 1,
    taskId: task.id,
    variant: entry.variant,
    objective: task.prompt,
    checklist,
    finalResponse: typeof finalResponse === "string"
      ? finalResponse.slice(0, MAX_FINAL_RESPONSE_CHARS)
      : "",
    oracle: {
      acceptance: oracle.acceptance,
      missedConstraints: oracle.missedConstraints,
      failed: oracle.failed,
      testStatus: oracle.testStatus,
    },
  }, entry.variant);
  const record = {
    taskId: task.id,
    repeat: entry.repeat,
    variant: entry.variant,
    acceptance: oracle.acceptance,
    unsupportedClaims: evaluation.unsupportedClaims,
    missedConstraints: oracle.missedConstraints,
    contextTokensBeforeRequests: probe.contextTokensBeforeRequests,
    parentContextTokens: probe.parentContextTokens,
    executorContextTokens: probe.executorContextTokens,
    inputTokens: probe.inputTokens,
    outputTokens: probe.outputTokens,
    cacheReadTokens: probe.cacheReadTokens,
    cacheWriteTokens: probe.cacheWriteTokens,
    requestCount: probe.requestCount,
    wallMs,
    totalTokens: Math.max(0, Math.floor(stats?.tokens?.total ?? 0)),
    costUsd: Math.max(0, stats?.cost ?? 0),
    ...(entry.variant === "research"
      ? {
          protocol: {
            checklistItems: probe.checklistItems,
            firstMutationBoundary: probe.firstMutationBoundary,
            planningInstructionPruned: probe.planningInstructionPruned,
            executorVerified: probe.executorSeen && oracle.passed,
            planQualityScore: evaluation.planQualityScore,
            planEvaluator: config.evaluator.id,
          },
        }
      : {}),
  };
  return parsePrewalkBenchmarkRun(record);
};

export const runRealPrewalkBenchmark = async (manifest, gateConfig, options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-real-"));
  const fabricExtension = options.fabricExtension ?? path.resolve("dist/index.js");
  const config = { ...gateConfig, evaluator: manifest.evaluator };
  const schedule = buildPrewalkSchedule(manifest.tasks, config.repeats, config.seed);
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const runs = [];
  let observedCostUsd = 0;
  let observedTokens = 0;
  try {
    for (const entry of schedule) {
      if (observedCostUsd >= config.maxUsd) {
        throw new Error(
          `Real Prewalk benchmark stopped at configured budget ${config.maxUsd} USD after ${runs.length} completed run(s)`,
        );
      }
      if (observedTokens >= config.maxTokens) {
        throw new Error(
          `Real Prewalk benchmark stopped at configured token budget ${config.maxTokens} after ${runs.length} completed run(s)`,
        );
      }
      const task = tasks.get(entry.taskId);
      if (!task) throw new Error(`Real Prewalk benchmark schedule has unknown task ${entry.taskId}`);
      const run = await runVariant({ entry, task, config, root, fabricExtension });
      runs.push(run);
      observedCostUsd += run.costUsd;
      observedTokens += run.totalTokens;
      if (observedCostUsd > config.maxUsd) {
        throw new Error(
          `Real Prewalk benchmark exceeded configured budget ${config.maxUsd} USD after ${runs.length} completed run(s)`,
        );
      }
      if (observedTokens > config.maxTokens) {
        throw new Error(
          `Real Prewalk benchmark exceeded configured token budget ${config.maxTokens} after ${runs.length} completed run(s)`,
        );
      }
    }
    const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    return {
      observedCostUsd,
      observedTokens,
      dataset: {
        representativeTaskSet: manifest.representativeTaskSet,
        minimumTasks: manifest.minimumTasks,
        provenance: {
          collector: "ultra-prewalk-real-v1",
          manifestDigest,
          frontier: { provider: config.frontier.provider, model: config.frontier.model },
          executor: { provider: config.executor.provider, model: config.executor.model },
          piVersion: PI_VERSION,
          fabricVersion: FABRIC_VERSION,
          seed: config.seed,
          repeats: config.repeats,
          observedCostUsd,
          observedTokens,
          generatedAt: new Date().toISOString(),
        },
        runs,
      },
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
