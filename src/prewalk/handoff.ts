import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FabricResultFormat } from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type { FabricInvocationActivityUpdate } from "../protocol.js";
import type { PrewalkController } from "./controller.js";
import type { FabricPrewalkChecklist } from "./checklist.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  PREWALK_CONTINUE_MESSAGE_TYPE,
} from "./continuation.js";
import { requirePrewalkModel } from "./model.js";

export { PREWALK_ARMED_MESSAGE_TYPE } from "./continuation.js";

const PREWALK_CONTINUE_PROMPT = [
  "Continue the existing task in this same session under the new executor model.",
  "Do not stop merely because the model changed or because the first mutation succeeded.",
  "Finish the remaining implementation, check matching call sites for consistency, and run the relevant verification before reporting completion.",
].join(" ");

export const checklistContinuationPrompt = (
  checklist: FabricPrewalkChecklist,
): string => [
  "Continue the existing implementation in this same session under the executor model. The first mutation already succeeded.",
  "Keep this host-accepted checklist active until every remaining item and validation is complete:",
  ...checklist.items.map(
    (item, index) => `${index + 1}. ${item.task}\n   Validation: ${item.validation}`,
  ),
  "As you complete each checklist item above, emit its [DONE:n] marker in the same turn, where n is the item's number above; for example [DONE:2] for item 2. The host advances the checklist and strikes the item through from these markers.",
  "Before claiming completion: sweep every other call site for any pattern, signature, or check you changed and apply the same change; keep the diff minimal and confirm no out-of-scope behavior changed; run the full test module the change lives in, not just the test you expect to flip.",
  "Finish the implementation, run every listed validation plus the relevant final verification, and only then report completion.",
].join("\n");

// Forced continuation after a completed trajectory handoff: Main must not
// settle idle at the boundary. The executor's implementation is the source of
// truth — Main verifies it with real checks and reports, redoing nothing.
const PREWALK_GATED_VERIFY_PROMPT = [
  "Prewalk execution phase complete. Verify the existing implementation; do not redo it speculatively.",
  "Run the smallest relevant behavioral checks in fabric_exec, then finish that same fabric_exec with workflow.gate().",
  "Report passed: true with concrete command/artifact evidence when acceptance holds.",
  "If a check fails, report passed: false, disposition: 'revise', the failed evidence ref, and scoped reason; Prewalk will return only that feedback to the executor within its revision cap.",
  "Use disposition: 'abort' only when downstream work must stop. Do not claim completion without a passing gate.",
].join(" ");


// Arm-time framing is LLM-visible, TUI-hidden, and does not fire an
// input event. Research framing has a distinct custom type so its plan
// message is identifiable; the context hook removes both framing types
// before the executor's first inference.
export const prewalkArmedMessageType = (): string =>
  PREWALK_ARMED_MESSAGE_TYPE;

// Research-arm-only enrichment: full-pass budget spend, arXiv grounding, and an aligned repo clone under sources/.
const PREWALK_RESEARCH_ENRICHMENT = [
  "Spend the research budget in full passes: batch retrieval, consume the deep-research ceiling, and return dense findings. Do not drip small queries.",
  "When the task depends on an unfamiliar algorithm, technique, or external system, ground it before implementation: find one aligned arXiv paper for the technique and clone the aligned GitHub repository into sources/ for reference, instead of fetching isolated files.",
].join(" ");

const researchArmedPrompt = (model: string): string => [
  `Prewalk armed → ${model} (research).`,
  "Before any further mutation, commit to a deep, concrete remaining execution plan grounded in the context already gathered. Cover the target files or symbols, dependencies, edge cases, and proof.",
  PREWALK_RESEARCH_ENRICHMENT,
  "In that same reply, call prewalk.checklist({ items }) inside fabric_exec with 5-9 ordered items; every item needs a concrete task and specific validation. The host rejects mutation until the checklist is accepted.",
  "Phrase every validation as observable evidence, goal-backward: a command that exits 0, a named test that passes, or a file:line that proves the claim — never intent like \"should work\". If the task needs two checks, list both.",
  "Easy escape: bounded mid-tier tasks may call prewalk.checklist({ easy: true, items }) with 2-4 items; the host still hands off but Main skips deep research.",
  "Trivial escape: if the task clearly fits in one or two small edits, call prewalk.checklist({ trivial: true }) inside fabric_exec instead and complete the task directly in this same turn; the host records the trivial disposition, skips the mutation boundary, and makes no model swap or handoff.",
  "After the checklist is accepted, stop. Do not make any mutation yourself. The host ends fabric_exec at the accepted checklist and switches this session to the executor model.",
  "The executor owns the remaining implementation and verification through completion.",
].join("\n");

export const prewalkArmedPrompt = (model: string): string => researchArmedPrompt(model);

const customMessageText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
};

// Pileup guard: only skip when an identical armed prompt already persists in
// the branch, so re-arming with a different mode/model still announces itself.
export const hasPrewalkArmedPrompt = (
  entries: ReadonlyArray<unknown>,
  content: string,
  messageType = PREWALK_ARMED_MESSAGE_TYPE,
): boolean =>
  entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; customType?: unknown; content?: unknown };
    return (
      candidate.type === "custom_message" &&
      candidate.customType === messageType &&
      customMessageText(candidate.content) === content
    );
  });


export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk-research";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  checklist?: FabricPrewalkChecklist;
  fallbackModels?: string[];
  triggerRef?: string;
  verificationMode?: "gated";
  maxPhaseRevisions?: number;
  revision?: number;
  returnModel?: string;
}

const createPrewalkPending = (input: {
  arm: import("./lifecycle.js").FabricPrewalkArm;
  nestedToolCallId: string;
  resultFormat: FabricResultFormat;
  triggerRef: string;
  revision?: { number: number; gate: string; feedback: string };
  returnModel?: string;
}): PendingFabricHandoff => {
  const revisionTask = input.revision
    ? [
        input.arm.task ? `Continue the existing task: ${input.arm.task}` : "Continue the existing task.",
        `Revision ${input.revision.number} required by verification gate ${input.revision.gate}.`,
        `Scoped feedback: ${input.revision.feedback}`,
        "Change only what the failed evidence requires, then leave verification to Main.",
      ].join("\n\n").slice(0, 20_000)
    : input.arm.task;
  const args = {
    model: input.arm.model,
    name: "Research Prewalk executor",
    ...(revisionTask ? { task: revisionTask } : {}),
    ...(!input.revision && input.arm.checklist
      ? {
          task: [
            input.arm.task ? `Continue the existing task: ${input.arm.task}` : "Continue the existing task in the forked session.",
            "Keep this host-accepted checklist active until every item and validation is complete:",
            ...input.arm.checklist.items.map(
              (item, index) => `${index + 1}. ${item.task}\n   Validation: ${item.validation}`,
            ),
            "Finish the implementation, run every listed validation plus the relevant final verification, and only then report completion.",
          ].join("\n").slice(0, 20_000),
        }
      : {}),
    ...(input.arm.thinking ? { thinking: input.arm.thinking } : {}),
  };
  const audit: FabricCallAudit = {
    ref: "fabric.prewalk",
    nestedToolCallId: input.nestedToolCallId,
    startedAt: Date.now(),
    tool: "prewalk",
    provider: "fabric",
    args,
  };
  return {
    kind: "prewalk-research" as const,
    args,
    audit,
    resultFormat: input.resultFormat,
    ...(input.arm.checklist
      ? { checklist: structuredClone(input.arm.checklist) }
      : {}),
    ...(input.arm.fallbackModels
      ? { fallbackModels: [...input.arm.fallbackModels] }
      : {}),
    triggerRef: input.triggerRef,
    ...(input.arm.verificationMode ? { verificationMode: input.arm.verificationMode } : {}),
    ...(input.arm.maxPhaseRevisions !== undefined
      ? { maxPhaseRevisions: input.arm.maxPhaseRevisions }
      : {}),
    ...(input.revision ? { revision: input.revision.number } : {}),
    ...(input.returnModel ? { returnModel: input.returnModel } : {}),
  };
};

// Appended to the replaced boundary tool result so the framing persists with
// what Main keeps seeing, anchoring every later turn. Advisory only: prewalk
// cannot gate the next claim on a plan, and bash edits stay invisible to it.
const TRAJECTORY_REARM_DIRECTIVE = [
  "Prewalk handoff completed — the executor's result above is final; don't redo it.",
  "Prewalk will re-arm after the hidden follow-up settles; on the next request, restate remaining steps (skip if trivial), then make changes via pi.edit / pi.write in fabric_exec to hand off again.",
  "A hidden follow-up turn verifies the executor's work and summarizes; keep any fixes scoped to what verification fails.",
].join("\n");

export const withTrajectoryRearmDirective = (
  text: string,
  pending: PendingFabricHandoff,
  handoff: Record<string, unknown>,
  controller: PrewalkController,
  sessionId: string,
): string => {
  const status = controller.status();
  return handoff.completed === true &&
    (status.state === "continuation_pending" ||
      status.state === "verification_pending") &&
    status.sessionId === sessionId &&
    status.handoffId === pending.audit.nestedToolCallId &&
    status.arm === "task"
    ? `${text}\n\n${TRAJECTORY_REARM_DIRECTIVE}`
    : text;
};

export const claimFabricHandoff = (
  controller: PrewalkController,
  execution: FabricExecutionResult,
  sessionId: string,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff | undefined => {
  if (execution.handoffRequest) {
    controller.supersedeTask();
    let audit: FabricCallAudit | undefined;
    for (let index = execution.audits.length - 1; index >= 0; index--) {
      const candidate = execution.audits[index];
      if (candidate?.ref === "agents.handoff") {
        audit = candidate;
        break;
      }
    }
    if (!audit) {
      throw new Error("Deferred agents.handoff request has no matching Fabric audit");
    }
    return {
      kind: "explicit",
      args: execution.handoffRequest,
      audit,
      resultFormat,
    };
  }

  const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}prewalk_${randomUUID()}`;
  const verification = controller.observeVerification(
    execution.gates ?? [],
    sessionId,
    nestedToolCallId,
  );
  if (verification?.kind === "revision") {
    const pending = createPrewalkPending({
      arm: verification.arm,
      nestedToolCallId,
      resultFormat,
      triggerRef: `workflow.gate:${verification.gate}`,
      revision: {
        number: verification.revision,
        gate: verification.gate,
        feedback: verification.feedback,
      },
      ...(verification.returnModel ? { returnModel: verification.returnModel } : {}),
      ...(verification.returnThinking ? { returnThinking: verification.returnThinking } : {}),
    });
    execution.audits.push(pending.audit);
    return pending;
  }
  if (verification) return undefined;

  const boundary = execution.prewalkBoundary;
  const claimAudits = boundary
    ? execution.audits.filter(
        (audit) => audit.nestedToolCallId === boundary.nestedToolCallId,
      )
    : execution.audits;
  if (boundary && claimAudits.length !== 1) {
    throw new Error("Research Prewalk boundary has no matching Fabric audit");
  }
  const claim = controller.claim(claimAudits, sessionId, nestedToolCallId);
  if (!claim) return undefined;
  const pending = createPrewalkPending({
    arm: claim.arm,
    nestedToolCallId,
    resultFormat,
    triggerRef: claim.mutation.ref,
  });
  execution.audits.push(pending.audit);
  return pending;
};

// Every mode queues its hidden continuation the same way; only the prompt text
// and the mode label differ.
const queuePrewalkContinuation = (
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  content: string,
  details: Record<string, unknown>,
): void => {
  extension.sendMessage(
    {
      customType: PREWALK_CONTINUE_MESSAGE_TYPE,
      content,
      display: false,
      details: {
        ...details,
        trigger: pending.triggerRef,
        continuationId: pending.audit.nestedToolCallId,
        ...(pending.verificationMode === "gated"
          ? { phase: "verify", revision: pending.revision ?? 0 }
          : {}),
      },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
};

// Ordered prewalk executor selection. Tries the primary route first, then the
// configured fallbackModels in declared order. Each candidate must resolve in
// the model registry (unavailable/auth failures are recorded per candidate);
// a candidate that resolves but has no authentication is also skipped. When
// every route fails the rejection is a typed terminal error the controller
// surfaces as a blocked handoff. Gateway admission pressure (chat_admission_busy)
// is not observable at pick time — it happens at chat time after the switch —
// so admission recovery lives in the agent-run retry/backoff layers instead.
export const selectPrewalkExecutorModel = async (
  candidates: readonly string[],
  deps: {
    requireModel: (candidate: string) => unknown;
    setModel: (model: unknown) => Promise<boolean>;
    onAttempt?: (candidate: string) => void;
  },
): Promise<{ model: string; fallback: boolean; skipped: string[] }> => {
  const skipped: string[] = [];
  for (const candidate of candidates) {
    deps.onAttempt?.(candidate);
    let model: unknown;
    try {
      model = deps.requireModel(candidate);
    } catch (error) {
      skipped.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (await deps.setModel(model)) {
      return { model: candidate, fallback: candidate !== candidates[0], skipped };
    }
    skipped.push(`${candidate}: no authentication`);
  }
  throw new Error(
    `No available prewalk executor from ${candidates.length} configured route(s): ${skipped.join("; ")}`,
  );
};

const runResearchPrewalk = async (
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const primaryModel = String(pending.args.model ?? "");
  const candidates = [...new Set([primaryModel, ...(pending.fallbackModels ?? [])])];
  const { model: modelKey, fallback } = await selectPrewalkExecutorModel(candidates, {
    requireModel: (candidate) => requirePrewalkModel(candidate, context),
    setModel: (model) =>
      extension.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
    onAttempt: (candidate) =>
      context.ui.setStatus("fabric-prewalk", `switching Main → ${candidate}`),
  });
  if (pending.args.thinking) {
    extension.setThinkingLevel(pending.args.thinking as import("../thinking.js").FabricThinking);
  }
  context.ui.notify(
    `Prewalk continuing Main in place with ${modelKey}${fallback ? " (fallback)" : ""}. Previous Main model will be restored after the task.`,
    "info",
  );
  const basePrompt = pending.checklist
    ? checklistContinuationPrompt(pending.checklist)
    : PREWALK_CONTINUE_PROMPT;
  queuePrewalkContinuation(
    extension,
    pending,
    pending.verificationMode === "gated"
      ? `${basePrompt}\n\n${PREWALK_GATED_VERIFY_PROMPT}`
      : basePrompt,
    { mode: "research", model: modelKey, fallback },
  );
  context.ui.setStatus("fabric-prewalk", `continuing Main → ${modelKey}`);
  return {
    prewalk: true,
    mode: "research",
    continued: true,
    status: "continued",
    model: modelKey,
    fallback,
    trigger: { ref: pending.triggerRef },
  };
};

export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
  activity?: (update: FabricInvocationActivityUpdate) => void,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  context.ui.setStatus("fabric-prewalk", "switching Main to " + model);
  // Restore Main after the task unconditionally: the big -> small -> big
  // loop is the design, not a setting. The verification-revision path still
  // overrides this with its own returnModel.
  const returnModel = pending.returnModel ?? (
    context.model
      ? context.model.provider + "/" + context.model.id
      : undefined
  );
  const returnThinking = context.thinkingLevel;
  let handoffError: string | undefined;
  try {
    const result = await runResearchPrewalk(extension, pending, context);
    if (typeof result.model === "string") {
      controller.selectHandoffModel(result.model);
    }
    pending.audit.success = true;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    activity?.({ type: "progress", message: "Main continuing in place with " + model });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handoffError = message;
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus("fabric-prewalk", "prewalk continuation failed");
    return {
      prewalk: true,
      mode: "research",
      trigger: { ref: pending.triggerRef },
      handedOff: false,
      continued: false,
      completed: false,
      status: "failed",
      error: message,
    };
  } finally {
    const status = handoffError
      ? controller.failHandoff(handoffError)
      : controller.completeHandoff(returnModel, returnThinking);
    if (status.state === "armed") {
      context.ui.setStatus("fabric-prewalk", `armed → ${status.model}`);
    } else if (
      status.state === "continuation_pending" ||
      status.state === "verification_pending"
    ) {
      context.ui.setStatus(
        "fabric-prewalk",
        status.state === "verification_pending"
          ? `verification pending → ${status.model}`
          : `continuation pending → ${status.model}`,
      );
    }
  }
};
