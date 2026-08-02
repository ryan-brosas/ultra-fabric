import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PI_CORE_TOOL_NAME_SET } from "./core/pi-tools.js";
import {
  CURRENT_FABRIC_CONFIG_VERSION,
  migrateFabricConfigDocument,
} from "./config-migrations.js";
import type { FabricRisk } from "./protocol.js";
import { DEFAULT_FABRIC_THINKING, isFabricThinking, type FabricThinking } from "./thinking.js";

type FabricApprovalMode = "allow" | "ask" | "auto" | "deny";
export type FabricAgentTransport =
  | "auto"
  | "process"
  | "tmux"
  | "screen"
  | "localterm"
  | "herdr";
export type FabricAgentRunner = "pi" | "claude";
export type FabricUiWidgetMode = "auto" | "always" | "hidden";
export type FabricResultFormat = "auto" | "yaml" | "json" | "text";
export type FabricPrewalkMode = "in-place" | "trajectory";
export type FabricPrewalkReturnPolicy = "executor" | "previous";
type FabricPrewalkVerificationMode = "gated";
export type FabricExecutorRuntime = "quickjs" | "node-process";
type FabricCompactionEngine = "pi" | "fabric";
type FabricActorScope = "project" | "session";
type FabricActorOverflowPolicy =
  | "reject"
  | "coalesce"
  | "drop-oldest"
  | "dead-letter";

interface FabricExecutorConfig {
  runtime: FabricExecutorRuntime;
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputChars: number;
  maxNestedResultChars: number;
  maxGateRevisions: number;
  maxRunEvidence: number;
  maxRunTransitions: number;
  resultFormat: FabricResultFormat;
}

export interface FabricApprovalConfig {
  read: FabricApprovalMode;
  write: FabricApprovalMode;
  execute: FabricApprovalMode;
  network: FabricApprovalMode;
  agent: FabricApprovalMode;
  model?: string;
}

export interface FabricMcpConfig {
  enabled: boolean;
  configPath?: string;
  disableOAuth: boolean;
  allowDynamicServers: boolean;
  callTimeoutMs: number;
}

interface FabricClaudeRunnerConfig {
  binary: string;
  model?: string;
}

interface FabricPrewalkConfig {
  mode: FabricPrewalkMode;
  returnPolicy: FabricPrewalkReturnPolicy;
  model?: string;
  fallbackModels?: string[];
  triggerRisks: FabricRisk[];
  triggerEffects: Array<"none" | "workspace" | "state" | "external">;
  triggerRefs: string[];
  alwaysRearm: boolean;
  // Reasoning effort for the trajectory executor; unset inherits agents.thinking.
  thinking?: FabricThinking;
  verificationMode?: FabricPrewalkVerificationMode;
  maxPhaseRevisions?: number;
}

export interface FabricAgentConfig {
  enabled: boolean;
  runner: FabricAgentRunner;
  transport: FabricAgentTransport;
  model?: string;
  fallbackModels: string[];
  allowQualityDowngrade: boolean;
  requireAdmissionIntent: boolean;
  capabilityProfiles: Record<string, { tools: string[]; risks: FabricRisk[] }>;
  claude: FabricClaudeRunnerConfig;
  thinking: FabricThinking;
  maxConcurrent: number;
  maxPerExecution: number;
  maxDepth: number;
  timeoutMs: number;
  extensions: boolean;
  defaultTools: string[];
  retainRuns: boolean;
  notifyOnComplete: boolean;
  budgetUsd: number;
  maxTokensPerChild: number;
}

interface FabricConsultConfig {
  enabled: boolean;
  maxWorkers: number;
  contextPressureThreshold: number;
  maxFindingsPerWorker: number;
  maxEvidencePerFinding: number;
  maxEvidenceFileBytes: number;
  maxEvidenceBytesPerConsult: number;
  maxTokensPerWorker: number;
}

export interface FabricToolCaptureConfig {
  enabled: boolean;
  hideFromModel: boolean;
  keepVisible: string[];
  defaultRisk: FabricRisk;
  risks: Record<string, FabricRisk>;
}

export type FabricSchemaMode = "off" | "audit" | "enforce";

export interface FabricSchemaTrustedCommand {
  command: string;
  args: string[];
  shell: boolean;
  timeoutMs: number;
}

export interface FabricSchemaConfig {
  mode: FabricSchemaMode;
  certificateTtlMs: number;
  maxFiles: number;
  maxBytes: number;
  trustedCommands: Record<string, FabricSchemaTrustedCommand>;
}

interface FabricUiConfig {
  enabled: boolean;
  widget: FabricUiWidgetMode;
  maxRows: number;
  refreshMs: number;
  eventHistory: number;
  haltOnEscape: boolean;
  showNestedToolCalls: boolean;
  nestedToolDebounceMs: number;
}

interface FabricContextQosConfig {
  enabled: boolean;
  turnWindow: number;
  minResultChars: number;
}

interface FabricCompactionConfig {
  engine: FabricCompactionEngine;
  targetContextRatio: number;
  thresholds: Record<string, number>;
  contextQos: FabricContextQosConfig;
}

interface FabricOutcomeConfig {
  enabled: boolean;
  maxRecords: number;
  minRecommendationSamples: number;
}

export interface FabricRetentionConfig {
  orphanedTempRunMs: number;
  oneShotRunMs: number;
  actorRunArchiveMs: number;
}

export interface FabricMeshConfig {
  enabled: boolean;
  root?: string;
  actorScope: FabricActorScope;
  maxEventBytes: number;
  maxReadEvents: number;
  actorPollMs: number;
  actorQueueLimit: number;
  actorOverflowPolicy: FabricActorOverflowPolicy;
  actorRunMaxAttempts: number;
  actorRunBaseDelayMs: number;
  actorRunMaxDelayMs: number;
  actorRunJitterMs: number;
  actorDeliveryMaxAttempts: number;
  actorDeliveryBaseDelayMs: number;
  actorDeliveryMaxDelayMs: number;
  actorDeliveryJitterMs: number;
  actorCircuitFailureThreshold: number;
  actorCircuitCooldownMs: number;
  eventContextChars: number;
  actorContextEntries: number;
}

export interface FabricMemoryConfig {
  enabled: boolean;
  indexDir?: string;
  maxSessions: number;
  maxEntryChars: number;
  indexThinking: boolean;
  indexToolOutput: boolean;
  hotSessions?: number;
  digestTerms?: number;
  maxColdVocabularyBytes?: number;
  maxColdCacheBytes?: number;
  maxSyncSessions?: number;
  maxSyncSourceBytes?: number;
  maxCacheCleanupFiles?: number;
  regexMaxPatternBytes?: number;
  regexMaxHaystackTerms?: number;
  regexMaxHaystackBytes?: number;
  regexTimeoutMs?: number;
}

export interface FabricConfig {
  fullCodeMode: boolean;
  executor: FabricExecutorConfig;
  approvals: FabricApprovalConfig;
  mcp: FabricMcpConfig;
  prewalk: FabricPrewalkConfig;
  agents: FabricAgentConfig;
  consult: FabricConsultConfig;
  capture: FabricToolCaptureConfig;
  ui: FabricUiConfig;
  compaction: FabricCompactionConfig;
  outcomes: FabricOutcomeConfig;
  retention: FabricRetentionConfig;
  mesh: FabricMeshConfig;
  memory: FabricMemoryConfig;
  schema: FabricSchemaConfig;
}

export const MIN_AGENT_TIMEOUT_MS = 1_000;
const DEFAULT_AGENT_TIMEOUT_MS = 3_600_000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 3_600_000;
export const QUICKJS_MAX_MEMORY_LIMIT_BYTES = 0xffff_ffff;
export const MAX_EXECUTOR_MEMORY_LIMIT_BYTES = Math.max(
  8 * 1024 * 1024,
  Math.min(Number.MAX_SAFE_INTEGER, Math.floor(os.totalmem())),
);

export const maxExecutorMemoryLimitBytes = (runtime: FabricExecutorRuntime): number =>
  runtime === "quickjs"
    ? Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES)
    : MAX_EXECUTOR_MEMORY_LIMIT_BYTES;

export const DEFAULT_FABRIC_CONFIG: FabricConfig = {
  fullCodeMode: true,
  executor: {
    runtime: "quickjs",
    timeoutMs: 120_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputChars: 50_000,
    maxNestedResultChars: 2_000_000,
    maxGateRevisions: 2,
    maxRunEvidence: 256,
    maxRunTransitions: 512,
    resultFormat: "auto",
  },
  approvals: {
    read: "allow",
    write: "allow",
    execute: "allow",
    network: "allow",
    agent: "allow",
  },
  mcp: {
    enabled: true,
    disableOAuth: true,
    allowDynamicServers: true,
    callTimeoutMs: 120_000,
  },
  prewalk: {
    mode: "in-place",
    returnPolicy: "executor",
    triggerRisks: [],
    triggerEffects: ["workspace"],
    triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
    alwaysRearm: false,
  },
  agents: {
    enabled: true,
    runner: "pi",
    transport: "process",
    fallbackModels: [],
    allowQualityDowngrade: false,
    requireAdmissionIntent: false,
    capabilityProfiles: {},
    claude: { binary: "claude" },
    thinking: DEFAULT_FABRIC_THINKING,
    maxConcurrent: 4,
    maxPerExecution: 100,
    maxDepth: 2,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    extensions: true,
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    retainRuns: false,
    notifyOnComplete: true,
    budgetUsd: 0,
    maxTokensPerChild: 0,
  },
  consult: {
    enabled: true,
    maxWorkers: 3,
    contextPressureThreshold: 0.6,
    maxFindingsPerWorker: 8,
    maxEvidencePerFinding: 8,
    maxEvidenceFileBytes: 2 * 1024 * 1024,
    maxEvidenceBytesPerConsult: 8 * 1024 * 1024,
    maxTokensPerWorker: 8_000,
  },
  capture: {
    enabled: true,
    hideFromModel: true,
    keepVisible: ["fabric_exec"],
    defaultRisk: "execute",
    risks: {
      read: "read",
      grep: "read",
      find: "read",
      ls: "read",
      edit: "write",
      write: "write",
      bash: "execute",
    },
  },
  ui: {
    enabled: true,
    widget: "auto",
    maxRows: 6,
    refreshMs: 500,
    eventHistory: 80,
    haltOnEscape: true,
    showNestedToolCalls: true,
    nestedToolDebounceMs: 100,
  },
  compaction: {
    engine: "fabric",
    targetContextRatio: 0.65,
    thresholds: {},
    contextQos: {
      enabled: true,
      turnWindow: 2,
      minResultChars: 4_000,
    },
  },
  outcomes: {
    enabled: true,
    maxRecords: 1_000,
    minRecommendationSamples: 5,
  },
  retention: {
    orphanedTempRunMs: 6 * 60 * 60 * 1_000,
    oneShotRunMs: 24 * 60 * 60 * 1_000,
    actorRunArchiveMs: 7 * 24 * 60 * 60 * 1_000,
  },
  mesh: {
    enabled: true,
    actorScope: "project",
    maxEventBytes: 256 * 1024,
    maxReadEvents: 500,
    actorPollMs: 250,
    actorQueueLimit: 32,
    actorOverflowPolicy: "reject",
    actorRunMaxAttempts: 1,
    actorRunBaseDelayMs: 250,
    actorRunMaxDelayMs: 5_000,
    actorRunJitterMs: 100,
    actorDeliveryMaxAttempts: 3,
    actorDeliveryBaseDelayMs: 100,
    actorDeliveryMaxDelayMs: 2_000,
    actorDeliveryJitterMs: 50,
    actorCircuitFailureThreshold: 3,
    actorCircuitCooldownMs: 30_000,
    eventContextChars: 40_000,
    actorContextEntries: 14,
  },
  memory: {
    enabled: true,
    maxSessions: 500,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 50,
    digestTerms: 200,
    maxColdVocabularyBytes: 512 * 1024,
    maxColdCacheBytes: 1024 * 1024,
    maxSyncSessions: 10_000,
    maxSyncSourceBytes: 512 * 1024 * 1024,
    maxCacheCleanupFiles: 100_000,
    regexMaxPatternBytes: 1_024,
    regexMaxHaystackTerms: 20_000,
    regexMaxHaystackBytes: 2 * 1024 * 1024,
    regexTimeoutMs: 250,
  },
  schema: {
    mode: "off",
    certificateTtlMs: 30_000,
    maxFiles: 100,
    maxBytes: 10 * 1024 * 1024,
    trustedCommands: {},
  },
};

interface JsonObjectFile {
  document: Record<string, unknown>;
  source: string;
}

const readJsonObjectFile = (filePath: string): JsonObjectFile | undefined => {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration root must be an object");
    }
    return { document: parsed as Record<string, unknown>, source };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${filePath}: ${message}`);
  }
};

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const approvalMode = (value: unknown, fallback: FabricApprovalMode): FabricApprovalMode =>
  value === "allow" || value === "ask" || value === "auto" || value === "deny"
    ? value
    : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const boundedFloat = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const runnerValue = (value: unknown, fallback: FabricAgentRunner): FabricAgentRunner =>
  value === "pi" || value === "claude" ? value : fallback;

const prewalkModeValue = (
  value: unknown,
  fallback: FabricPrewalkMode,
): FabricPrewalkMode =>
  value === "in-place" || value === "trajectory" ? value : fallback;

const prewalkReturnPolicyValue = (
  value: unknown,
  fallback: FabricPrewalkReturnPolicy,
): FabricPrewalkReturnPolicy =>
  value === "executor" || value === "previous" ? value : fallback;

const transportValue = (
  value: unknown,
  fallback: FabricAgentTransport,
): FabricAgentTransport =>
  value === "auto" ||
  value === "process" ||
  value === "tmux" ||
  value === "screen" ||
  value === "localterm" ||
  value === "herdr"
    ? value
    : fallback;

const thinkingValue = (value: unknown, fallback: FabricThinking): FabricThinking =>
  isFabricThinking(value) ? value : fallback;

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const widgetModeValue = (value: unknown, fallback: FabricUiWidgetMode): FabricUiWidgetMode =>
  value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const executorRuntimeValue = (
  value: unknown,
  fallback: FabricExecutorRuntime,
): FabricExecutorRuntime =>
  value === "quickjs" || value === "node-process" ? value : fallback;

const resultFormatValue = (
  value: unknown,
  fallback: FabricResultFormat,
): FabricResultFormat =>
  value === "auto" || value === "yaml" || value === "json" || value === "text"
    ? value
    : fallback;

const compactionEngineValue = (
  value: unknown,
  fallback: FabricCompactionEngine,
): FabricCompactionEngine =>
  value === "pi" || value === "fabric" ? value : fallback;

const actorScopeValue = (value: unknown, fallback: FabricActorScope): FabricActorScope =>
  value === "project" || value === "session" ? value : fallback;

const actorOverflowPolicyValue = (
  value: unknown,
  fallback: FabricActorOverflowPolicy,
): FabricActorOverflowPolicy =>
  value === "reject" ||
  value === "coalesce" ||
  value === "drop-oldest" ||
  value === "dead-letter"
    ? value
    : fallback;

const schemaModeValue = (value: unknown, fallback: FabricSchemaMode): FabricSchemaMode =>
  value === "off" || value === "audit" || value === "enforce" ? value : fallback;

const riskValue = (value: unknown, fallback: FabricRisk): FabricRisk =>
  value === "read" ||
  value === "write" ||
  value === "execute" ||
  value === "network" ||
  value === "agent"
    ? value
    : fallback;

export const normalizeFabricConfig = (input: Record<string, unknown>): FabricConfig => {
  const executor = objectValue(input.executor);
  const approvals = objectValue(input.approvals);
  const mcp = objectValue(input.mcp);
  const prewalk = objectValue(input.prewalk);
  const agents = objectValue(input.agents);
  const consult = objectValue(input.consult);
  const claude = objectValue(agents.claude);
  const capture = objectValue(input.capture);
  const ui = objectValue(input.ui);
  const compaction = objectValue(input.compaction);
  const contextQos = objectValue(compaction.contextQos);
  const outcomes = objectValue(input.outcomes);
  const retention = objectValue(input.retention);
  const mesh = objectValue(input.mesh);
  const memory = objectValue(input.memory);
  const schema = objectValue(input.schema);
  const schemaMode = schemaModeValue(schema.mode, DEFAULT_FABRIC_CONFIG.schema.mode);
  const configuredExecutorRuntime = executorRuntimeValue(
    executor.runtime,
    DEFAULT_FABRIC_CONFIG.executor.runtime,
  );
  const executorRuntime = schemaMode === "enforce" ? "quickjs" : configuredExecutorRuntime;
  const configuredTools = Array.isArray(agents.defaultTools)
    ? agents.defaultTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_FABRIC_CONFIG.agents.defaultTools;
  const capabilityProfiles = Object.fromEntries(
    Object.entries(objectValue(agents.capabilityProfiles))
      .filter(([name]) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))
      .slice(0, 32)
      .map(([name, raw]) => {
        const profile = objectValue(raw);
        const tools = Array.isArray(profile.tools)
          ? [...new Set(profile.tools.filter((tool): tool is string =>
              typeof tool === "string" && Boolean(tool.trim())
            ).map((tool) => tool.trim()))].slice(0, 32)
          : [];
        const risks = Array.isArray(profile.risks)
          ? [...new Set(profile.risks.filter((risk): risk is FabricRisk =>
              risk === "read" || risk === "write" || risk === "execute" ||
              risk === "network" || risk === "agent"
            ))]
          : [];
        return [name, { tools, risks }];
      }),
  );
  const approvalModel = stringValue(approvals.model);
  const configPath = stringValue(mcp.configPath);
  const meshRoot = stringValue(mesh.root);
  const memoryIndexDir = stringValue(memory.indexDir);
  const compactionThresholds = Object.fromEntries(
    Object.entries(objectValue(compaction.thresholds))
      .filter(([model, threshold]) =>
        model.includes("/")
        && typeof threshold === "number"
        && Number.isFinite(threshold),
      )
      .map(([model, threshold]) => [
        model,
        Math.min(0.95, Math.max(0.25, threshold as number)),
      ]),
  );
  const prewalkModel = stringValue(prewalk.model);
  const prewalkFallbackModels = Array.isArray(prewalk.fallbackModels)
    ? [...new Set(
        prewalk.fallbackModels
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => /^[^/\s]+\/\S+$/.test(value)),
      )].slice(0, 8)
    : [];
  const prewalkThinking = isFabricThinking(prewalk.thinking) ? prewalk.thinking : undefined;
  const prewalkTriggerRisks = Array.isArray(prewalk.triggerRisks)
    ? [...new Set(prewalk.triggerRisks.filter((value): value is FabricRisk =>
        value === "read" || value === "write" || value === "execute" ||
        value === "network" || value === "agent"
      ))]
    : DEFAULT_FABRIC_CONFIG.prewalk.triggerRisks;
  const prewalkTriggerEffects = Array.isArray(prewalk.triggerEffects)
    ? [...new Set(prewalk.triggerEffects.filter(
        (value): value is "none" | "workspace" | "state" | "external" =>
          value === "none" || value === "workspace" || value === "state" || value === "external",
      ))]
    : DEFAULT_FABRIC_CONFIG.prewalk.triggerEffects;
  const prewalkTriggerRefs = Array.isArray(prewalk.triggerRefs)
    ? [...new Set(
        prewalk.triggerRefs
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.test(value)),
      )].slice(0, 32)
    : DEFAULT_FABRIC_CONFIG.prewalk.triggerRefs;
  const prewalkVerificationMode = prewalk.verificationMode === "gated" ? "gated" : undefined;
  const agentModel = stringValue(agents.model);
  const agentFallbackModels = Array.isArray(agents.fallbackModels)
    ? [...new Set(
        agents.fallbackModels
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => /^[^/\s]+\/\S+$/.test(value)),
      )].slice(0, 8)
    : DEFAULT_FABRIC_CONFIG.agents.fallbackModels;
  const claudeBinary = stringValue(claude.binary);
  const claudeModel = stringValue(claude.model);
  const agentThinking = thinkingValue(agents.thinking, DEFAULT_FABRIC_CONFIG.agents.thinking);
  const configuredVisible = Array.isArray(capture.keepVisible)
    ? capture.keepVisible.filter(
        (name): name is string => typeof name === "string" && Boolean(name.trim()),
      )
    : DEFAULT_FABRIC_CONFIG.capture.keepVisible;
  const configuredRisks = {
    ...DEFAULT_FABRIC_CONFIG.capture.risks,
    ...objectValue(capture.risks),
  };
  const trustedCommands = Object.fromEntries(
    Object.entries(objectValue(schema.trustedCommands)).flatMap(([name, raw]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return [];
      const command = objectValue(raw);
      const executable = stringValue(command.command);
      if (!executable) return [];
      const shell = booleanValue(command.shell, false);
      const args = !shell && Array.isArray(command.args)
        ? command.args.filter((arg): arg is string => typeof arg === "string").slice(0, 64)
        : [];
      return [[name, {
        command: executable,
        args,
        shell,
        timeoutMs: boundedInteger(command.timeoutMs, 30_000, 1, 300_000),
      } satisfies FabricSchemaTrustedCommand]];
    }),
  );
  const risks = Object.fromEntries(
    Object.entries(configuredRisks)
      .filter(([name]) => Boolean(name.trim()))
      .map(([name, risk]) => [name, riskValue(risk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk)]),
  );

  return {
    fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_FABRIC_CONFIG.fullCodeMode),
    executor: {
      runtime: executorRuntime,
      timeoutMs: boundedInteger(
        executor.timeoutMs,
        DEFAULT_FABRIC_CONFIG.executor.timeoutMs,
        1_000,
        900_000,
      ),
      memoryLimitBytes: boundedInteger(
        executor.memoryLimitBytes,
        DEFAULT_FABRIC_CONFIG.executor.memoryLimitBytes,
        8 * 1024 * 1024,
        maxExecutorMemoryLimitBytes(executorRuntime),
      ),
      maxOutputChars: boundedInteger(
        executor.maxOutputChars,
        DEFAULT_FABRIC_CONFIG.executor.maxOutputChars,
        1_000,
        1_000_000,
      ),
      maxNestedResultChars: boundedInteger(
        executor.maxNestedResultChars,
        DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars,
        10_000,
        20_000_000,
      ),
      maxGateRevisions: boundedInteger(
        executor.maxGateRevisions,
        DEFAULT_FABRIC_CONFIG.executor.maxGateRevisions,
        0,
        10,
      ),
      maxRunEvidence: boundedInteger(
        executor.maxRunEvidence,
        DEFAULT_FABRIC_CONFIG.executor.maxRunEvidence,
        1,
        10_000,
      ),
      maxRunTransitions: boundedInteger(
        executor.maxRunTransitions,
        DEFAULT_FABRIC_CONFIG.executor.maxRunTransitions,
        1,
        10_000,
      ),
      resultFormat: resultFormatValue(
        executor.resultFormat,
        DEFAULT_FABRIC_CONFIG.executor.resultFormat,
      ),
    },
    approvals: {
      read: approvalMode(approvals.read, DEFAULT_FABRIC_CONFIG.approvals.read),
      write: approvalMode(approvals.write, DEFAULT_FABRIC_CONFIG.approvals.write),
      execute: approvalMode(approvals.execute, DEFAULT_FABRIC_CONFIG.approvals.execute),
      network: approvalMode(approvals.network, DEFAULT_FABRIC_CONFIG.approvals.network),
      agent: approvalMode(approvals.agent, DEFAULT_FABRIC_CONFIG.approvals.agent),
      ...(approvalModel ? { model: approvalModel } : {}),
    },
    mcp: {
      enabled: booleanValue(mcp.enabled, DEFAULT_FABRIC_CONFIG.mcp.enabled),
      ...(configPath ? { configPath } : {}),
      disableOAuth: booleanValue(mcp.disableOAuth, DEFAULT_FABRIC_CONFIG.mcp.disableOAuth),
      allowDynamicServers: booleanValue(
        mcp.allowDynamicServers,
        DEFAULT_FABRIC_CONFIG.mcp.allowDynamicServers,
      ),
      callTimeoutMs: boundedInteger(
        mcp.callTimeoutMs,
        DEFAULT_FABRIC_CONFIG.mcp.callTimeoutMs,
        1_000,
        900_000,
      ),
    },
    prewalk: {
      mode: prewalkModeValue(prewalk.mode, DEFAULT_FABRIC_CONFIG.prewalk.mode),
      returnPolicy: prewalkReturnPolicyValue(
        prewalk.returnPolicy,
        DEFAULT_FABRIC_CONFIG.prewalk.returnPolicy,
      ),
      ...(prewalkModel ? { model: prewalkModel } : {}),
      ...(prewalkFallbackModels.length > 0
        ? { fallbackModels: prewalkFallbackModels }
        : {}),
      ...(prewalkThinking ? { thinking: prewalkThinking } : {}),
      triggerRisks: prewalkTriggerRisks,
      triggerEffects: prewalkTriggerEffects,
      triggerRefs: prewalkTriggerRefs,
      ...(prewalkVerificationMode
        ? {
            verificationMode: prewalkVerificationMode,
            maxPhaseRevisions: boundedInteger(prewalk.maxPhaseRevisions, 2, 0, 8),
          }
        : {}),
      alwaysRearm: booleanValue(
        prewalk.alwaysRearm,
        DEFAULT_FABRIC_CONFIG.prewalk.alwaysRearm,
      ),
    },
    agents: {
      enabled: booleanValue(agents.enabled, DEFAULT_FABRIC_CONFIG.agents.enabled),
      runner: runnerValue(agents.runner, DEFAULT_FABRIC_CONFIG.agents.runner),
      transport: transportValue(agents.transport, DEFAULT_FABRIC_CONFIG.agents.transport),
      ...(agentModel ? { model: agentModel } : {}),
      fallbackModels: agentFallbackModels,
      allowQualityDowngrade: booleanValue(
        agents.allowQualityDowngrade,
        DEFAULT_FABRIC_CONFIG.agents.allowQualityDowngrade,
      ),
      requireAdmissionIntent: booleanValue(
        agents.requireAdmissionIntent,
        DEFAULT_FABRIC_CONFIG.agents.requireAdmissionIntent,
      ),
      capabilityProfiles,
      claude: {
        binary: claudeBinary ?? DEFAULT_FABRIC_CONFIG.agents.claude.binary,
        ...(claudeModel ? { model: claudeModel } : {}),
      },
      thinking: agentThinking,
      maxConcurrent: boundedInteger(
        agents.maxConcurrent,
        DEFAULT_FABRIC_CONFIG.agents.maxConcurrent,
        1,
        32,
      ),
      maxPerExecution: boundedInteger(
        agents.maxPerExecution,
        DEFAULT_FABRIC_CONFIG.agents.maxPerExecution,
        1,
        1_000,
      ),
      maxDepth: boundedInteger(agents.maxDepth, DEFAULT_FABRIC_CONFIG.agents.maxDepth, 0, 8),
      timeoutMs: boundedInteger(
        agents.timeoutMs,
        DEFAULT_FABRIC_CONFIG.agents.timeoutMs,
        MIN_AGENT_TIMEOUT_MS,
        MAX_AGENT_TIMEOUT_MS,
      ),
      extensions: booleanValue(agents.extensions, DEFAULT_FABRIC_CONFIG.agents.extensions),
      defaultTools: configuredTools,
      retainRuns: booleanValue(agents.retainRuns, DEFAULT_FABRIC_CONFIG.agents.retainRuns),
      notifyOnComplete: booleanValue(
        agents.notifyOnComplete,
        DEFAULT_FABRIC_CONFIG.agents.notifyOnComplete,
      ),
      budgetUsd: boundedFloat(
        agents.budgetUsd,
        DEFAULT_FABRIC_CONFIG.agents.budgetUsd,
        0,
        1_000_000,
      ),
      maxTokensPerChild: boundedInteger(
        agents.maxTokensPerChild,
        DEFAULT_FABRIC_CONFIG.agents.maxTokensPerChild,
        0,
        100_000_000,
      ),
    },
    consult: {
      enabled: booleanValue(consult.enabled, DEFAULT_FABRIC_CONFIG.consult.enabled),
      maxWorkers: boundedInteger(
        consult.maxWorkers,
        DEFAULT_FABRIC_CONFIG.consult.maxWorkers,
        1,
        3,
      ),
      contextPressureThreshold: boundedFloat(
        consult.contextPressureThreshold,
        DEFAULT_FABRIC_CONFIG.consult.contextPressureThreshold,
        0.25,
        0.95,
      ),
      maxFindingsPerWorker: boundedInteger(
        consult.maxFindingsPerWorker,
        DEFAULT_FABRIC_CONFIG.consult.maxFindingsPerWorker,
        1,
        16,
      ),
      maxEvidencePerFinding: boundedInteger(
        consult.maxEvidencePerFinding,
        DEFAULT_FABRIC_CONFIG.consult.maxEvidencePerFinding,
        1,
        16,
      ),
      maxEvidenceFileBytes: boundedInteger(
        consult.maxEvidenceFileBytes,
        DEFAULT_FABRIC_CONFIG.consult.maxEvidenceFileBytes,
        1_024,
        16 * 1024 * 1024,
      ),
      maxEvidenceBytesPerConsult: boundedInteger(
        consult.maxEvidenceBytesPerConsult,
        DEFAULT_FABRIC_CONFIG.consult.maxEvidenceBytesPerConsult,
        1_024,
        64 * 1024 * 1024,
      ),
      maxTokensPerWorker: boundedInteger(
        consult.maxTokensPerWorker,
        DEFAULT_FABRIC_CONFIG.consult.maxTokensPerWorker,
        256,
        1_000_000,
      ),
    },
    capture: {
      enabled: booleanValue(capture.enabled, DEFAULT_FABRIC_CONFIG.capture.enabled),
      hideFromModel: booleanValue(
        capture.hideFromModel,
        DEFAULT_FABRIC_CONFIG.capture.hideFromModel,
      ),
      keepVisible: [...new Set(configuredVisible)],
      defaultRisk: riskValue(capture.defaultRisk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk),
      risks,
    },
    ui: {
      enabled: booleanValue(ui.enabled, DEFAULT_FABRIC_CONFIG.ui.enabled),
      widget: widgetModeValue(ui.widget, DEFAULT_FABRIC_CONFIG.ui.widget),
      maxRows: boundedInteger(ui.maxRows, DEFAULT_FABRIC_CONFIG.ui.maxRows, 1, 20),
      refreshMs: boundedInteger(ui.refreshMs, DEFAULT_FABRIC_CONFIG.ui.refreshMs, 100, 10_000),
      eventHistory: boundedInteger(
        ui.eventHistory,
        DEFAULT_FABRIC_CONFIG.ui.eventHistory,
        1,
        500,
      ),
      haltOnEscape: booleanValue(ui.haltOnEscape, DEFAULT_FABRIC_CONFIG.ui.haltOnEscape),
      showNestedToolCalls: booleanValue(
        ui.showNestedToolCalls,
        DEFAULT_FABRIC_CONFIG.ui.showNestedToolCalls,
      ),
      nestedToolDebounceMs: boundedInteger(
        ui.nestedToolDebounceMs,
        DEFAULT_FABRIC_CONFIG.ui.nestedToolDebounceMs,
        0,
        2_000,
      ),
    },
    compaction: {
      engine: compactionEngineValue(compaction.engine, DEFAULT_FABRIC_CONFIG.compaction.engine),
      targetContextRatio: boundedFloat(
        compaction.targetContextRatio,
        DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
        0.25,
        0.85,
      ),
      thresholds: compactionThresholds,
      contextQos: {
        enabled: booleanValue(
          contextQos.enabled,
          DEFAULT_FABRIC_CONFIG.compaction.contextQos.enabled,
        ),
        turnWindow: boundedInteger(
          contextQos.turnWindow,
          DEFAULT_FABRIC_CONFIG.compaction.contextQos.turnWindow,
          1,
          20,
        ),
        minResultChars: boundedInteger(
          contextQos.minResultChars,
          DEFAULT_FABRIC_CONFIG.compaction.contextQos.minResultChars,
          256,
          1_000_000,
        ),
      },
    },
    outcomes: {
      enabled: booleanValue(outcomes.enabled, DEFAULT_FABRIC_CONFIG.outcomes.enabled),
      maxRecords: boundedInteger(
        outcomes.maxRecords,
        DEFAULT_FABRIC_CONFIG.outcomes.maxRecords,
        100,
        10_000,
      ),
      minRecommendationSamples: boundedInteger(
        outcomes.minRecommendationSamples,
        DEFAULT_FABRIC_CONFIG.outcomes.minRecommendationSamples,
        2,
        1_000,
      ),
    },
    retention: {
      orphanedTempRunMs: boundedInteger(
        retention.orphanedTempRunMs,
        DEFAULT_FABRIC_CONFIG.retention.orphanedTempRunMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
      oneShotRunMs: boundedInteger(
        retention.oneShotRunMs,
        DEFAULT_FABRIC_CONFIG.retention.oneShotRunMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
      actorRunArchiveMs: boundedInteger(
        retention.actorRunArchiveMs,
        DEFAULT_FABRIC_CONFIG.retention.actorRunArchiveMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
    },
    mesh: {
      enabled: booleanValue(mesh.enabled, DEFAULT_FABRIC_CONFIG.mesh.enabled),
      ...(meshRoot ? { root: meshRoot } : {}),
      actorScope: actorScopeValue(mesh.actorScope, DEFAULT_FABRIC_CONFIG.mesh.actorScope),
      maxEventBytes: boundedInteger(
        mesh.maxEventBytes,
        DEFAULT_FABRIC_CONFIG.mesh.maxEventBytes,
        1_024,
        4 * 1024 * 1024,
      ),
      maxReadEvents: boundedInteger(
        mesh.maxReadEvents,
        DEFAULT_FABRIC_CONFIG.mesh.maxReadEvents,
        1,
        10_000,
      ),
      actorPollMs: boundedInteger(
        mesh.actorPollMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorPollMs,
        50,
        10_000,
      ),
      actorQueueLimit: boundedInteger(
        mesh.actorQueueLimit,
        DEFAULT_FABRIC_CONFIG.mesh.actorQueueLimit,
        1,
        1_000,
      ),
      actorOverflowPolicy: actorOverflowPolicyValue(
        mesh.actorOverflowPolicy,
        DEFAULT_FABRIC_CONFIG.mesh.actorOverflowPolicy,
      ),
      actorRunMaxAttempts: boundedInteger(
        mesh.actorRunMaxAttempts,
        DEFAULT_FABRIC_CONFIG.mesh.actorRunMaxAttempts,
        1,
        10,
      ),
      actorRunBaseDelayMs: boundedInteger(
        mesh.actorRunBaseDelayMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorRunBaseDelayMs,
        0,
        60_000,
      ),
      actorRunMaxDelayMs: boundedInteger(
        mesh.actorRunMaxDelayMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorRunMaxDelayMs,
        0,
        60_000,
      ),
      actorRunJitterMs: boundedInteger(
        mesh.actorRunJitterMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorRunJitterMs,
        0,
        60_000,
      ),
      actorDeliveryMaxAttempts: boundedInteger(
        mesh.actorDeliveryMaxAttempts,
        DEFAULT_FABRIC_CONFIG.mesh.actorDeliveryMaxAttempts,
        1,
        10,
      ),
      actorDeliveryBaseDelayMs: boundedInteger(
        mesh.actorDeliveryBaseDelayMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorDeliveryBaseDelayMs,
        0,
        60_000,
      ),
      actorDeliveryMaxDelayMs: boundedInteger(
        mesh.actorDeliveryMaxDelayMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorDeliveryMaxDelayMs,
        0,
        60_000,
      ),
      actorDeliveryJitterMs: boundedInteger(
        mesh.actorDeliveryJitterMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorDeliveryJitterMs,
        0,
        60_000,
      ),
      actorCircuitFailureThreshold: boundedInteger(
        mesh.actorCircuitFailureThreshold,
        DEFAULT_FABRIC_CONFIG.mesh.actorCircuitFailureThreshold,
        1,
        100,
      ),
      actorCircuitCooldownMs: boundedInteger(
        mesh.actorCircuitCooldownMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorCircuitCooldownMs,
        0,
        24 * 60 * 60 * 1_000,
      ),
      eventContextChars: boundedInteger(
        mesh.eventContextChars,
        DEFAULT_FABRIC_CONFIG.mesh.eventContextChars,
        1_000,
        1_000_000,
      ),
      actorContextEntries: boundedInteger(
        mesh.actorContextEntries,
        DEFAULT_FABRIC_CONFIG.mesh.actorContextEntries,
        1,
        100,
      ),
    },
    memory: {
      enabled: booleanValue(memory.enabled, DEFAULT_FABRIC_CONFIG.memory.enabled),
      ...(memoryIndexDir ? { indexDir: memoryIndexDir } : {}),
      maxSessions: boundedInteger(
        memory.maxSessions,
        DEFAULT_FABRIC_CONFIG.memory.maxSessions,
        1,
        100_000,
      ),
      maxEntryChars: boundedInteger(
        memory.maxEntryChars,
        DEFAULT_FABRIC_CONFIG.memory.maxEntryChars,
        100,
        1_000_000,
      ),
      indexThinking: booleanValue(
        memory.indexThinking,
        DEFAULT_FABRIC_CONFIG.memory.indexThinking ?? false,
      ),
      indexToolOutput: booleanValue(
        memory.indexToolOutput,
        DEFAULT_FABRIC_CONFIG.memory.indexToolOutput ?? true,
      ),
      hotSessions: boundedInteger(
        memory.hotSessions,
        DEFAULT_FABRIC_CONFIG.memory.hotSessions ?? 50,
        0,
        100_000,
      ),
      digestTerms: boundedInteger(
        memory.digestTerms,
        DEFAULT_FABRIC_CONFIG.memory.digestTerms ?? 200,
        1,
        10_000,
      ),
      maxColdVocabularyBytes: boundedInteger(
        memory.maxColdVocabularyBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxColdVocabularyBytes ?? 512 * 1024,
        2,
        64 * 1024 * 1024,
      ),
      maxColdCacheBytes: boundedInteger(
        memory.maxColdCacheBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxColdCacheBytes ?? 1024 * 1024,
        512,
        128 * 1024 * 1024,
      ),
      maxSyncSessions: boundedInteger(
        memory.maxSyncSessions,
        DEFAULT_FABRIC_CONFIG.memory.maxSyncSessions ?? 10_000,
        1,
        1_000_000,
      ),
      maxSyncSourceBytes: boundedInteger(
        memory.maxSyncSourceBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxSyncSourceBytes ?? 512 * 1024 * 1024,
        1_024,
        8 * 1024 * 1024 * 1024,
      ),
      maxCacheCleanupFiles: boundedInteger(
        memory.maxCacheCleanupFiles,
        DEFAULT_FABRIC_CONFIG.memory.maxCacheCleanupFiles ?? 100_000,
        1,
        1_000_000,
      ),
      regexMaxPatternBytes: boundedInteger(
        memory.regexMaxPatternBytes,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxPatternBytes ?? 1_024,
        1,
        64 * 1024,
      ),
      regexMaxHaystackTerms: boundedInteger(
        memory.regexMaxHaystackTerms,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxHaystackTerms ?? 20_000,
        1,
        1_000_000,
      ),
      regexMaxHaystackBytes: boundedInteger(
        memory.regexMaxHaystackBytes,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxHaystackBytes ?? 2 * 1024 * 1024,
        1_024,
        128 * 1024 * 1024,
      ),
      regexTimeoutMs: boundedInteger(
        memory.regexTimeoutMs,
        DEFAULT_FABRIC_CONFIG.memory.regexTimeoutMs ?? 250,
        10,
        10_000,
      ),
    },
    schema: {
      mode: schemaMode,
      certificateTtlMs: boundedInteger(
        schema.certificateTtlMs,
        DEFAULT_FABRIC_CONFIG.schema.certificateTtlMs,
        1_000,
        10 * 60_000,
      ),
      maxFiles: boundedInteger(
        schema.maxFiles,
        DEFAULT_FABRIC_CONFIG.schema.maxFiles,
        1,
        1_000,
      ),
      maxBytes: boundedInteger(
        schema.maxBytes,
        DEFAULT_FABRIC_CONFIG.schema.maxBytes,
        1_024,
        100 * 1024 * 1024,
      ),
      trustedCommands,
    },
  };
};

export const effectiveToolCaptureConfig = (
  config: Pick<FabricConfig, "fullCodeMode" | "capture"> & Partial<Pick<FabricConfig, "schema">>,
): FabricToolCaptureConfig =>
  config.schema?.mode === "enforce"
    ? {
        ...config.capture,
        enabled: true,
        hideFromModel: true,
        keepVisible: ["fabric_exec"],
        risks: { ...config.capture.risks },
      }
    : config.fullCodeMode
      ? {
          ...config.capture,
          keepVisible: config.capture.keepVisible.filter(
            (name) => !PI_CORE_TOOL_NAME_SET.has(name),
          ),
          risks: { ...config.capture.risks },
        }
      : {
          ...config.capture,
          enabled: false,
          hideFromModel: false,
          keepVisible: [...config.capture.keepVisible],
          risks: { ...config.capture.risks },
        };

interface FabricConfigFilePlan {
  path: string;
  document: Record<string, unknown>;
  source: string;
  changed: boolean;
}

const planConfigFile = (filePath: string): FabricConfigFilePlan | undefined => {
  const input = readJsonObjectFile(filePath);
  if (!input) return undefined;
  const migration = migrateFabricConfigDocument(input.document);
  return {
    path: filePath,
    document: migration.document,
    source: input.source,
    changed: migration.changed,
  };
};

const writeJsonAtomic = (
  filePath: string,
  document: Record<string, unknown>,
  expectedSource?: string,
): void => {
  const resolvedPath = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const directory = path.dirname(resolvedPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const mode = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).mode & 0o777 : 0o600;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (expectedSource !== undefined) {
      let currentSource: string;
      try {
        currentSource = fs.readFileSync(resolvedPath, "utf8");
      } catch (error) {
        throw new Error(`Fabric configuration changed while updating ${filePath}`, { cause: error });
      }
      if (currentSource !== expectedSource) {
        throw new Error(`Fabric configuration changed while updating ${filePath}`);
      }
    }
    fs.renameSync(temporaryPath, resolvedPath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

export const loadFabricConfig = (options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): FabricConfig => {
  let merged = structuredClone(DEFAULT_FABRIC_CONFIG) as unknown as Record<string, unknown>;
  const plans = [
    planConfigFile(path.join(options.agentDir, "fabric.json")),
    ...(options.projectTrusted
      ? [planConfigFile(path.join(options.cwd, ".pi", "fabric.json"))]
      : []),
  ].filter((plan): plan is FabricConfigFilePlan => plan !== undefined);
  for (const plan of plans) {
    if (plan.changed) writeJsonAtomic(plan.path, plan.document, plan.source);
    merged = mergeObjects(merged, plan.document);
  }
  const inheritedFullCodeMode = process.env.PI_FABRIC_FULL_CODE_MODE;
  if (inheritedFullCodeMode === "true" || inheritedFullCodeMode === "false") {
    merged.fullCodeMode = inheritedFullCodeMode === "true";
  }
  const config = normalizeFabricConfig(merged);
  if (config.compaction.engine === "fabric") {
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
  } else {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  }
  return config;
};

export const saveFabricConfig = (
  options: { cwd: string; agentDir: string; projectTrusted: boolean },
  partial: Record<string, unknown>,
): { scope: "global" | "project"; path: string } => {
  const targetPath = options.projectTrusted
    ? path.join(options.cwd, ".pi", "fabric.json")
    : path.join(options.agentDir, "fabric.json");
  if (Object.hasOwn(partial, "configVersion") || Object.hasOwn(partial, "subagents")) {
    throw new Error("Fabric configuration updates must use the current schema");
  }
  const input = readJsonObjectFile(targetPath);
  const existing = migrateFabricConfigDocument(input?.document ?? {}).document;
  const merged = mergeObjects(existing, partial) as Record<string, unknown>;
  merged.configVersion = CURRENT_FABRIC_CONFIG_VERSION;
  writeJsonAtomic(targetPath, merged, input?.source);
  return { scope: options.projectTrusted ? "project" : "global", path: targetPath };
};
