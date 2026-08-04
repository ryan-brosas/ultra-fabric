import type { FabricCallAudit } from "../core/action-registry.js";
import type { FabricEffect, FabricRisk } from "../protocol.js";
import type { FabricGateResult } from "../run/context.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import {
  parsePrewalkChecklist,
  type FabricPrewalkChecklist,
} from "./checklist.js";
import {
  reducePrewalkLifecycle,
  type FabricPrewalkArm,
  type FabricPrewalkArmedStatus,
  type FabricPrewalkEvent,
  type FabricPrewalkRearmDefaults,
  type FabricPrewalkStatus,
} from "./lifecycle.js";

export type { FabricPrewalkStatus } from "./lifecycle.js";

const PREWALK_TRIGGER_REFS = new Set([
  "pi.edit",
  "pi.write",
  "schema.commit",
]);

export interface FabricPrewalkClaim {
  arm: FabricPrewalkArm;
  mutation: FabricCallAudit;
}

interface FabricPrewalkBoundaryAction {
  ref: string;
  risk?: FabricRisk;
  effect?: FabricEffect;
}

export interface FabricPrewalkExecutionBoundary {
  registerChecklist(input: unknown): FabricPrewalkChecklist;
  authorize(action: FabricPrewalkBoundaryAction): boolean;
  settle(reservation: boolean, audit: FabricCallAudit): boolean;
  release(reservation: boolean): void;
}

const normalizedFallbackModels = (
  values: readonly string[] | undefined,
  primary: string,
): string[] =>
  [...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter((value) => /^[^/\s]+\/\S+$/.test(value) && value !== primary),
  )].slice(0, 8);

const normalizedTask = (value: string | undefined): string | undefined => {
  const task = value?.trim();
  return task ? task.slice(0, 20_000) : undefined;
};

const armFromStatus = (
  status: Exclude<FabricPrewalkStatus, { state: "idle" }>,
): FabricPrewalkArm => ({
  model: status.model,
  sessionId: status.sessionId,
  armedAt: status.armedAt,
  alwaysRearm: status.alwaysRearm,
  ...(status.fallbackModels ? { fallbackModels: [...status.fallbackModels] } : {}),
  ...(status.task ? { task: status.task } : {}),
  ...(status.checklist ? { checklist: structuredClone(status.checklist) } : {}),
  ...(status.thinking ? { thinking: status.thinking } : {}),
  ...(status.verificationMode ? { verificationMode: status.verificationMode } : {}),
  ...(status.maxPhaseRevisions !== undefined
    ? { maxPhaseRevisions: status.maxPhaseRevisions }
    : {}),
});

export type FabricPrewalkVerificationDecision =
  | { kind: "passed"; gate: string }
  | {
      kind: "revision";
      arm: FabricPrewalkArm;
      gate: string;
      feedback: string;
      revision: number;
      returnModel?: string;
    }
  | { kind: "blocked"; gate: string; error: string };

const effectiveVerificationGates = (
  gates: readonly FabricGateResult[],
): FabricGateResult[] => {
  const latest = new Map<string, FabricGateResult>();
  for (const gate of gates) latest.set(gate.gate, gate);
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
};

const gateFeedback = (gate: FabricGateResult): string =>
  gate.reason?.trim() ||
  gate.error?.trim() ||
  gate.evidence.map((evidence) => `${evidence.kind}:${evidence.ref}`).join(", ") ||
  `Verification gate ${gate.gate} requires revision`;

// A successful call that left the workspace untouched is not a mutation and
// must not own the handoff boundary. Absent signals fail open, so an unknown
// result shape still counts as a real mutation.
const isNoOpMutation = (audit: FabricCallAudit): boolean => {
  const result = audit.result;
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  if (record.changed === false) return true;
  return record.diff === "" && record.patch === "";
};

export class PrewalkController {
  #status: FabricPrewalkStatus = { state: "idle" };
  #triggerRefs = new Set(PREWALK_TRIGGER_REFS);
  #triggerRisks = new Set<FabricRisk>();
  #triggerEffects = new Set<FabricEffect>(["workspace"]);
  #researchMutationReserved = false;
  // Per-continuation bound on the checklist reminder so it steers a drifting
  // executor without keeping Main working after the checklist is satisfied.
  // The count is scoped to the live handoff so a new continuation starts fresh.
  #reminderCount = 0;
  #reminderHandoffId: string | undefined;
  static #REMINDER_LIMIT = 3;

  configureTriggers(
    risks: readonly FabricRisk[],
    refs: readonly string[],
    effects: readonly FabricEffect[] = [],
  ): void {
    this.#triggerRisks = new Set(risks);
    this.#triggerRefs = new Set(refs);
    this.#triggerEffects = new Set(effects);
  }

  status(): FabricPrewalkStatus {
    return structuredClone(this.#status);
  }

  #matchesTrigger(action: FabricPrewalkBoundaryAction): boolean {
    return (
      this.#triggerRefs.has(action.ref) ||
      (action.risk !== undefined && this.#triggerRisks.has(action.risk)) ||
      (action.effect !== undefined && this.#triggerEffects.has(action.effect))
    );
  }

  #researchStatus(sessionId: string): FabricPrewalkArmedStatus | undefined {
    return this.#status.state === "armed" &&
      this.#status.sessionId === sessionId
      ? this.#status
      : undefined;
  }

  // Every armed mode may record a checklist so the executor inherits the plan
  // and its validations. Only research reserves the mutation, because that
  // reservation ends fabric_exec at the first write.
  executionBoundary(sessionId: string): FabricPrewalkExecutionBoundary | undefined {
    if (!this.isArmed(sessionId)) return undefined;
    return {
      registerChecklist: (input) => {
        if (!this.isArmed(sessionId)) {
          throw new Error("Prewalk is no longer armed for this session");
        }
        const checklist = parsePrewalkChecklist(input);
        this.#transition({ kind: "checklist_ready", sessionId, checklist });
        return checklist;
      },
      authorize: (action) => {
        const status = this.#researchStatus(sessionId);
        if (!status || !this.#matchesTrigger(action)) return false;
        if (!status.checklist) {
          throw new Error(
            "Research Prewalk requires prewalk.checklist with 5-9 validated items before the first mutation",
          );
        }
        if (this.#researchMutationReserved) {
          throw new Error("Research Prewalk first mutation is already in flight");
        }
        this.#researchMutationReserved = true;
        return true;
      },
      settle: (reservation, audit) => {
        if (!reservation) return false;
        if (audit.success === true && this.#matchesTrigger(audit) && !isNoOpMutation(audit)) return true;
        this.#researchMutationReserved = false;
        return false;
      },
      release: (reservation) => {
        if (reservation) this.#researchMutationReserved = false;
      },
    };
  }

  #transition(event: FabricPrewalkEvent): FabricPrewalkStatus {
    this.#status = reducePrewalkLifecycle(this.#status, event);
    return this.status();
  }

  arm(input: {
    model: string;
    sessionId: string;
    task?: string;
    alwaysRearm?: boolean;
    fallbackModels?: string[];
    thinking?: FabricThinking;
    verificationMode?: "gated";
    maxPhaseRevisions?: number;
  }): FabricPrewalkStatus {
    const model = input.model.trim();
    if (!model.includes("/")) throw new Error("Prewalk requires a provider/model executor target");
    if (input.thinking !== undefined && !isFabricThinking(input.thinking)) {
      throw new Error(`Invalid prewalk thinking level: ${String(input.thinking)}`);
    }
    const task = normalizedTask(input.task);
    const fallbackModels = normalizedFallbackModels(input.fallbackModels, model);
    this.#researchMutationReserved = false;
    return this.#transition({
      kind: "armed",
      arm: {
        model,
        sessionId: input.sessionId,
        armedAt: Date.now(),
        alwaysRearm: input.alwaysRearm === true,
        ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
        ...(task ? { task } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.verificationMode === "gated"
          ? {
              verificationMode: "gated" as const,
              maxPhaseRevisions: Math.max(
                0,
                Math.min(8, Math.floor(input.maxPhaseRevisions ?? 2)),
              ),
            }
          : {}),
      },
    });
  }

  observeTask(sessionId: string, task: string): FabricPrewalkStatus {
    const normalized = normalizedTask(task);
    return normalized
      ? this.#transition({ kind: "task_observed", sessionId, task: normalized })
      : this.status();
  }

  isArmed(sessionId?: string): boolean {
    return (
      this.#status.state === "armed" &&
      (sessionId === undefined || this.#status.sessionId === sessionId)
    );
  }

  // The executor is steered every turn from the live checklist, not once at the
  // boundary, so a long continuation cannot drift away from its own plan. The
  // reminder is bounded per continuation: after the limit it stops firing, so
  // Main is not held working and replaying a growing context once the checklist
  // is satisfied. The bound is scoped to the live handoff and resets on a new
  // continuation, so a re-arm gets a fresh budget.
  claimChecklistReminder(
    sessionId: string,
  ): FabricPrewalkChecklist | undefined {
    const status = this.#status;
    if (status.state !== "continuing" && status.state !== "verifying") {
      this.#reminderCount = 0;
      this.#reminderHandoffId = undefined;
      return undefined;
    }
    if (status.sessionId !== sessionId || !status.checklist) return undefined;
    if (status.handoffId !== this.#reminderHandoffId) {
      this.#reminderCount = 0;
      this.#reminderHandoffId = status.handoffId;
    }
    if (this.#reminderCount >= PrewalkController.#REMINDER_LIMIT) return undefined;
    this.#reminderCount += 1;
    return structuredClone(status.checklist);
  }

  settleTask(sessionId: string, rearm?: FabricPrewalkRearmDefaults): boolean {
    const previous = this.#status;
    this.#transition({
      kind: "task_settled",
      sessionId,
      at: Date.now(),
      ...(rearm ? { rearm } : {}),
    });
    return previous !== this.#status;
  }

  supersedeTask(rearm?: FabricPrewalkRearmDefaults): FabricPrewalkStatus {
    return this.#transition({
      kind: "task_superseded",
      at: Date.now(),
      ...(rearm ? { rearm } : {}),
    });
  }

  selectHandoffModel(model: string): FabricPrewalkStatus {
    return this.#transition({ kind: "executor_selected", model });
  }

  completeHandoff(returnModel?: string): FabricPrewalkStatus {
    if (this.#status.state !== "handing_off") return this.status();
    return this.#transition({
      kind: "handoff_succeeded",
      at: Date.now(),
      handoffId: this.#status.handoffId,
      ...(returnModel ? { returnModel } : {}),
    });
  }

  acceptContinuation(sessionId: string, handoffId: string): boolean {
    this.#transition({ kind: "continuation_accepted", sessionId, handoffId });
    return (
      (this.#status.state === "continuing" || this.#status.state === "verifying") &&
      this.#status.sessionId === sessionId &&
      this.#status.handoffId === handoffId
    );
  }

  settleContinuation(
    sessionId: string,
    rearm?: FabricPrewalkRearmDefaults,
  ): {
    settled: boolean;
    status: FabricPrewalkStatus;
    returnModel?: string;
  } {
    const previous = this.#status;
    const returnModel =
      previous.state === "continuing" && previous.sessionId === sessionId
        ? previous.returnModel
        : undefined;
    const status = this.#transition({
      kind: "continuation_settled",
      sessionId,
      at: Date.now(),
      ...(rearm ? { rearm } : {}),
    });
    return {
      settled: previous !== this.#status,
      status,
      ...(returnModel ? { returnModel } : {}),
    };
  }

  observeVerification(
    gates: readonly FabricGateResult[],
    sessionId: string,
    handoffId: string,
  ): FabricPrewalkVerificationDecision | undefined {
    if (
      this.#status.state !== "verifying" ||
      this.#status.sessionId !== sessionId ||
      this.#status.verificationMode !== "gated"
    ) {
      return undefined;
    }
    const effective = effectiveVerificationGates(gates);
    const terminal = [...effective].reverse().find((gate) => gate.decision === "abort");
    if (terminal) {
      const error = gateFeedback(terminal);
      this.#transition({ kind: "verification_failed", sessionId, at: Date.now(), error });
      return { kind: "blocked", gate: terminal.gate, error };
    }
    const revision = [...effective].reverse().find((gate) => gate.decision === "revise");
    if (revision) {
      const returnModel = this.#status.returnModel;
      const feedback = gateFeedback(revision).slice(0, 4_096);
      const next = this.#transition({
        kind: "verification_revision",
        sessionId,
        at: Date.now(),
        gate: revision.gate,
        feedback,
      });
      if (next.state === "blocked") {
        return { kind: "blocked", gate: revision.gate, error: next.error };
      }
      if (next.state !== "armed") return undefined;
      const arm = armFromStatus(next);
      this.#transition({ kind: "handoff_claimed", sessionId, handoffId });
      return {
        kind: "revision",
        arm,
        gate: revision.gate,
        feedback,
        revision: next.revision ?? 0,
        ...(returnModel ? { returnModel } : {}),
      };
    }
    const passed = [...effective].reverse().find(
      (gate) => gate.passed && gate.decision === "continue",
    );
    if (!passed) return undefined;
    this.#transition({ kind: "verification_passed", sessionId, gate: passed.gate });
    return { kind: "passed", gate: passed.gate };
  }

  failHandoff(error: string): FabricPrewalkStatus {
    return this.#transition({
      kind: "handoff_failed",
      at: Date.now(),
      error: error.trim().slice(0, 20_000) || "Prewalk handoff failed",
    });
  }

  retry(sessionId: string): FabricPrewalkStatus {
    return this.#transition({ kind: "retry_requested", sessionId, at: Date.now() });
  }

  claim(
    audits: FabricCallAudit[],
    sessionId: string,
    handoffId?: string,
  ): FabricPrewalkClaim | undefined {
    if (!this.isArmed(sessionId) || this.#status.state !== "armed") return undefined;
    if (audits.some((audit) => audit.ref === "agents.handoff" && audit.success === true)) {
      this.supersedeTask();
      return undefined;
    }
    const mutation = audits.find(
      (audit) =>
        audit.success === true && this.#matchesTrigger(audit) && !isNoOpMutation(audit),
    );
    if (!mutation) return undefined;
    const arm = armFromStatus(this.#status);
    this.#transition({
      kind: "handoff_claimed",
      sessionId,
      handoffId: handoffId ?? mutation.nestedToolCallId,
    });
    this.#researchMutationReserved = false;
    return { arm, mutation };
  }

  cancel(): void {
    this.#researchMutationReserved = false;
    this.#transition({ kind: "cancelled" });
  }
}
