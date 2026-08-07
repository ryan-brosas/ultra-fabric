import path from "node:path";
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
  path?: string;
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
  arm: status.arm,
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
      returnThinking?: string;
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
  // True when a trigger-matched mutation was attempted (or rejected) since the
  // last continuation reminder injection. Read-only turns never set it, so the
  // checklist refreshes only on turns where the executor actually worked.
  #mutationSinceReminder = false;
  readonly #writeScopes = new Map<string, Set<string>>();
  // Handoffs whose returnModel has already been surrendered. A blocked task
  // persists across turns, so without this the restore would re-fire on every
  // settle and fight a manual model change.
  readonly #consumedReturnModels = new Set<string>();
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
    // Available for the whole active lifecycle (armed, continuing, verifying):
    // authorize only reserves the first mutation while armed, but the boundary
    // still observes trigger-matched mutation attempts so the continuation
    // reminder refreshes on the turns where the executor actually worked.
    if (this.#status.state === "idle" || this.#status.sessionId !== sessionId) {
      return undefined;
    }
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
        if (!this.#matchesTrigger(action)) return false;
        // Any trigger-matched mutation attempt counts as activity for the
        // continuation reminder — accepted or rejected, and even after the
        // armed boundary has long passed (the gate only reserves the first
        // mutation; later turns keep working from the live checklist).
        if (this.#status.state !== "idle" && this.#status.sessionId === sessionId) {
          this.#mutationSinceReminder = true;
        }
        if (!status) return false;
        if (!status.checklist) {
          throw new Error(
            "Research Prewalk requires prewalk.checklist with 5-9 validated items before the first mutation",
          );
        }
        if (this.#researchMutationReserved) {
          throw new Error("Research Prewalk first mutation is already in flight");
        }
        this.#enforceWriteScope(sessionId, action);
        // Trivial escape: a trivial task never reserves the mutation boundary.
        // Main completes the one or two small edits directly in the same turn.
        if (status.checklist.trivial === true) return false;
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
    arm?: "off" | "session" | "task";
    fallbackModels?: string[];
    thinking?: FabricThinking;
    verificationMode?: "gated";
    maxPhaseRevisions?: number;
    delegateContext?: boolean;
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
        arm: input.arm ?? "off",
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
        ...(input.delegateContext ? { delegateContext: true } : {}),
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
      // A fresh continuation hands over its checklist once; later injections
      // wait for mutation activity so read-only turns stay quiet.
      this.#mutationSinceReminder = true;
    }
    // Only re-inject the full reminder when the executor attempted or was
    // rejected on a mutation since the last injection. Read-only turns get
    // no reminder, so a long quiet investigation does not look like a stuck
    // prewalk and the reminder budget lasts for the work that needs it.
    if (!this.#mutationSinceReminder) return undefined;
    this.#mutationSinceReminder = false;
    if (this.#reminderCount >= PrewalkController.#REMINDER_LIMIT) return undefined;
    this.#reminderCount += 1;
    return structuredClone(status.checklist);
  }

  // Record completed checklist items from [DONE:n] markers in the executor's
  // turn text. Indexes are merged into the live checklist's doneIndexes
  // (sorted, unique, bounded by item count); items stay untouched so the plan
  // text survives. Returns false when the session has no live checklist.
  markChecklistDone(sessionId: string, indexes: readonly number[]): boolean {
    const status = this.#status;
    if (status.state === "idle" || status.sessionId !== sessionId || !status.checklist) {
      return false;
    }
    const checklist = status.checklist;
    const bounded = indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < checklist.items.length);
    const merged = [...new Set([...(status.checklist.doneIndexes ?? []), ...bounded])].sort((a, b) => a - b);
    if (merged.length === (status.checklist.doneIndexes?.length ?? 0)) return true;
    status.checklist.doneIndexes = merged;
    return true;
  }

  setWriteScope(sessionId: string, paths: readonly string[]): void {
    if (!this.isArmed(sessionId)) return;
    this.#writeScopes.set(sessionId, new Set(paths));
  }

  clearWriteScope(sessionId: string): void {
    this.#writeScopes.delete(sessionId);
  }

  #enforceWriteScope(sessionId: string, action: FabricPrewalkBoundaryAction): void {
    const scope = this.#writeScopes.get(sessionId);
    if (!scope || scope.size === 0) return;
    if (action.effect !== "workspace") return;
    if (!action.path) return;
    const resolved = action.path.startsWith("/")
      ? action.path
      : path.resolve(process.cwd(), action.path);
    for (const allowed of scope) {
      const abs = allowed.startsWith("/") ? allowed : path.resolve(process.cwd(), allowed);
      if (resolved === abs || resolved.startsWith(abs + "/")) return;
    }
    throw new Error(
      "Prewalk write scope rejects path outside the current wave: " + action.path,
    );
  }

  settleTask(sessionId: string, rearm?: FabricPrewalkRearmDefaults): boolean {
    const previous = this.#status;
    this.#writeScopes.delete(sessionId);
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

  completeHandoff(returnModel?: string, returnThinking?: string): FabricPrewalkStatus {
    if (this.#status.state !== "handing_off") return this.status();
    return this.#transition({
      kind: "handoff_succeeded",
      at: Date.now(),
      handoffId: this.#status.handoffId,
      ...(returnModel ? { returnModel } : {}),
      ...(returnThinking ? { returnThinking } : {}),
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
    returnThinking?: string;
    checklist?: FabricPrewalkChecklist;
    task?: string;
  } {
    const previous = this.#status;
    // A gated task that settles while still verifying never recorded acceptance
    // evidence, but it did switch Main to the executor. It still owes the
    // restore, so surrender the returnModel on that path too.
    const returnModel =
      (previous.state === "continuing" || previous.state === "verifying") &&
      previous.sessionId === sessionId
        ? previous.returnModel
        : undefined;
    const returnThinking =
      (previous.state === "continuing" || previous.state === "verifying") &&
      previous.sessionId === sessionId
        ? previous.returnThinking
        : undefined;
    const settledChecklist =
      (previous.state === "continuing" || previous.state === "verifying") &&
      previous.sessionId === sessionId
        ? previous.checklist
        : undefined;
    const settledTask =
      (previous.state === "continuing" || previous.state === "verifying") &&
      previous.sessionId === sessionId
        ? previous.task
        : undefined;
    this.#writeScopes.delete(sessionId);
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
      ...(returnThinking ? { returnThinking } : {}),
      ...(settledChecklist ? { checklist: structuredClone(settledChecklist) } : {}),
      ...(settledTask ? { task: settledTask } : {}),
    };
  }

  // The verification_failed path blocks at the fabric_exec boundary rather than
  // at settlement, so settleContinuation never sees it. Surrender the pending
  // returnModel here instead, exactly once per handoff.
  takeReturnState(sessionId: string): { model?: string; thinking?: string } {
    const status = this.#status;
    if (status.state !== "blocked" || status.sessionId !== sessionId) return {};
    if (this.#consumedReturnModels.has(status.handoffId)) return {};
    this.#consumedReturnModels.add(status.handoffId);
    const result: { model?: string; thinking?: string } = {};
    if (status.returnModel) result.model = status.returnModel;
    if (status.returnThinking) result.thinking = status.returnThinking;
    return result;
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
      const returnThinking = this.#status.returnThinking;
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
        ...(returnThinking ? { returnThinking } : {}),
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
    // Trivial escape: a trivial task never claims a handoff, so Main keeps its
    // model and the settled task simply ends the one-shot arm.
    if (this.#status.checklist?.trivial === true) return undefined;
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
