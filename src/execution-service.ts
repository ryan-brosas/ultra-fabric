import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FabricExecutionTraceRecorder,
  executionOutcomeFromError,
  type FabricExecutionFailureStageV1,
  type FabricExecutionTraceOperationHandle,
  type FabricExecutionTraceV1,
} from "./audit/trace.js";
import { FabricActivityStore } from "./activity/store.js";
import type {
  FabricActivityEventInput,
  FabricActivityItemInput,
  FabricPhaseInput,
  FabricRunDisplay,
} from "./activity/types.js";
import {
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  type FabricConfig,
} from "./config.js";
import {
  ActionRegistry,
  type FabricCallAudit,
  type FabricRegistryActivityEvent,
} from "./core/action-registry.js";
import {
  ApprovalController,
  FabricSessionApprovals,
  type FabricAutoApprovalAudit,
} from "./core/approval-controller.js";
import { FabricAutoApprovalClassifier } from "./core/auto-approval-classifier.js";
import {
  admitConsult,
  type ConsultAdmissionDecision,
  type ConsultContextSnapshot,
} from "./consult/policy.js";
import { createFileEvidenceResolver } from "./consult/evidence.js";
import {
  reduceConsult,
  type ConsultResult,
  type ConsultWorkerInput,
} from "./consult/reducer.js";
import {
  consultWorkerFailureStatus,
  createConsultWorkerRequest,
  projectConsultWorkerResult,
} from "./consult/worker.js";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
} from "./runtime/orchestration.js";
import type {
  QuickJsRuntime,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./runtime/quickjs-runtime.js";
import type { NodeProcessRuntime } from "./runtime/node-process-runtime.js";
import type { FabricTypeError } from "./runtime/type-checker.js";
import {
  createFabricRunContext,
  type FabricEvidenceRef,
  type FabricGateInput,
  type FabricGateResult,
  type FabricRunBudgetSnapshot,
  type FabricRunEnvelopeV1,
  type FabricRunTransition,
} from "./run/context.js";
import type { FabricConsultOutcome, FabricOutcomeInput } from "./outcomes/store.js";

let runtimeDependencies:
  | Promise<{
      QuickJsRuntime: typeof import("./runtime/quickjs-runtime.js").QuickJsRuntime;
      NodeProcessRuntime: typeof import("./runtime/node-process-runtime.js").NodeProcessRuntime;
      typeCheckFabricCode: typeof import("./runtime/type-checker.js").typeCheckFabricCode;
      guestTypeDeclarations: typeof import("./runtime/guest-types.js").guestTypeDeclarations;
    }>
  | undefined;

const loadRuntimeDependencies = () =>
  runtimeDependencies ??= Promise.all([
    import("./runtime/quickjs-runtime.js"),
    import("./runtime/node-process-runtime.js"),
    import("./runtime/type-checker.js"),
    import("./runtime/guest-types.js"),
  ]).then(([quickjs, nodeProcess, checker, guest]) => ({
    QuickJsRuntime: quickjs.QuickJsRuntime,
    NodeProcessRuntime: nodeProcess.NodeProcessRuntime,
    typeCheckFabricCode: checker.typeCheckFabricCode,
    guestTypeDeclarations: guest.guestTypeDeclarations,
  }));

const executionOutcomeFromTermination = (
  reason: FabricSandboxTerminationReason,
): "succeeded" | "failed" | "aborted" | "timed_out" => {
  switch (reason) {
    case "completed":
      return "succeeded";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    case "runtime_error":
      return "failed";
  }
};

const fabricGateInput = (value: Record<string, unknown>): FabricGateInput => {
  const gate = typeof value.gate === "string" ? value.gate.trim() : "";
  if (!gate || gate.length > 256) {
    throw new Error("Fabric gate name must be 1-256 characters");
  }
  if (typeof value.passed !== "boolean") {
    throw new Error(`Fabric gate ${gate} requires passed: boolean`);
  }
  const disposition = value.disposition;
  if (disposition !== "advise" && disposition !== "revise" && disposition !== "abort") {
    throw new Error(`Fabric gate ${gate} has an invalid disposition`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 32) {
    throw new Error(`Fabric gate ${gate} evidence must be an array of at most 32 refs`);
  }
  const evidence = value.evidence.map<FabricEvidenceRef>((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Fabric gate ${gate} contains an invalid evidence ref`);
    }
    const candidate = entry as Record<string, unknown>;
    const kind = candidate.kind;
    if (
      (kind !== "command" &&
        kind !== "artifact" &&
        kind !== "trace" &&
        kind !== "custom") ||
      typeof candidate.ref !== "string" ||
      !candidate.ref.trim() ||
      candidate.ref.length > 2_048 ||
      (candidate.digest !== undefined &&
        (typeof candidate.digest !== "string" || candidate.digest.length > 256))
    ) {
      throw new Error(`Fabric gate ${gate} contains an invalid evidence ref`);
    }
    return {
      kind,
      ref: candidate.ref,
      ...(typeof candidate.digest === "string" ? { digest: candidate.digest } : {}),
    };
  });
  if (value.passed && evidence.length === 0) {
    throw new Error(`Fabric gate ${gate} passing result requires acceptance evidence`);
  }
  if (typeof value.reason === "string" && value.reason.length > 4_096) {
    throw new Error(`Fabric gate ${gate} reason exceeds 4096 characters`);
  }
  if (typeof value.error === "string" && value.error.length > 4_096) {
    throw new Error(`Fabric gate ${gate} error exceeds 4096 characters`);
  }
  return {
    gate,
    passed: value.passed,
    disposition,
    evidence,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
};

const consultContextSnapshot = (context: ExtensionContext): ConsultContextSnapshot => {
  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = typeof context.getContextUsage === "function"
      ? context.getContextUsage()
      : undefined;
  } catch {
    usage = undefined;
  }
  const tokens = usage?.tokens !== null && usage?.tokens !== undefined &&
    Number.isFinite(usage.tokens) ? Math.max(0, Math.floor(usage.tokens)) : null;
  const contextWindow = usage && Number.isFinite(usage.contextWindow)
    ? Math.max(0, Math.floor(usage.contextWindow))
    : 0;
  const ratio = usage?.percent !== null && usage?.percent !== undefined &&
    Number.isFinite(usage.percent)
    ? Math.max(0, Math.min(1, usage.percent / 100))
    : tokens !== null && contextWindow > 0
      ? Math.max(0, Math.min(1, tokens / contextWindow))
      : null;
  return { tokens, contextWindow, ratio };
};

const consultOutcomeSummary = (result: ConsultResult): FabricConsultOutcome => ({
  status: result.status,
  ...(result.mode ? { mode: result.mode } : {}),
  ...(result.admission?.code ? { admissionCode: result.admission.code } : {}),
  requested: result.coverage.requested,
  started: result.coverage.started,
  completed: result.coverage.completed,
  accepted: result.coverage.accepted,
  failed: result.coverage.failed,
  rejected: result.coverage.rejected,
  evidenceCount: result.evidenceCount,
  contextRatio: result.context.ratio,
  workerTokens: result.usage.tokens,
  workerCost: result.usage.cost,
});

const fabricGateFailureMessage = (result: FabricGateResult): string | undefined => {
  if (result.decision !== "abort") return undefined;
  if (result.failure === "gate_crashed") {
    return `Fabric gate crashed: ${result.gate}: ${result.error ?? "unknown error"}`;
  }
  if (result.failure === "revision_limit") {
    return `Fabric gate revision limit exhausted: ${result.gate}`;
  }
  return `Fabric gate aborted: ${result.gate}${result.reason ? `: ${result.reason}` : ""}`;
};

const aggregateUsage = (usages: Usage[]): Usage => ({
  input: usages.reduce((total, usage) => total + usage.input, 0),
  output: usages.reduce((total, usage) => total + usage.output, 0),
  cacheRead: usages.reduce((total, usage) => total + usage.cacheRead, 0),
  cacheWrite: usages.reduce((total, usage) => total + usage.cacheWrite, 0),
  ...(usages.some((usage) => usage.cacheWrite1h !== undefined)
    ? { cacheWrite1h: usages.reduce((total, usage) => total + (usage.cacheWrite1h ?? 0), 0) }
    : {}),
  ...(usages.some((usage) => usage.reasoning !== undefined)
    ? { reasoning: usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0) }
    : {}),
  totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
  cost: {
    input: usages.reduce((total, usage) => total + usage.cost.input, 0),
    output: usages.reduce((total, usage) => total + usage.cost.output, 0),
    cacheRead: usages.reduce((total, usage) => total + usage.cost.cacheRead, 0),
    cacheWrite: usages.reduce((total, usage) => total + usage.cost.cacheWrite, 0),
    total: usages.reduce((total, usage) => total + usage.cost.total, 0),
  },
});

export interface FabricExecutionResult {
  success: boolean;
  value: unknown;
  logs: string[];
  audits: FabricCallAudit[];
  phases: string[];
  trace: FabricExecutionTraceV1;
  elapsedMs: number;
  typeErrors?: FabricTypeError[];
  error?: string;
  handoffRequest?: Record<string, unknown>;
  usage?: Usage;
  run?: FabricRunEnvelopeV1;
  evidence?: FabricEvidenceRef[];
  gates?: FabricGateResult[];
  transitions?: FabricRunTransition[];
  budget?: FabricRunBudgetSnapshot;
  consult?: FabricConsultOutcome;
}

interface FabricExecutionPartial {
  audits: FabricCallAudit[];
  phases: string[];
  progress?: string | undefined;
}

export interface FabricExecutionAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface FabricExecutionOptions {
  code: string;
  strings?: Record<string, string>;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  context: ExtensionContext;
  tokenBudget?: number;
  maxAgentCalls?: number;
  display?: FabricRunDisplay;
  onPartial(snapshot: FabricExecutionPartial): void;
}

const outcomeRoute = (value: unknown): FabricOutcomeInput["routes"][number] | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const routeValue =
    typeof record.route === "object" && record.route !== null && !Array.isArray(record.route)
      ? record.route
      : typeof record.agent === "object" && record.agent !== null && !Array.isArray(record.agent)
        ? (record.agent as Record<string, unknown>).route
        : undefined;
  if (typeof routeValue !== "object" || routeValue === null || Array.isArray(routeValue)) {
    return undefined;
  }
  const route = routeValue as Record<string, unknown>;
  if (
    typeof route.requestedModel !== "string" ||
    typeof route.selectedModel !== "string" ||
    typeof route.reason !== "string" ||
    (route.quality !== "preserved" && route.quality !== "downgraded")
  ) {
    return undefined;
  }
  return {
    requestedModel: route.requestedModel,
    selectedModel: route.selectedModel,
    reason: route.reason,
    quality: route.quality,
  };
};

const outcomeUsage = (
  result: FabricExecutionResult,
): { tokens: number; cost: number } => {
  const values: Array<{ identity: string; value: unknown }> = [
    ...(result.usage ? [{ identity: "execution", value: result.usage }] : []),
    ...result.audits.map((audit) => {
      if (typeof audit.result !== "object" || audit.result === null || Array.isArray(audit.result)) {
        return { identity: `audit:${audit.nestedToolCallId}`, value: undefined };
      }
      const record = audit.result as Record<string, unknown>;
      return {
        identity: typeof record.id === "string"
          ? `run:${record.id}`
          : `audit:${audit.nestedToolCallId}`,
        value: record.usage,
      };
    }),
  ];
  const seen = new Set<string>();
  let tokens = 0;
  let cost = 0;
  for (const entry of values) {
    if (seen.has(entry.identity)) continue;
    seen.add(entry.identity);
    if (typeof entry.value !== "object" || entry.value === null || Array.isArray(entry.value)) {
      continue;
    }
    const usage = entry.value as Record<string, unknown>;
    const total = typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
          .reduce<number>((sum, amount) =>
            sum + (typeof amount === "number" && Number.isFinite(amount) ? Math.max(0, amount) : 0),
          0);
    tokens += Math.max(0, total);
    if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
      cost += Math.max(0, usage.cost);
    } else if (
      typeof usage.cost === "object" && usage.cost !== null && !Array.isArray(usage.cost) &&
      typeof (usage.cost as Record<string, unknown>).total === "number"
    ) {
      cost += Math.max(0, (usage.cost as { total: number }).total);
    }
  }
  return { tokens, cost };
};

const outcomeGateVerdict = (gates: readonly FabricGateResult[]): FabricOutcomeInput["gateVerdict"] => {
  if (gates.some((gate) => gate.failure === "gate_crashed")) return "crashed";
  if (gates.some((gate) => gate.decision === "abort")) return "abort";
  if (gates.some((gate) => gate.decision === "revise")) return "revise";
  if (gates.some((gate) => gate.passed)) return "passed";
  return "none";
};

export class FabricExecutionService {
  #runtime: QuickJsRuntime | NodeProcessRuntime | undefined;
  #runtimeKind: FabricConfig["executor"]["runtime"] | undefined;
  constructor(
    readonly registry: ActionRegistry,
    readonly config: FabricConfig,
    readonly activity?: FabricActivityStore,
    readonly authorizer?: FabricExecutionAuthorizer,
    readonly autoApprovalClassifier = new FabricAutoApprovalClassifier(),
    readonly sessionApprovals = new FabricSessionApprovals(),
    readonly outcomeSink?: { record(input: FabricOutcomeInput): Promise<unknown> },
  ) {}

  async #recordOutcome(result: FabricExecutionResult): Promise<FabricExecutionResult> {
    if (!this.outcomeSink || !result.run) return result;
    const usage = outcomeUsage(result);
    const routes = result.audits
      .map((audit) => outcomeRoute(audit.result))
      .filter((route): route is FabricOutcomeInput["routes"][number] => route !== undefined)
      .filter((route, index, all) =>
        all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(route)) === index
      );
    await this.outcomeSink.record({
      runId: result.run.runId,
      traceId: result.run.traceId,
      objectiveDigest: result.run.objectiveDigest,
      outcome: result.trace.outcome,
      startedAt: result.run.startedAt,
      finishedAt: result.run.startedAt + result.elapsedMs,
      durationMs: result.elapsedMs,
      tokens: usage.tokens,
      cost: usage.cost,
      gateVerdict: outcomeGateVerdict(result.gates ?? []),
      evidenceCount: result.evidence?.length ?? 0,
      routes,
      ...(result.consult ? { consult: result.consult } : {}),
      admissionReasons: [...new Set(result.audits.flatMap((audit) => {
        if (typeof audit.result !== "object" || audit.result === null || Array.isArray(audit.result)) {
          return [];
        }
        const admission = (audit.result as Record<string, unknown>).admission;
        if (typeof admission !== "object" || admission === null || Array.isArray(admission)) {
          return [];
        }
        const reason = (admission as Record<string, unknown>).reason;
        return typeof reason === "string" ? [reason] : [];
      }))],
    }).catch(() => undefined);
    return result;
  }

  async execute(options: FabricExecutionOptions): Promise<FabricExecutionResult> {
    const startedAt = performance.now();
    const orchestrationTimeoutMs = Math.max(
      this.config.executor.timeoutMs,
      this.config.agents.timeoutMs,
    );
    const effectiveTimeoutMs = codeUsesOrchestration(options.code)
      ? orchestrationTimeoutMs
      : this.config.executor.timeoutMs;
    const run = createFabricRunContext({
      runId: options.parentToolCallId,
      ...(process.env.PI_FABRIC_TRACE_ID
        ? { traceId: process.env.PI_FABRIC_TRACE_ID }
        : {}),
      ...(process.env.PI_FABRIC_PARENT_RUN
        ? { parentRunId: process.env.PI_FABRIC_PARENT_RUN }
        : {}),
      ...(process.env.PI_FABRIC_PARENT_SPAN_ID
        ? { parentSpanId: process.env.PI_FABRIC_PARENT_SPAN_ID }
        : {}),
      objective: options.code,
      timeoutMs: effectiveTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      maxAgents: Math.max(
        1,
        Math.min(
          options.maxAgentCalls ?? this.config.agents.maxPerExecution,
          this.config.agents.maxPerExecution,
        ),
      ),
      maxTokens: options.tokenBudget ?? Number.MAX_SAFE_INTEGER,
      maxEvidence: this.config.executor.maxRunEvidence,
      maxTransitions: this.config.executor.maxRunTransitions,
      maxGateRevisions: this.config.executor.maxGateRevisions,
    });
    let consultOutcome: FabricConsultOutcome | undefined;
    let consultAttempted = false;
    let consultSequence = 0;
    const consultAdmissions = new Map<string, ConsultAdmissionDecision>();
    const consultWorkers = new Map<string, Map<string, ConsultWorkerInput>>();
    run.transitions.record("accepted", run.envelope.startedAt);
    const runDetails = () => ({
      run: run.envelope,
      evidence: run.evidence.list(),
      gates: run.gates.list(),
      transitions: run.transitions.list(),
      budget: run.budget.snapshot(),
      ...(consultOutcome ? { consult: { ...consultOutcome } } : {}),
    });
    const traceRecorder = new FabricExecutionTraceRecorder();
    this.activity?.start(options.parentToolCallId, options.display);
    const dependencies = await loadRuntimeDependencies();
    const effectiveFullCodeMode =
      this.config.fullCodeMode || this.config.schema.mode === "enforce";
    const checked = dependencies.typeCheckFabricCode(
      options.code,
      dependencies.guestTypeDeclarations(effectiveFullCodeMode),
    );
    if (checked.errors.length > 0) {
      run.transitions.recordTerminal("failed");
      run.settle("failed");
      this.activity?.finish(options.parentToolCallId, false, "Type checking failed");
      return this.#recordOutcome({
        success: false,
        value: undefined,
        logs: [],
        audits: [],
        phases: [],
        trace: traceRecorder.seal("failed", [], "Type checking failed"),
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
        ...runDetails(),
      });
    }

    const classifierUsages: Usage[] = [];
    const recordAutoDecision = (
      audit: FabricAutoApprovalAudit,
      decision?: { usage: Usage },
    ): void => {
      const operation = traceRecorder.issueCall("fabric.approval.auto", {
        action: audit.action,
        risk: audit.risk,
      });
      operation.succeed(audit);
      if (decision) classifierUsages.push(decision.usage);
    };
    const approval = new ApprovalController(
      this.config.approvals,
      options.context,
      this.sessionApprovals,
      this.autoApprovalClassifier,
      recordAutoDecision,
    );
    const audits: FabricCallAudit[] = [];
    const phases: string[] = [];
    const workflowSpans = new Map<
      string,
      { kind: "parallel" | "pipeline"; operation: FabricExecutionTraceOperationHandle }
    >();
    let handoffRequest: Record<string, unknown> | undefined;
    const tokenBudgetEnabled = options.tokenBudget !== undefined;
    const agentRefs = new Set([
      "agents.run",
      "agents.handoff",
      "agents.spawn",
      "agents.create",
      "agents.ask",
      "agents.tell",
    ]);
    const tokenBoundRefs = new Set([
      "agents.run",
      "agents.handoff",
      "agents.spawn",
      "agents.ask",
      "agents.tell",
    ]);
    const blockingTokenRefs = new Set(["agents.run", "agents.ask"]);
    const reserveAgentCall = (
      ref: string,
      args: Record<string, unknown>,
    ): { id: string; tokens: number; args: Record<string, unknown> } | undefined => {
      if (!agentRefs.has(ref)) return undefined;
      const remaining = run.budget.snapshot().tokens.remaining;
      let tokens = 0;
      if (tokenBudgetEnabled && tokenBoundRefs.has(ref)) {
        const requested =
          typeof args.maxTokens === "number" && Number.isFinite(args.maxTokens)
            ? Math.max(1, Math.floor(args.maxTokens))
            : this.config.agents.maxTokensPerChild > 0
              ? this.config.agents.maxTokensPerChild
              : remaining;
        tokens = Math.min(requested, remaining);
        if (tokens < 1) {
          throw new Error(`Fabric token budget exhausted (${run.budget.snapshot().tokens.limit} per execution)`);
        }
      }
      const reserved = run.budget.reserveAgent({ tokens });
      if (!reserved.ok) {
        if (reserved.reason === "agent_limit") {
          throw new Error(`Fabric agent budget exhausted (${reserved.limit} per execution)`);
        }
        throw new Error(`Fabric token budget exhausted (${reserved.limit} per execution)`);
      }
      return {
        ...reserved.reservation,
        args: tokenBudgetEnabled && tokenBoundRefs.has(ref)
          ? { ...args, maxTokens: reserved.reservation.tokens }
          : args,
      };
    };
    const resultTokens = (value: unknown): number => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
      const usage = (value as { usage?: unknown }).usage;
      if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return 0;
      const record = usage as Record<string, unknown>;
      return [record.input, record.output, record.cacheRead, record.cacheWrite].reduce<number>(
        (total, amount) =>
          total +
          (typeof amount === "number" && Number.isFinite(amount)
            ? Math.max(0, amount)
            : 0),
        0,
      );
    };
    const settleAgentCall = (
      ref: string,
      reservation: { id: string; tokens: number } | undefined,
      value: unknown,
      failed = false,
    ): void => {
      if (!reservation) return;
      let actualTokens = 0;
      if (failed) {
        if (ref === "agents.ask") actualTokens = reservation.tokens;
      } else if (blockingTokenRefs.has(ref)) {
        actualTokens = resultTokens(value);
      } else if (tokenBoundRefs.has(ref)) {
        actualTokens = reservation.tokens;
      }
      run.budget.settle(reservation.id, { actualTokens });
    };
    const fullCodeProvider = (value: string): "pi" | "extensions" | undefined => {
      const separator = value.indexOf(".");
      const provider = separator > 0 ? value.slice(0, separator) : value;
      return provider === "pi" || provider === "extensions" ? provider : undefined;
    };
    const guardFullCodeRef = (ref: string): void => {
      if (effectiveFullCodeMode) return;
      const provider = fullCodeProvider(ref);
      if (!provider) return;
      throw new Error(
        `Fabric full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside fabric_exec`,
      );
    };
    let currentProgress: string | undefined;
    let emitPending = false;
    let emitTimer: NodeJS.Timeout | undefined;
    const emitNow = (): void => {
      emitPending = false;
      options.onPartial({
        audits: audits.slice(),
        phases: phases.slice(),
        progress: currentProgress,
      });
    };
    const flushEmit = (): void => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = undefined;
      if (emitPending) emitNow();
    };
    // One execution-wide timer coalesces updates from every parallel nested
    // call. Keeping this global to the Fabric program prevents each call from
    // independently churning rows while preserving a trailing final snapshot.
    const emit = (): void => {
      emitPending = true;
      const debounceMs = this.config.ui.nestedToolDebounceMs;
      if (debounceMs <= 0) {
        flushEmit();
        return;
      }
      // Throttle to one render per window without resetting the timer. A
      // trailing debounce starves continuously streaming tools because every
      // delta postpones the render until the tool finishes.
      if (emitTimer) return;
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        if (emitPending) emitNow();
      }, debounceMs);
      emitTimer.unref?.();
    };
    const update = (message: string): void => {
      currentProgress = message;
      emit();
    };
    const observeInvocation = (event: FabricRegistryActivityEvent): void => {
      if (this.activity) {
        if (event.type === "call_start") {
          this.activity.beginCall(options.parentToolCallId, event);
        } else if (event.type === "call_update") {
          this.activity.updateCall(options.parentToolCallId, event.callId, event.update);
        } else if (event.type === "call_args") {
          this.activity.updateCallArgs(options.parentToolCallId, event.callId, event.args);
        } else {
          this.activity.finishCall(options.parentToolCallId, event.callId, event);
        }
      }
      if (event.type === "call_end") emit();
    };
    const baseContext = {
      cwd: options.context.cwd,
      get run() {
        return run.envelope;
      },
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
      nestedToolCallId: `${options.parentToolCallId}_metadata`,
      extensionContext: options.context,
      update,
    };
    // Calls reached through generic or computed refs can extend the active
    // sandbox deadline before they run.
    const extendRunDeadline = (minimumTimeoutMs: number): number => {
      run.extendDeadline(Date.now() + minimumTimeoutMs);
      return minimumTimeoutMs;
    };
    const minimumTimeoutMsForHostCall = (
      ref: string,
      args: Record<string, unknown>,
    ): number | undefined => {
      const targetRef =
        ref === "fabric.$call" && typeof args.ref === "string" ? args.ref : ref;
      const targetArgs =
        ref === "fabric.$call" &&
        typeof args.args === "object" &&
        args.args !== null &&
        !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : args;
      if (targetRef === "pi.bash") {
        const seconds = targetArgs.timeout;
        const milliseconds = targetArgs.timeoutMs;
        const requested =
          typeof seconds === "number" && Number.isFinite(seconds)
            ? seconds * 1_000
            : typeof milliseconds === "number" && Number.isFinite(milliseconds)
              ? milliseconds
              : 0;
        if (requested > 0) {
          return extendRunDeadline(
            Math.max(
              this.config.executor.timeoutMs,
              Math.min(Math.floor(requested) + 5_000, MAX_AGENT_TIMEOUT_MS),
            ),
          );
        }
      }
      if (!isBlockingOrchestrationRef(targetRef)) return undefined;
      const requestedTimeoutMs =
        targetRef === "agents.run" &&
        typeof targetArgs.timeoutMs === "number" &&
        Number.isFinite(targetArgs.timeoutMs)
          ? Math.max(
              MIN_AGENT_TIMEOUT_MS,
              Math.min(Math.floor(targetArgs.timeoutMs), MAX_AGENT_TIMEOUT_MS),
            )
          : 0;
      return extendRunDeadline(Math.max(orchestrationTimeoutMs, requestedTimeoutMs));
    };
    const traceAttempt = async <T>(
      ref: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      run: (setStage: (stage: FabricExecutionFailureStageV1) => void) => T | Promise<T>,
    ): Promise<T> => {
      const operation = traceRecorder.issueCall(ref, args);
      let stage: FabricExecutionFailureStageV1 = "invoke";
      try {
        const value = await run((nextStage) => {
          stage = nextStage;
        });
        operation.succeed(undefined);
        return value;
      } catch (error) {
        operation.fail(stage, error, executionOutcomeFromError(error, signal));
        throw error;
      }
    };
    const invokeAction = async (
      ref: string,
      args: Record<string, unknown>,
      callContext: typeof baseContext & { signal: AbortSignal },
    ): Promise<unknown> => {
      const traceOperation = traceRecorder.issueCall(ref, args);
      let reservation:
        | { id: string; tokens: number; args: Record<string, unknown> }
        | undefined;
      try {
        guardFullCodeRef(ref);
        reservation = reserveAgentCall(ref, args);
      } catch (error) {
        traceOperation.fail(
          "guard",
          error,
          executionOutcomeFromError(error, callContext.signal),
        );
        throw error;
      }
      try {
        const value = await this.registry.invoke(ref, reservation?.args ?? args, {
          ...callContext,
          ...(ref === "agents.handoff"
            ? {
                deferHandoff(request: Record<string, unknown>) {
                  if (handoffRequest) {
                    throw new Error(
                      "Only one agents.handoff request is allowed per fabric_exec invocation",
                    );
                  }
                  handoffRequest = structuredClone(request);
                  return {
                    scheduled: true,
                    status: "deferred",
                    boundary: "fabric_exec_end",
                  };
                },
              }
            : {}),
          ...(this.authorizer
            ? {
                authorize: (action) =>
                  this.authorizer!.authorize(action.ref, options.parentToolCallId),
              }
            : {}),
          approve: async (action, preparedArgs) => {
            if (action.ref === "schema.commit") {
              await approval.approve({ ...action, risk: "write" }, preparedArgs);
              await approval.approve({ ...action, risk: "execute" }, preparedArgs);
              return;
            }
            await approval.approve(action, preparedArgs);
          },
          audits,
          maxResultChars: this.config.executor.maxNestedResultChars,
          traceOperation,
          observeInvocation,
        });
        settleAgentCall(ref, reservation, value);
        return value;
      } catch (error) {
        settleAgentCall(ref, reservation, undefined, true);
        throw error;
      }
    };
    let sandboxResult: FabricSandboxResult;
    run.transitions.record("executing");
    try {
      const runtimeKind = this.config.executor.runtime;
      if (!this.#runtime || this.#runtimeKind !== runtimeKind) {
        this.#runtime = runtimeKind === "node-process"
          ? new dependencies.NodeProcessRuntime()
          : new dependencies.QuickJsRuntime();
        this.#runtimeKind = runtimeKind;
      }
      sandboxResult = await this.#runtime.execute(
        options.code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "fabric.$providers":
              return traceAttempt(
                "fabric.discovery.providers",
                args,
                runtimeSignal,
                () =>
                  this.registry
                    .providers()
                    .filter(
                      (provider) => effectiveFullCodeMode || !fullCodeProvider(provider.name),
                    ),
              );
            case "fabric.$catalog":
              return traceAttempt(
                "fabric.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "fabric.$catalog":
              return traceAttempt(
                "fabric.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "fabric.$models": {
              const operation = traceRecorder.issueCall("fabric.discovery.models", args);
              const registry = options.context.modelRegistry;
              try {
                const available =
                  typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
                const models = available.map((model) => ({
                  provider: String(model.provider),
                  id: String(model.id),
                  name: String(model.name ?? model.id),
                  key: `${model.provider}/${model.id}`,
                }));
                operation.succeed(undefined);
                return models;
              } catch (error) {
                operation.fail(
                  "invoke",
                  error,
                  executionOutcomeFromError(error, runtimeSignal),
                );
                return [];
              }
            }
            case "fabric.$list":
              return traceAttempt(
                "fabric.discovery.list",
                args,
                runtimeSignal,
                async (setStage) => {
                  setStage("guard");
                  if (typeof args.provider === "string") {
                    guardFullCodeRef(`${args.provider}.*`);
                  }
                  setStage(
                    typeof args.provider === "string" && !this.registry.has(args.provider)
                      ? "resolve"
                      : "invoke",
                  );
                  const actions = await this.registry.list(
                    {
                      ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
                      ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                      ...(typeof args.query === "string" ? { query: args.query } : {}),
                      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    },
                    callContext,
                  );
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "fabric.$search":
              return traceAttempt(
                "fabric.discovery.search",
                args,
                runtimeSignal,
                async () => {
                  const actions = await this.registry.search(
                    String(args.query ?? ""),
                    callContext,
                    typeof args.limit === "number" ? args.limit : undefined,
                  );
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "fabric.$describe":
              return traceAttempt(
                "fabric.discovery.describe",
                args,
                runtimeSignal,
                async (setStage) => {
                  const targetRef = String(args.ref ?? "");
                  setStage("guard");
                  guardFullCodeRef(targetRef);
                  setStage("resolve");
                  return this.registry.describe(targetRef, callContext);
                },
              );
            case "fabric.$call": {
              const callArgs =
                typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                  ? (args.args as Record<string, unknown>)
                  : {};
              const targetRef = String(args.ref ?? "");
              return invokeAction(targetRef, callArgs, callContext);
            }
            case "fabric.$progress":
              return traceAttempt(
                "fabric.workflow.progress",
                args,
                runtimeSignal,
                () => update(String(args.message ?? "Working")),
              );
            case "fabric.$runContext":
              return traceAttempt(
                "fabric.workflow.context",
                args,
                runtimeSignal,
                () => ({
                  run: run.envelope,
                  budget: run.budget.snapshot(),
                }),
              );
            case "fabric.$consultAdmit":
              return traceAttempt(
                "fabric.consult.admit",
                {},
                runtimeSignal,
                () => {
                  const budget = run.budget.snapshot();
                  const context = consultContextSnapshot(options.context);
                  let decision: ConsultAdmissionDecision;
                  if (consultAttempted) {
                    decision = {
                      kind: "not_admitted",
                      code: "already_attempted",
                      message: "Only one Ultra Consult attempt is allowed per parent execution",
                      context,
                    };
                  } else {
                    const candidate = admitConsult(
                      args.request,
                      context,
                      {
                        enabled: this.config.consult.enabled && this.config.agents.enabled,
                        maxWorkers: this.config.consult.maxWorkers,
                        contextPressureThreshold: this.config.consult.contextPressureThreshold,
                      },
                    );
                    decision = candidate.kind === "admitted" &&
                        budget.agents.remaining < candidate.request.perspectives.length
                      ? {
                          kind: "not_admitted",
                          code: "agent_budget_exhausted",
                          message: "The parent execution has insufficient agent slots for Ultra Consult",
                          context,
                        }
                      : candidate;
                  }
                  consultAttempted = true;
                  const ticket = `consult-${++consultSequence}`;
                  consultAdmissions.set(ticket, decision);
                  if (decision.kind === "admitted") {
                    consultWorkers.set(ticket, new Map());
                    run.transitions.record("consult_admitted", Date.now(), {
                      mode: decision.mode,
                      workers: decision.request.perspectives.length,
                      context: decision.context,
                    });
                    update(`Ultra Consult admitted ${decision.request.perspectives.length} ${decision.mode} worker(s)`);
                  } else {
                    run.transitions.record("consult_not_admitted", Date.now(), {
                      code: decision.code,
                      context: decision.context,
                    });
                    update(`Ultra Consult stayed inline: ${decision.code}`);
                  }
                  return { ...decision, ticket };
                },
              );
            case "fabric.$consultWorker":
              return traceAttempt(
                "fabric.consult.worker",
                {
                  ticket: typeof args.ticket === "string" ? args.ticket : "",
                  perspectiveId: typeof args.perspectiveId === "string" ? args.perspectiveId : "",
                },
                runtimeSignal,
                async () => {
                  const ticket = typeof args.ticket === "string" ? args.ticket : "";
                  const perspectiveId = typeof args.perspectiveId === "string"
                    ? args.perspectiveId
                    : "";
                  const admission = consultAdmissions.get(ticket);
                  const workers = consultWorkers.get(ticket);
                  if (admission?.kind !== "admitted" || !workers) {
                    throw new Error("Unknown or non-admitted Ultra Consult ticket");
                  }
                  const perspective = admission.request.perspectives.find(
                    (candidate) => candidate.id === perspectiveId,
                  );
                  if (!perspective) throw new Error("Unknown Ultra Consult perspective");
                  const existing = workers.get(perspectiveId);
                  if (existing) {
                    return { perspectiveId, status: existing.status };
                  }
                  workers.set(perspectiveId, { perspectiveId, status: "not_started" });
                  try {
                    const workerContext = {
                      ...callContext,
                      consultReadScope: { scopes: [...perspective.scope] },
                    };
                    const value = await invokeAction(
                      "agents.run",
                      createConsultWorkerRequest(admission, perspective, this.config.consult),
                      workerContext,
                    );
                    const worker = projectConsultWorkerResult(perspective.id, value);
                    workers.set(perspective.id, worker);
                    return { perspectiveId, status: worker.status };
                  } catch (error) {
                    const worker: ConsultWorkerInput = {
                      perspectiveId,
                      status: consultWorkerFailureStatus(error),
                      error: error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048),
                      ...(perspective.model ? { model: perspective.model } : {}),
                    };
                    workers.set(perspectiveId, worker);
                    return { perspectiveId, status: worker.status };
                  }
                },
              );
            case "fabric.$consultReduce":
              return traceAttempt(
                "fabric.consult.reduce",
                {},
                runtimeSignal,
                async () => {
                  const ticket = typeof args.ticket === "string" ? args.ticket : "";
                  const ticketed = ticket ? consultAdmissions.get(ticket) : undefined;
                  const budget = run.budget.snapshot();
                  const admission = ticketed ?? admitConsult(
                    args.request,
                    consultContextSnapshot(options.context),
                    {
                      enabled: this.config.consult.enabled && this.config.agents.enabled,
                      maxWorkers: Math.min(
                        this.config.consult.maxWorkers,
                        Math.max(1, budget.agents.spent + budget.agents.remaining),
                      ),
                      contextPressureThreshold: this.config.consult.contextPressureThreshold,
                    },
                  );
                  let result: ConsultResult;
                  try {
                    result = await reduceConsult(
                      admission,
                      ticket ? [...(consultWorkers.get(ticket)?.values() ?? [])] : [],
                      {
                        maxFindingsPerWorker: this.config.consult.maxFindingsPerWorker,
                        maxEvidencePerFinding: this.config.consult.maxEvidencePerFinding,
                      },
                      createFileEvidenceResolver(options.context.cwd, {
                        maxFileBytes: this.config.consult.maxEvidenceFileBytes,
                        maxTotalBytes: this.config.consult.maxEvidenceBytesPerConsult,
                      }),
                    );
                  } finally {
                    if (ticket) {
                      consultAdmissions.delete(ticket);
                      consultWorkers.delete(ticket);
                    }
                  }
                  if (ticket === "consult-1" || (!ticket && !consultOutcome)) {
                    consultOutcome = consultOutcomeSummary(result);
                  }
                  if (admission.kind === "admitted") {
                    const recorded = new Set<string>();
                    for (const finding of result.findings) {
                      for (const evidence of finding.evidence) {
                        if (recorded.has(evidence.ref)) continue;
                        recorded.add(evidence.ref);
                        run.evidence.record({ kind: "artifact", ref: evidence.ref });
                      }
                    }
                    run.transitions.record("consult_completed", Date.now(), {
                      mode: admission.mode,
                      status: result.status,
                      coverage: result.coverage,
                      evidenceCount: result.evidenceCount,
                      context: result.context,
                      usage: result.usage,
                    });
                    update(`Ultra Consult ${result.status}: ${result.coverage.accepted}/${result.coverage.requested} perspective(s) accepted`);
                  }
                  return result;
                },
              );
            case "fabric.$configure":
              return traceAttempt(
                "fabric.workflow.configure",
                args,
                runtimeSignal,
                () => {
                  const display: FabricRunDisplay = {
                    ...(typeof args.name === "string" ? { name: args.name } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                  };
                  return this.activity?.configure(options.parentToolCallId, display) ?? display;
                },
              );
            case "fabric.$phase":
              return traceAttempt(
                "fabric.workflow.phase",
                args,
                runtimeSignal,
                (setStage) => {
                  setStage("validate");
                  const name =
                    typeof args.name === "string" ? args.name.trim() : "";
                  if (!name) throw new Error("Workflow phase name must be a non-empty string");
                  phases.push(name);
                  const phaseIndex = phases.length - 1;
                  const phaseInput: FabricPhaseInput = {
                    name,
                    ...(typeof args.id === "string" ? { id: args.id } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                    ...(typeof args.total === "number" ? { total: args.total } : {}),
                  };
                  setStage("invoke");
                  const activityPhase = this.activity?.phase(options.parentToolCallId, phaseInput);
                  update(`Phase: ${name}`);
                  return {
                    name,
                    index: phaseIndex,
                    ...(activityPhase ? { id: activityPhase.id } : {}),
                  };
                },
              );
            case "fabric.$gate":
              return traceAttempt(
                "fabric.workflow.gate",
                args,
                runtimeSignal,
                (setStage) => {
                  const gate = typeof args.gate === "string" && args.gate.trim()
                    ? args.gate.trim()
                    : "invalid";
                  try {
                    setStage("validate");
                    const input = fabricGateInput(args);
                    for (const evidence of input.evidence) {
                      const recorded = run.evidence.record(evidence);
                      if (!recorded.ok) {
                        throw new Error(`Fabric run evidence limit exhausted (${recorded.limit})`);
                      }
                    }
                    const result = run.gates.record(input);
                    run.transitions.record(`gate:${result.gate}:${result.decision}`);
                    const gateError = fabricGateFailureMessage(result);
                    if (gateError) throw new Error(gateError);
                    setStage("invoke");
                    return result;
                  } catch (error) {
                    run.gates.crash(
                      gate,
                      error instanceof Error ? error.message : String(error),
                    );
                    throw error;
                  }
                },
              );

            case "fabric.$item":
              return traceAttempt(
                "fabric.workflow.item",
                args,
                runtimeSignal,
                () => {
                  const item = args as unknown as FabricActivityItemInput;
                  return this.activity?.upsertItem(options.parentToolCallId, item) ?? item;
                },
              );
            case "fabric.$event":
              return traceAttempt(
                "fabric.workflow.event",
                args,
                runtimeSignal,
                () => {
                  const event = args as unknown as FabricActivityEventInput;
                  this.activity?.event(options.parentToolCallId, event);
                },
              );
            case "fabric.$spanStart": {
              const id = typeof args.id === "string" ? args.id : "";
              const kind = args.kind;
              if (!id || (kind !== "parallel" && kind !== "pipeline")) {
                throw new Error("Invalid internal workflow span start");
              }
              if (workflowSpans.has(id)) throw new Error("Duplicate internal workflow span");
              const operation = traceRecorder.issueCall(`fabric.workflow.${kind}`, args);
              workflowSpans.set(id, { kind, operation });
              return undefined;
            }
            case "fabric.$spanEnd": {
              const id = typeof args.id === "string" ? args.id : "";
              const span = workflowSpans.get(id);
              if (!span) throw new Error("Unknown internal workflow span");
              workflowSpans.delete(id);
              if (args.outcome === "succeeded") span.operation.succeed(undefined);
              else {
                span.operation.fail(
                  "invoke",
                  undefined,
                  executionOutcomeFromError(new Error("Workflow span failed"), runtimeSignal),
                );
              }
              return undefined;
            }
            default:
              return invokeAction(ref, args, callContext);
          }
        },
        {
          timeoutMs: effectiveTimeoutMs,
          memoryLimitBytes: this.config.executor.memoryLimitBytes,
          maxLogChars: this.config.executor.maxOutputChars,
          minimumTimeoutMsForHostCall,
          ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
          ...(options.strings ? { strings: options.strings } : {}),
          ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = executionOutcomeFromError(error, options.signal);
      run.transitions.recordTerminal(outcome);
      run.settle(outcome);
      this.activity?.finish(options.parentToolCallId, false, message);
      await this.#recordOutcome({
        success: false,
        value: undefined,
        logs: [],
        audits,
        phases,
        trace: traceRecorder.seal(outcome, phases, message),
        elapsedMs: performance.now() - startedAt,
        error: message,
        ...runDetails(),
      });
      throw error;
    } finally {
      await this.registry.endInvocation(options.parentToolCallId);
      flushEmit();
    }

    const runtimeOutcome = executionOutcomeFromTermination(sandboxResult.terminationReason);
    const pendingRevisions = run.gates.pending();
    const terminalGate = run.gates.terminal();
    const terminalGateError = terminalGate
      ? fabricGateFailureMessage(terminalGate)
      : undefined;
    const gateRevisionError =
      !terminalGateError && runtimeOutcome === "succeeded" && pendingRevisions.length > 0
        ? `Fabric gate revision required: ${pendingRevisions.join(", ")}`
        : undefined;
    const runOutcome = terminalGateError || gateRevisionError ? "failed" : runtimeOutcome;
    const succeeded = runOutcome === "succeeded";
    run.transitions.recordTerminal(succeeded ? "completed" : runOutcome);
    run.settle(runOutcome);
    const runError = terminalGateError ?? gateRevisionError ?? sandboxResult.error;
    this.activity?.finish(options.parentToolCallId, succeeded, runError);
    return this.#recordOutcome({
      success: succeeded,
      value: terminalGateError || gateRevisionError ? undefined : sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      phases,
      trace: traceRecorder.seal(runOutcome, phases, runError),
      elapsedMs: performance.now() - startedAt,
      ...runDetails(),
      ...(runError ? { error: runError } : {}),
      ...(handoffRequest ? { handoffRequest } : {}),
      ...(classifierUsages.length > 0
        ? { usage: aggregateUsage(classifierUsages) }
        : {}),
    });
  }
}
