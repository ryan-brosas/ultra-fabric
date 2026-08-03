import { describe, expect, it } from "vitest";
import type { FabricCallAudit } from "../src/core/action-registry.js";
import { PrewalkController } from "../src/prewalk/controller.js";

const audit = (
  ref: string,
  success: boolean,
  sequence = 1,
  risk?: FabricCallAudit["risk"],
  effect?: FabricCallAudit["effect"],
): FabricCallAudit => ({
  ref,
  nestedToolCallId: `call-${sequence}`,
  startedAt: sequence,
  endedAt: sequence + 1,
  success,
  ...(risk ? { risk } : {}),
  ...(effect ? { effect } : {}),
});

describe("PrewalkController", () => {
  it("arms a one-shot executor and captures the next task when omitted", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.isArmed("session-1")).toBe(true);
    controller.observeTask("session-1", "  Implement the guard  ");
    controller.observeTask("session-1", "Do not replace the first task");

    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
  });

  it("keeps an unfired arm armed when an observed task settles", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.settleTask("session-1")).toBe(false);
    controller.observeTask("session-1", "Inspect without changing anything");
    expect(controller.settleTask("session-2")).toBe(false);
    expect(controller.settleTask("session-1")).toBe(false);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Inspect without changing anything",
    });
  });

  it("re-arms without leaking the previous task when always re-arm is enabled", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Inspect without changing anything",
      alwaysRearm: true,
    });

    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");

    controller.observeTask("session-1", "Implement the next task");
    expect(controller.status()).toMatchObject({ task: "Implement the next task" });
  });

  it("claims only the first successful recognized mutation", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
    });

    expect(
      controller.claim(
        [audit("pi.read", true), audit("pi.edit", false, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    const claim = controller.claim(
      [audit("pi.read", true), audit("pi.write", true, 2)],
      "session-1",
    );

    expect(claim).toMatchObject({
      arm: { model: "anthropic/executor", task: "Implement" },
      mutation: { ref: "pi.write", success: true },
    });
    expect(controller.status()).toMatchObject({ state: "handing_off" });
    expect(controller.claim([audit("schema.commit", true)], "session-1")).toBeUndefined();
  });

  it("distinguishes workspace effects from state bookkeeping with the same write risk", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
    });

    const claim = controller.claim([
      audit("state.put", true, 1, "write", "state"),
      audit("extensions.generated_write", true, 2, "write", "workspace"),
    ], "session-1");

    expect(claim?.mutation.ref).toBe("extensions.generated_write");
  });

  it("claims configured write-risk providers without treating bash as a mutation", () => {
    const controller = new PrewalkController();
    controller.configureTriggers(["write"], []);
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
    });

    const claim = controller.claim([
      audit("pi.bash", true, 1, "execute"),
      audit("extensions.generated_write", true, 2, "write"),
    ], "session-1");

    expect(claim?.mutation.ref).toBe("extensions.generated_write");
  });

  it("claims one identity-owned revision from effective verification gates", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      verificationMode: "gated",
      maxPhaseRevisions: 1,
    } as never);
    controller.claim([audit("pi.edit", true)], "session-1", "execute-1");
    controller.completeHandoff("anthropic/frontier");
    expect(controller.acceptContinuation("session-1", "execute-1")).toBe(true);

    const observe = (controller as unknown as {
      observeVerification(
        gates: Array<Record<string, unknown>>,
        sessionId: string,
        handoffId: string,
      ): unknown;
    }).observeVerification.bind(controller);
    const revision = observe([
      {
        gate: "acceptance",
        passed: false,
        disposition: "revise",
        evidence: [{ kind: "command", ref: "test:failed" }],
        reason: "test failed",
        sequence: 1,
        recordedAt: 20,
        decision: "revise",
        revision: 1,
      },
    ], "session-1", "revise-1");

    expect(revision).toMatchObject({
      kind: "revision",
      gate: "acceptance",
      feedback: "test failed",
      revision: 1,
      returnModel: "anthropic/frontier",
    });
    expect(controller.status()).toMatchObject({
      state: "handing_off",
      handoffId: "revise-1",
      revision: 1,
      revisionGate: "acceptance",
    });
  });

  it("does not cross session boundaries", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.claim([audit("pi.edit", true)], "session-2")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("disarms when the program already performed an explicit handoff", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(
      controller.claim(
        [audit("pi.edit", true), audit("agents.handoff", true, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("gates research mutations on a host-observed checklist", () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "research",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      returnPolicy: "previous",
    });
    const boundary = controller.executionBoundary("session-1");
    expect(boundary).toBeDefined();
    expect(controller.status()).toMatchObject({
      mode: "research",
      returnPolicy: "executor",
    });

    expect(() => boundary!.authorize({
      ref: "pi.write",
      risk: "write",
      effect: "workspace",
    })).toThrow(/checklist/i);

    boundary!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });
    const reservation = boundary!.authorize({
      ref: "pi.write",
      risk: "write",
      effect: "workspace",
    });
    expect(reservation).toBe(true);
    expect(boundary!.settle(reservation, audit("pi.write", true, 1, "write", "workspace")))
      .toBe(true);
    expect(controller.status()).toMatchObject({
      state: "armed",
      checklist: { items: expect.any(Array) },
    });
  });

  it("accepts a host checklist for every armed mode, not only research", () => {
    for (const mode of ["in-place", "trajectory"] as const) {
      const controller = new PrewalkController();
      controller.arm({
        mode,
        model: "anthropic/executor",
        sessionId: "session-1",
        task: "Implement",
      });
      const boundary = controller.executionBoundary("session-1");
      expect(boundary).toBeDefined();
      boundary!.registerChecklist({
        items: Array.from({ length: 6 }, (_, index) => ({
          task: `Change target ${index + 1}`,
          validation: `Run check ${index + 1}`,
        })),
      });
      expect(controller.status()).toMatchObject({
        state: "armed",
        mode,
        checklist: { items: expect.any(Array) },
      });
      // Only research reserves the first mutation: other modes authorize reads
      // and non-mutating calls without a reservation.
      expect(boundary!.authorize({ ref: "pi.read" })).toBe(false);
      expect(boundary!.authorize({
        ref: "pi.write",
        risk: "write",
        effect: "workspace",
      })).toBe(false);
    }
  });

  it("exposes the active checklist only while a continuation is live", () => {
    const controller = new PrewalkController();
    controller.arm({ mode: "in-place", model: "anthropic/executor", sessionId: "session-1" });
    controller.executionBoundary("session-1")!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });
    expect(controller.activeChecklist("session-1")).toBeUndefined();

    const claim = controller.claim([audit("pi.edit", true)], "session-1", "handoff-1");
    expect(claim).toBeDefined();
    controller.completeHandoff();
    controller.acceptContinuation("session-1", "handoff-1");

    expect(controller.activeChecklist("session-1")?.items).toHaveLength(5);
    expect(controller.activeChecklist("session-2")).toBeUndefined();

    controller.cancel();
    expect(controller.activeChecklist("session-1")).toBeUndefined();
  });

  it("serializes the research mode first mutation reservation", () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "research",
      model: "anthropic/executor",
      sessionId: "session-1",
    });
    const boundary = controller.executionBoundary("session-1")!;
    boundary.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });

    const reservation = boundary.authorize({
      ref: "pi.edit",
      risk: "write",
      effect: "workspace",
    });
    expect(() => boundary.authorize({
      ref: "pi.write",
      risk: "write",
      effect: "workspace",
    })).toThrow(/already in flight/i);
    boundary.release(reservation);
    expect(boundary.authorize({
      ref: "pi.write",
      risk: "write",
      effect: "workspace",
    })).toBe(true);
  });
});
