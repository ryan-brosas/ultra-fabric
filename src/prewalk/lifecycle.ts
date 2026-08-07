import type { FabricThinking } from "../thinking.js";
import type { FabricPrewalkChecklist } from "./checklist.js";

export interface FabricPrewalkArm {
  model: string;
  sessionId: string;
  armedAt: number;
  // Consolidated arming mode: "off" (explicit only), "session" (arm once),
  // "task" (re-arm after each settled task). Former alwaysRearm/autoArm pair.
  arm: "off" | "session" | "task";
  fallbackModels?: string[];
  task?: string;
  checklist?: FabricPrewalkChecklist;
  thinking?: FabricThinking;
  verificationMode?: "gated";
  maxPhaseRevisions?: number;
}

export interface FabricPrewalkRearmDefaults {
  model?: string;
  arm: "off" | "session" | "task";
  fallbackModels?: string[];
  thinking?: FabricThinking;
  verificationMode?: "gated";
  maxPhaseRevisions?: number;
}

interface FabricPrewalkPhaseState {
  revision?: number;
  revisionGate?: string;
  revisionFeedback?: string;
}

export type FabricPrewalkArmedStatus =
  { state: "armed" } & FabricPrewalkArm & FabricPrewalkPhaseState & { attempt: number };

export type FabricPrewalkHandoffStatus =
  { state: "handing_off" } & FabricPrewalkArm & {
    attempt: number;
    handoffId: string;
  } & FabricPrewalkPhaseState;

type FabricPrewalkContinuationStatus =
  {
    state:
      | "continuation_pending"
      | "continuing"
      | "verification_pending"
      | "verifying";
  } & FabricPrewalkArm & FabricPrewalkPhaseState & {
    attempt: number;
    handoffId: string;
    returnModel?: string;
    returnThinking?: string;
    verificationGate?: string;
  };

type FabricPrewalkBlockedStatus =
  { state: "blocked" } & FabricPrewalkArm & {
    attempt: number;
    handoffId: string;
    blockedAt: number;
    error: string;
    // A blocked task already switched Main to the executor, so it still owes a
    // restore. The reducer carries this through both blocked paths.
    returnModel?: string;
    returnThinking?: string;
  } & FabricPrewalkPhaseState;

export type FabricPrewalkStatus =
  | { state: "idle" }
  | FabricPrewalkArmedStatus
  | FabricPrewalkHandoffStatus
  | FabricPrewalkContinuationStatus
  | FabricPrewalkBlockedStatus;

export type FabricPrewalkEvent =
  | { kind: "armed"; arm: FabricPrewalkArm }
  | { kind: "task_observed"; sessionId: string; task: string }
  | { kind: "checklist_ready"; sessionId: string; checklist: FabricPrewalkChecklist }
  | {
      kind: "task_settled";
      sessionId: string;
      at: number;
      rearm?: FabricPrewalkRearmDefaults;
    }
  | { kind: "handoff_claimed"; sessionId: string; handoffId: string }
  | { kind: "executor_selected"; model: string }
  | { kind: "task_superseded"; at: number; rearm?: FabricPrewalkRearmDefaults }
  | {
      kind: "handoff_succeeded";
      at: number;
      handoffId: string;
      returnModel?: string;
      returnThinking?: string;
    }
  | { kind: "continuation_accepted"; sessionId: string; handoffId: string }
  | {
      kind: "continuation_settled";
      sessionId: string;
      at: number;
      rearm?: FabricPrewalkRearmDefaults;
    }
  | {
      kind: "verification_revision";
      sessionId: string;
      at: number;
      gate: string;
      feedback: string;
    }
  | { kind: "verification_passed"; sessionId: string; gate: string }
  | { kind: "verification_failed"; sessionId: string; at: number; error: string }
  | { kind: "handoff_failed"; at: number; error: string }
  | { kind: "retry_requested"; sessionId: string; at: number }
  | { kind: "cancelled" };

type ActivePrewalkStatus = Exclude<FabricPrewalkStatus, { state: "idle" }>;

const toArmed = (
  status: ActivePrewalkStatus,
  armedAt: number,
  options: { preserveTask: boolean; attempt: number },
): FabricPrewalkArmedStatus => ({
  state: "armed",
  model: status.model,
  sessionId: status.sessionId,
  armedAt,
  arm: status.arm,
  ...(status.fallbackModels ? { fallbackModels: [...status.fallbackModels] } : {}),
  attempt: options.attempt,
  ...(options.preserveTask && status.task ? { task: status.task } : {}),
  ...(options.preserveTask && status.checklist
    ? { checklist: structuredClone(status.checklist) }
    : {}),
  ...(status.thinking ? { thinking: status.thinking } : {}),
  ...(status.verificationMode ? { verificationMode: status.verificationMode } : {}),
  ...(status.maxPhaseRevisions !== undefined
    ? { maxPhaseRevisions: status.maxPhaseRevisions }
    : {}),
  ...(status.revision !== undefined ? { revision: status.revision } : {}),
  ...(status.revisionGate ? { revisionGate: status.revisionGate } : {}),
  ...(status.revisionFeedback ? { revisionFeedback: status.revisionFeedback } : {}),
});

// A re-arm must adopt the configuration in force now, not clone the arm that
// just finished. Without this a mode or model change never takes effect while
// always-rearm keeps carrying the original arm forward.
const applyRearm = (
  armed: FabricPrewalkArmedStatus,
  rearm: FabricPrewalkRearmDefaults,
): FabricPrewalkArmedStatus => ({
  state: "armed",
  model: rearm.model ?? armed.model,
  sessionId: armed.sessionId,
  armedAt: armed.armedAt,
  arm: rearm.arm,
  attempt: armed.attempt,
  ...(rearm.fallbackModels && rearm.fallbackModels.length > 0
    ? { fallbackModels: [...rearm.fallbackModels] }
    : {}),
  ...(rearm.thinking ? { thinking: rearm.thinking } : {}),
  ...(rearm.verificationMode ? { verificationMode: rearm.verificationMode } : {}),
  ...(rearm.maxPhaseRevisions !== undefined
    ? { maxPhaseRevisions: rearm.maxPhaseRevisions }
    : {}),
});

const finish = (
  status: ActivePrewalkStatus,
  at: number,
  rearm?: FabricPrewalkRearmDefaults,
): FabricPrewalkStatus => {
  // Both "session" and "task" keep the gate armed after a settled task. A
  // session-scoped arm must survive its first executor run so later tasks in
  // the same session stay gated without an explicit /fabric prewalk; only
  // "off" (explicit arming) drops to idle.
  const rearmOnSettle = rearm ? rearm.arm !== "off" : status.arm !== "off";
  if (!rearmOnSettle) return { state: "idle" };
  const armed = toArmed(status, at, { preserveTask: false, attempt: 0 });
  return rearm ? applyRearm(armed, rearm) : armed;
};

export const reducePrewalkLifecycle = (
  status: FabricPrewalkStatus,
  event: FabricPrewalkEvent,
): FabricPrewalkStatus => {
  switch (event.kind) {
    case "armed":
      return {
        state: "armed",
        ...event.arm,
        attempt: 0,
        ...(event.arm.verificationMode === "gated" ? { revision: 0 } : {}),
      };
    case "task_observed":
      return status.state === "armed" &&
        status.sessionId === event.sessionId &&
        !status.task
        ? { ...status, task: event.task }
        : status;
    case "checklist_ready":
      return status.state === "armed" &&
        status.sessionId === event.sessionId
        ? { ...status, checklist: structuredClone(event.checklist) }
        : status;
    case "task_settled":
      if (
        status.state !== "armed" ||
        status.sessionId !== event.sessionId ||
        !status.task
      ) {
        return status;
      }
      // A single turn may arm prewalk and then settle without firing (for
      // example, the first reply only investigates). Keep that one-shot arm
      // alive so the next mutation can still hand off; only re-arming configs
      // finish here, which clears the task so it rebinds to the next message.
      const rearmOnSettle = event.rearm
        ? event.rearm.arm === "task"
        : status.arm === "task";
      return rearmOnSettle
        ? finish(status, event.at, event.rearm)
        : status;
    case "handoff_claimed":
      return status.state === "armed" && status.sessionId === event.sessionId
        ? {
            ...status,
            state: "handing_off",
            attempt: status.attempt + 1,
            handoffId: event.handoffId,
          }
        : status;
    case "executor_selected":
      return status.state === "handing_off"
        ? { ...status, model: event.model }
        : status;
    case "task_superseded":
      return status.state === "idle" ? status : finish(status, event.at, event.rearm);
    case "handoff_succeeded":
      return status.state === "handing_off" && status.handoffId === event.handoffId
        ? {
            ...status,
            state: status.verificationMode === "gated"
              ? "verification_pending"
              : "continuation_pending",
            ...(event.returnModel ? { returnModel: event.returnModel } : {}),
        ...(event.returnThinking ? { returnThinking: event.returnThinking } : {}),
          }
        : status;
    case "continuation_accepted":
      if (
        (status.state !== "continuation_pending" &&
          status.state !== "continuing" &&
          status.state !== "verification_pending" &&
          status.state !== "verifying") ||
        status.sessionId !== event.sessionId ||
        status.handoffId !== event.handoffId
      ) {
        return status;
      }
      if (status.state === "continuing" || status.state === "verifying") return status;
      return {
        ...status,
        state: status.state === "verification_pending" ? "verifying" : "continuing",
      };
    case "continuation_settled":
      if (status.state === "idle" || status.sessionId !== event.sessionId) return status;
      if (status.state === "continuing") return finish(status, event.at, event.rearm);
      if (status.state === "verifying") {
        return {
          ...status,
          state: "blocked",
          blockedAt: event.at,
          error: "Prewalk verification settled without acceptance evidence",
        };
      }
      return status;
    case "verification_revision": {
      if (status.state !== "verifying" || status.sessionId !== event.sessionId) return status;
      const revision = status.revision ?? 0;
      const maxRevisions = status.maxPhaseRevisions ?? 0;
      if (revision >= maxRevisions) {
        return {
          ...status,
          state: "blocked",
          blockedAt: event.at,
          error: `Prewalk verification revision limit exhausted (${maxRevisions})`,
        };
      }
      return {
        ...toArmed(status, event.at, {
          preserveTask: true,
          attempt: status.attempt,
        }),
        revision: revision + 1,
        revisionGate: event.gate,
        revisionFeedback: event.feedback,
      };
    }
    case "verification_passed":
      return status.state === "verifying" && status.sessionId === event.sessionId
        ? { ...status, state: "continuing", verificationGate: event.gate }
        : status;
    case "verification_failed":
      return status.state === "verifying" && status.sessionId === event.sessionId
        ? {
            ...status,
            state: "blocked",
            blockedAt: event.at,
            error: event.error,
          }
        : status;
    case "handoff_failed":
      return status.state === "handing_off"
        ? {
            ...status,
            state: "blocked",
            blockedAt: event.at,
            error: event.error,
          }
        : status;
    case "retry_requested":
      return status.state === "blocked" && status.sessionId === event.sessionId
        ? toArmed(status, event.at, {
            preserveTask: true,
            attempt: status.attempt,
          })
        : status;
    case "cancelled":
      return { state: "idle" };
  }
};
