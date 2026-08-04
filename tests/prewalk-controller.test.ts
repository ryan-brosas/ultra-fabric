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
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      returnPolicy: "previous",
    });
    const boundary = controller.executionBoundary("session-1");
    expect(boundary).toBeDefined();
    expect(controller.status()).toMatchObject({
      returnPolicy: "previous",
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

  it("exposes the active checklist only while a continuation is live", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    controller.executionBoundary("session-1")!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });
    expect(controller.claimChecklistReminder("session-1")).toBeUndefined();

    const claim = controller.claim([audit("pi.edit", true)], "session-1", "handoff-1");
    expect(claim).toBeDefined();
    controller.completeHandoff();
    controller.acceptContinuation("session-1", "handoff-1");

    expect(controller.claimChecklistReminder("session-1")?.items).toHaveLength(5);
    expect(controller.claimChecklistReminder("session-2")).toBeUndefined();

    controller.cancel();
    expect(controller.claimChecklistReminder("session-1")).toBeUndefined();
  });

  it("can hand off on checklist acceptance before the first write", () => {
    // The default trigger is the first successful write, so Main has already
    // designed the change and made an edit before the executor is involved.
    // Triggering on the accepted checklist hands the whole implementation over
    // while Main has only planned.
    const controller = new PrewalkController();
    controller.configureTriggers([], ["fabric.prewalk.checklist", "pi.edit", "pi.write"], []);
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    const claim = controller.claim(
      [audit("fabric.prewalk.checklist", true)],
      "session-1",
      "handoff-1",
    );
    expect(claim).toBeDefined();
    expect(claim!.mutation.ref).toBe("fabric.prewalk.checklist");
  });

  it("prefers the earliest matching trigger in one execution", () => {
    const controller = new PrewalkController();
    controller.configureTriggers([], ["fabric.prewalk.checklist", "pi.edit"], []);
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    const claim = controller.claim(
      [audit("fabric.prewalk.checklist", true), audit("pi.edit", true)],
      "session-1",
      "handoff-1",
    );
    expect(claim!.mutation.ref).toBe("fabric.prewalk.checklist");
  });

  it("bounds the checklist reminder per continuation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    controller.executionBoundary("session-1")!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });
    const claim = controller.claim([audit("pi.edit", true)], "session-1", "handoff-1");
    expect(claim).toBeDefined();
    controller.completeHandoff();
    controller.acceptContinuation("session-1", "handoff-1");

    // The reminder steers a drifting executor, but an unbounded reminder keeps
    // Main working after the checklist is satisfied and replays a growing
    // context every turn.
    const fired: number[] = [];
    for (let turn = 0; turn < 8; turn++) {
      if (controller.claimChecklistReminder("session-1")) fired.push(turn);
    }
    expect(fired.length).toBeLessThanOrEqual(3);
    expect(fired.length).toBeGreaterThan(0);
    expect(controller.claimChecklistReminder("session-1")).toBeUndefined();
  });

  it("serializes the research mode first mutation reservation", () => {
    const controller = new PrewalkController();
    controller.arm({
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

// A successful tool call is not automatically a mutation. Ported from the
// qualified tiequan12345/pi-prewalk detectActionTool contract: an edit whose
// diff and patch are both empty, or a write the host reports as unchanged,
// left the workspace untouched and must not own the handoff boundary.
describe("PrewalkController no-op mutations", () => {
  const resultAudit = (ref: string, result: unknown): FabricCallAudit => ({
    ref,
    nestedToolCallId: "call-1",
    startedAt: 1,
    endedAt: 2,
    success: true,
    result,
  });

  const armed = () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    return controller;
  };

  it("does not claim an edit that changed nothing", () => {
    const controller = armed();
    expect(
      controller.claim([resultAudit("pi.edit", { diff: "", patch: "" })], "session-1"),
    ).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("does not claim a write the host reports as unchanged", () => {
    const controller = armed();
    expect(
      controller.claim([resultAudit("pi.write", { changed: false })], "session-1"),
    ).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("claims a real edit and a write with no change signal", () => {
    expect(
      armed().claim([resultAudit("pi.edit", { diff: "+1", patch: "@@" })], "session-1"),
    ).toMatchObject({ mutation: { ref: "pi.edit" } });
    expect(
      armed().claim([resultAudit("pi.write", { ok: true })], "session-1"),
    ).toMatchObject({ mutation: { ref: "pi.write" } });
  });
});
