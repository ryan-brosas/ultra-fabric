import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  FabricPrewalkMode,
  FabricPrewalkReturnPolicy,
  FabricResultFormat,
} from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type {
  FabricInvocationActivityUpdate,
  FabricInvocationContext,
} from "../protocol.js";
import { snapshotHandoffSession } from "../agents/handoff.js";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../agents/types.js";
import type { PrewalkController } from "./controller.js";
import type { FabricPrewalkChecklist } from "./checklist.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  PREWALK_CONTINUE_MESSAGE_TYPE,
  PREWALK_PLAN_MESSAGE_TYPE,
} from "./continuation.js";
import { requirePrewalkModel } from "./model.js";

export { PREWALK_PLAN_MESSAGE_TYPE, PREWALK_ARMED_MESSAGE_TYPE } from "./continuation.js";

const PREWALK_CONTINUE_PROMPT = [
  "Continue the existing task in this same session under the new executor model.",
  "Do not stop merely because the model changed or because the first mutation succeeded.",
  "Finish the remaining implementation, check matching call sites for consistency, and run the relevant verification before reporting completion.",
].join(" ");

const checklistContinuationPrompt = (checklist: FabricPrewalkChecklist): string => [
  "Continue the existing implementation in this same session under the executor model. The first mutation already succeeded.",
  "Keep this host-accepted checklist active until every remaining item and validation is complete:",
  ...checklist.items.map(
    (item, index) => `${index + 1}. ${item.task}\n   Validation: ${item.validation}`,
  ),
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

const PREWALK_TRAJECTORY_VERIFY_PROMPT = [
  "Prewalk trajectory handoff complete: the executor's implementation above is final — do not redo it.",
  "Continue now: run the relevant verification (matching test module, build, or an equivalent probe) and check the changed call sites for consistency, then summarize what the executor implemented and how the checks went.",
  "If a check fails, fix only the failing part; keep the fix scoped. If this verification already happened in this turn, respond with the summary only.",
].join(" ");

// Arm-time framing is LLM-visible, TUI-hidden, and does not fire an
// input event. Research framing has a distinct custom type so its plan
// message is identifiable; the context hook removes both framing types
// before the executor's first inference.
export const prewalkArmedMessageType = (mode: FabricPrewalkMode): string =>
  mode === "research" ? PREWALK_PLAN_MESSAGE_TYPE : PREWALK_ARMED_MESSAGE_TYPE;

const researchArmedPrompt = (model: string): string => [
  `Prewalk armed → ${model} (research).`,
  "Before any further mutation, commit to a deep, concrete remaining execution plan grounded in the context already gathered. Cover the target files or symbols, dependencies, edge cases, and proof needed for completion.",
  "In that same assistant reply, call prewalk.checklist({ items }) inside fabric_exec with 5-9 ordered items. Every item must have a concrete task and a specific validation. The host rejects mutation until this checklist is accepted.",
  "After acceptance, continue the task immediately and make exactly one first successful mutation through a configured Prewalk trigger. Do not stop at the plan. Do not batch or start another mutation concurrently; the host ends fabric_exec immediately after that first successful mutation and switches this session to the executor model.",
  "The executor owns the remaining implementation and verification through completion.",
].join("\n");

export const prewalkArmedPrompt = (mode: FabricPrewalkMode, model: string): string =>
  mode === "research"
    ? researchArmedPrompt(model)
    : [
        `Prewalk armed → ${model} (${mode}): the first successful configured write effect inside fabric_exec (by default pi.edit / pi.write / schema.commit or any declared workspace-effect action) hands off to the executor automatically; ${
          mode === "trajectory"
            ? "the executor takes over the implementation there, and a hidden follow-up asks you to verify its work and summarize when it finishes."
            : `this session switches to ${model} and keeps working.`
        }`,
        "Before your first edit, commit to the remaining execution plan as a host-accepted prewalk.checklist({ items }) call inside fabric_exec with 5-9 ordered items. Every item must have a concrete task and a specific validation. Only steps that change or verify code belong on the list — no reporting, bookkeeping, cleanup-ceremony, or release-note items. The checklist serves the task, never the reverse: when reality disagrees with an item, fix the actual problem rather than working the checklist. Reads never fire it.",
      ].join("\n");

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

export interface BoundaryHandoffRunner {
  executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>>;
}

export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk-in-place" | "prewalk-trajectory" | "prewalk-research";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  returnPolicy?: FabricPrewalkReturnPolicy;
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
  const research = input.arm.mode === "research";
  const inPlace = input.arm.mode !== "trajectory";
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
    name: research
      ? "Research Prewalk executor"
      : inPlace
        ? "In-place Prewalk"
        : "Prewalk trajectory executor",
    ...(revisionTask ? { task: revisionTask } : {}),
    ...(!inPlace && !input.revision && input.arm.checklist
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
    ...(!inPlace && input.arm.thinking ? { thinking: input.arm.thinking } : {}),
  };
  const audit: FabricCallAudit = {
    ref: inPlace ? "fabric.prewalk" : "agents.handoff",
    nestedToolCallId: input.nestedToolCallId,
    startedAt: Date.now(),
    tool: inPlace ? "prewalk" : "handoff",
    provider: inPlace ? "fabric" : "agents",
    args,
  };
  return {
    kind: research
      ? "prewalk-research"
      : inPlace
        ? "prewalk-in-place"
        : "prewalk-trajectory",
    args,
    audit,
    resultFormat: input.resultFormat,
    returnPolicy: input.arm.returnPolicy,
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
  return pending.kind === "prewalk-trajectory" &&
    handoff.completed === true &&
    (status.state === "continuation_pending" ||
      status.state === "verification_pending") &&
    status.sessionId === sessionId &&
    status.handoffId === pending.audit.nestedToolCallId &&
    status.alwaysRearm
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

const runInPlacePrewalk = async (
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const primaryModel = String(pending.args.model ?? "");
  const candidates = [...new Set([primaryModel, ...(pending.fallbackModels ?? [])])];
  const failures: string[] = [];
  let modelKey: string | undefined;
  for (const candidate of candidates) {
    context.ui.setStatus("fabric-prewalk", `switching Main → ${candidate}`);
    try {
      const model = requirePrewalkModel(candidate, context);
      if (await extension.setModel(model)) {
        modelKey = candidate;
        break;
      }
      failures.push(`${candidate}: no authentication`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!modelKey) {
    throw new Error(
      `No available prewalk executor from ${candidates.length} configured route(s): ${failures.join("; ")}`,
    );
  }
  const fallback = modelKey !== primaryModel;
  context.ui.notify(
    pending.returnPolicy === "previous"
      ? `Prewalk continuing Main in place with ${modelKey}${fallback ? " (fallback)" : ""}. Previous Main model will be restored after the task.`
      : `Prewalk continuing Main in place with ${modelKey}${fallback ? " (fallback)" : ""}. Pi will retain this model after the task.`,
    "info",
  );
  const mode = pending.kind === "prewalk-research" ? "research" : "in-place";
  const basePrompt = pending.checklist
    ? checklistContinuationPrompt(pending.checklist)
    : PREWALK_CONTINUE_PROMPT;
  extension.sendMessage(
    {
      customType: PREWALK_CONTINUE_MESSAGE_TYPE,
      content: pending.verificationMode === "gated"
        ? basePrompt + "\n\n" + PREWALK_GATED_VERIFY_PROMPT
        : basePrompt,
      display: false,
      details: {
        mode,
        model: modelKey,
        fallback,
        trigger: pending.triggerRef,
        continuationId: pending.audit.nestedToolCallId,
        ...(pending.verificationMode === "gated"
          ? { phase: "verify", revision: pending.revision ?? 0 }
          : {}),
      },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
  context.ui.setStatus("fabric-prewalk", `continuing Main → ${modelKey}`);
  return {
    prewalk: true,
    mode,
    continued: true,
    status: "continued",
    model: modelKey,
    fallback,
    trigger: { ref: pending.triggerRef },
  };
};

export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  runner: BoundaryHandoffRunner,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  outerToolResult: AgentToolResultMessage,
  context: ExtensionContext,
  activity?: (update: FabricInvocationActivityUpdate) => void,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  const inPlace =
    pending.kind === "prewalk-in-place" || pending.kind === "prewalk-research";
  const prewalkMode = pending.kind === "prewalk-research"
    ? "research"
    : inPlace
      ? "in-place"
      : "trajectory";
  context.ui.setStatus(
    "fabric-prewalk",
    inPlace ? `switching Main → ${model}` : `handing off trajectory → ${model}`,
  );
  const returnModel = pending.returnModel ?? (
    pending.kind === "prewalk-in-place" &&
    pending.returnPolicy === "previous" &&
    context.model
      ? `${context.model.provider}/${context.model.id}`
      : undefined
  );
  let handoffError: string | undefined;
  let continuationError: string | undefined;
  try {
    if (inPlace) {
      const result = await runInPlacePrewalk(extension, pending, context);
      if (typeof result.model === "string") {
        controller.selectHandoffModel(result.model);
      }
      pending.audit.success = true;
      pending.audit.result = result;
      pending.audit.endedAt = Date.now();
      activity?.({ type: "progress", message: `Main continuing in place with ${model}` });
      return result;
    }

    const seed = snapshotHandoffSession(
      context.sessionManager,
      context.model,
      outerToolResult,
      outerToolResult.toolCallId,
    );
    const invocation: FabricInvocationContext = {
      cwd: context.cwd,
      signal: context.signal,
      parentToolCallId: outerToolResult.toolCallId,
      nestedToolCallId: pending.audit.nestedToolCallId,
      extensionContext: context,
      update(message) {
        context.ui.setStatus("fabric-prewalk", message);
        activity?.({ type: "progress", message });
      },
      ...(activity ? { activity } : {}),
      attachPreview(preview) {
        pending.audit.preview = preview;
      },
    };
    const result = await runner.executeHandoff(pending.args, invocation, seed);
    const completed = result.completed === true;
    if (!completed) {
      handoffError =
        typeof result.error === "string" && result.error.trim()
          ? result.error.trim()
          : `Prewalk trajectory ${String(result.status ?? "failed")}`;
    }
    pending.audit.success = completed;
    if (handoffError) pending.audit.error = handoffError;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    if (pending.kind === "prewalk-trajectory" && completed) {
      // Main is never left idle after a delegated implementation: queue a
      // hidden verify-and-summarize continuation the same way in-place does.
      // Best-effort — the executor's completed result stays authoritative.
      try {
        extension.sendMessage(
          {
            customType: PREWALK_CONTINUE_MESSAGE_TYPE,
            content: pending.verificationMode === "gated"
              ? PREWALK_GATED_VERIFY_PROMPT
              : PREWALK_TRAJECTORY_VERIFY_PROMPT,
            display: false,
            details: {
              mode: "trajectory",
              model,
              trigger: pending.triggerRef,
              continuationId: pending.audit.nestedToolCallId,
              ...(pending.verificationMode === "gated"
                ? { phase: "verify", revision: pending.revision ?? 0 }
                : {}),
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch (error) {
        continuationError = error instanceof Error ? error.message : String(error);
        handoffError = `Prewalk continuation delivery failed: ${continuationError}`;
      }
    }
    context.ui.setStatus(
      "fabric-prewalk",
      completed
        ? continuationError
          ? "trajectory implemented; continuation delivery failed"
          : "trajectory executor implemented"
        : `trajectory ${String(result.status ?? "failed")}`,
    );
    return {
      ...(pending.kind === "prewalk-trajectory"
        ? { prewalk: true, mode: "trajectory", trigger: { ref: pending.triggerRef } }
        : {}),
      ...result,
      ...(continuationError
        ? { continuationQueued: false, continuationError }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handoffError = message;
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus("fabric-prewalk", inPlace ? "in-place continuation failed" : "trajectory handoff failed");
    return {
      ...(pending.kind.startsWith("prewalk-")
        ? {
            prewalk: true,
            mode: prewalkMode,
            trigger: { ref: pending.triggerRef },
          }
        : {}),
      handedOff: false,
      continued: false,
      completed: false,
      status: "failed",
      error: message,
    };
  } finally {
    const status = handoffError
      ? controller.failHandoff(handoffError)
      : controller.completeHandoff(returnModel);
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
