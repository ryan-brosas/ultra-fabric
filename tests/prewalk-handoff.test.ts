import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  checklistContinuationPrompt,
  claimFabricHandoff,
  hasPrewalkArmedPrompt,
  prewalkArmedMessageType,
  prewalkArmedPrompt,
  runFabricHandoffAtBoundary,
  selectPrewalkExecutorModel,
  withTrajectoryRearmDirective,
} from "../src/prewalk/handoff.js";

const execution = (): FabricExecutionResult => ({
  success: true,
  value: "complete outer result",
  logs: [],
  audits: [
    {
      ref: "pi.read",
      nestedToolCallId: "read",
      startedAt: 1,
      endedAt: 2,
      success: true,
      args: { path: "src/a.ts" },
      result: "source",
    },
    {
      ref: "pi.edit",
      nestedToolCallId: "edit-one",
      startedAt: 3,
      endedAt: 4,
      success: true,
      args: { path: "src/a.ts" },
      result: { ok: true },
    },
    {
      ref: "pi.write",
      nestedToolCallId: "edit-two",
      startedAt: 5,
      endedAt: 6,
      success: true,
      args: { path: "src/b.ts" },
      result: { ok: true },
    },
  ],
  phases: [],
  trace: {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
    operations: [],
    phases: [],
  },
  elapsedMs: 1,
});

const context = (overrides?: { thinkingLevel?: string }) => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: "user", content: "Implement everything", timestamp: 1 });
  source.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "outer",
      name: "fabric_exec",
      arguments: { code: "await pi.edit(...); return 'complete outer result';" },
    }],
    api: "anthropic",
    provider: "anthropic",
    model: "frontier",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const target = { provider: "anthropic", id: "executor" };
  const setStatus = vi.fn();
  return {
    value: {
      cwd: process.cwd(),
      signal: undefined,
      model: { provider: "anthropic", id: "frontier" },
      thinkingLevel: overrides?.thinkingLevel,
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === target.provider && id === target.id ? target : undefined,
      },
      sessionManager: source,
      ui: { setStatus, notify: vi.fn() },
    } as unknown as ExtensionContext,
    setStatus,
    target,
  };
};

const extension = (overrides?: { getThinkingLevel?: string }) => {
  const setModel = vi.fn().mockResolvedValue(true);
  const setThinkingLevel = vi.fn();
  const getThinkingLevel = vi.fn().mockReturnValue(overrides?.getThinkingLevel ?? "medium");
  const sendMessage = vi.fn();
  return {
    value: { setModel, setThinkingLevel, getThinkingLevel, sendMessage } as unknown as ExtensionAPI,
    setModel,
    setThinkingLevel,
    getThinkingLevel,
    sendMessage,
  };
};

describe("outer-boundary Prewalk", () => {
  it("switches Main in place and queues a hidden follow-up by default", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    const pending = claimFabricHandoff(controller, run, "session-1", "json");

    expect(run.audits.map((audit) => audit.ref)).toEqual([
      "pi.read",
      "pi.edit",
      "pi.write",
      "fabric.prewalk",
    ]);
    expect(pending).toMatchObject({
      kind: "prewalk-research",
      args: { model: "anthropic/executor", task: "Implement the guard" },
      triggerRef: "pi.edit",
    });

    const ctx = context();
    const ext = extension();
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      ext.value,
      pending!,
      ctx.value,
      activity,
    );

    expect(ext.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", id: "executor" }),
    );
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        display: false,
        content: expect.stringContaining("Continue the existing task"),
        details: expect.objectContaining({
          continuationId: pending!.audit.nestedToolCallId,
        }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(result).toMatchObject({
      prewalk: true,
      continued: true,
      model: "anthropic/executor",
    });
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      handoffId: pending!.audit.nestedToolCallId,
      task: "Implement the guard",
      attempt: 1,
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuation pending → anthropic/executor",
    );
  });

  it("continues research Prewalk in place with the accepted checklist", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const items = Array.from({ length: 5 }, (_, index) => ({
      task: `Change target ${index + 1}`,
      validation: `Run check ${index + 1}`,
    }));
    controller.executionBoundary("session-1")!.registerChecklist({ items });
    const run = execution();
    run.prewalkBoundary = { ref: "pi.edit", nestedToolCallId: "edit-one" };
    const pending = claimFabricHandoff(controller, run, "session-1", "json");

    expect(pending).toMatchObject({
      kind: "prewalk-research",
      checklist: { items },
      triggerRef: "pi.edit",
    });

    const host = context();
    const api = extension();
    const result = await runFabricHandoffAtBoundary(
      controller,
      api.value,
      pending!,
      host.value,
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        content: expect.stringMatching(/Change target 1[\s\S]*Validation: Run check 1/),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(result).toMatchObject({
      prewalk: true,
      continued: true,
      model: "anthropic/executor",
    });
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
    });
  });

  it("queues an explicit gated verification continuation", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      verificationMode: "gated",
      maxPhaseRevisions: 2,
    } as never);
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const host = context();
    const api = extension();

    await runFabricHandoffAtBoundary(
      controller,
      api.value,
      pending,
      host.value,
    );

    expect(controller.status()).toMatchObject({
      state: "verification_pending",
      revision: 0,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("workflow.gate"),
        details: expect.objectContaining({ phase: "verify", revision: 0 }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("carries the previous Main model through continuation settlement unconditionally", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      ext.value,
      pending!,
      ctx.value,
    );

    expect(ext.setModel).toHaveBeenCalled();
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      returnModel: "anthropic/frontier",
    });
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({
      settled: true,
      returnModel: "anthropic/frontier",
      status: { state: "idle" },
    });
  });

  it("blocks a failed continuation without losing task intent", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();
    ext.setModel.mockResolvedValue(false);


    const result = await runFabricHandoffAtBoundary(
      controller,
      ext.value,
      pending!,
      ctx.value,
    );

    expect(ext.setModel).toHaveBeenCalled();
    expect(result).toMatchObject({
      prewalk: true,
      completed: false,
      status: "failed",
      error: expect.stringContaining("no authentication"),
    });
    expect(controller.status()).toMatchObject({
      state: "blocked",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      attempt: 1,
      error: expect.stringContaining("no authentication"),
    });
    expect(controller.isArmed("session-1")).toBe(false);
  });

  it("turns a revise gate into a scoped revision handoff", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      verificationMode: "gated",
      maxPhaseRevisions: 1,
    } as never);
    const first = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    controller.completeHandoff();
    controller.acceptContinuation("session-1", first.audit.nestedToolCallId);
    const verification = execution();
    verification.audits = [];
    verification.gates = [{
      gate: "acceptance",
      passed: false,
      disposition: "revise",
      evidence: [{ kind: "command", ref: "pnpm:test" }],
      reason: "one regression failed",
      sequence: 1,
      recordedAt: 20,
      decision: "revise",
      revision: 1,
    }];

    const revision = claimFabricHandoff(
      controller,
      verification,
      "session-1",
      "json",
    );

    expect(revision).toMatchObject({
      kind: "prewalk-research",
      triggerRef: "workflow.gate:acceptance",
      revision: 1,
      args: { model: "anthropic/executor" },
    });
    expect(String(revision?.args.task)).toContain("one regression failed");
    expect(controller.status()).toMatchObject({
      state: "handing_off",
      revision: 1,
    });
  });

  it("accepts a passing verification gate without another handoff", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      verificationMode: "gated",
      maxPhaseRevisions: 1,
    } as never);
    const first = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    controller.completeHandoff();
    controller.acceptContinuation("session-1", first.audit.nestedToolCallId);
    const verification = execution();
    verification.audits = [];
    verification.gates = [{
      gate: "acceptance",
      passed: true,
      disposition: "abort",
      evidence: [{ kind: "command", ref: "pnpm:test" }],
      sequence: 1,
      recordedAt: 20,
      decision: "continue",
      revision: 0,
    }];

    expect(claimFabricHandoff(controller, verification, "session-1", "json"))
      .toBeUndefined();
    expect(controller.status()).toMatchObject({
      state: "continuing",
      verificationGate: "acceptance",
    });
  });

  it("preserves the thinking level across a re-armed trajectory handoff", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "xhigh",
      arm: "task",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    await runFabricHandoffAtBoundary(
      controller,
      extension().value,
      pending!,
      context().value,
    );
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      thinking: "xhigh",
      arm: "task",
    });
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({ settled: true });
    expect(controller.status()).toMatchObject({
      state: "armed",
      thinking: "xhigh",
      arm: "task",
    });
  });

  it("re-arms after an in-place continuation when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      arm: "task",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    await runFabricHandoffAtBoundary(
      controller,
      extension().value,
      pending!,
      ctx.value,
    );

    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      model: "anthropic/executor",
      arm: "task",
      task: "Implement the guard",
    });
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({ settled: true });
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      arm: "task",
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuation pending → anthropic/executor",
    );
  });

  it("gives an explicit deferred trajectory request precedence", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/automatic", sessionId: "session-1" });
    const run = execution();
    run.audits.push({
      ref: "agents.handoff",
      nestedToolCallId: "explicit",
      startedAt: 7,
      endedAt: 8,
      success: true,
      args: { model: "anthropic/explicit" },
      result: { status: "deferred" },
    });
    run.handoffRequest = { model: "anthropic/explicit", task: "Use explicit executor" };

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toMatchObject({
      kind: "explicit",
      args: { model: "anthropic/explicit", task: "Use explicit executor" },
    });
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("lets an explicit handoff supersede a blocked prewalk task", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/automatic",
      sessionId: "session-1",
      task: "Preserve this task",
    });
    controller.claim([execution().audits[1]!], "session-1");
    controller.failHandoff("automatic handoff failed");

    const run = execution();
    run.audits.push({
      ref: "agents.handoff",
      nestedToolCallId: "explicit-after-failure",
      startedAt: 7,
      endedAt: 8,
      success: true,
      args: { model: "anthropic/explicit" },
      result: { status: "deferred" },
    });
    run.handoffRequest = { model: "anthropic/explicit", task: "Use explicit executor" };

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toMatchObject({
      kind: "explicit",
      args: { model: "anthropic/explicit", task: "Use explicit executor" },
    });
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("does not claim when the complete execution had no mutation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const run = execution();
    run.audits = run.audits.slice(0, 1);

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

});

// One table for the whole mode contract. Adopted from aider's architect-mode
// delegation tests and plandex's role/model-pack tables: assert the delegation
// boundary per mode instead of scattering near-duplicate cases. The load-bearing
// column is setModel — only research may ever change Main's model.
// The single prewalk path has no mode discriminant: it always switches Main in
// session and never spawns a child, so the executor inherits Main tools.
describe("prewalk thinking level is applied", () => {
  it("calls setThinkingLevel with the arm's configured thinking level", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "max",
    } as never);
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(controller, ext.value, pending, ctx.value);
    expect(ext.setThinkingLevel).toHaveBeenCalledWith("max");
  });
});

describe("prewalk thinking round trip", () => {
  it("applies arm thinking on handoff and captures returnThinking from the context", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "max",
    } as never);
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const ctx = context({ thinkingLevel: "medium" });
    const ext = extension({ getThinkingLevel: "medium" });
    await runFabricHandoffAtBoundary(controller, ext.value, pending, ctx.value);
    // Level applied on handoff
    expect(ext.setThinkingLevel).toHaveBeenCalledWith("max");
    // Return thinking captured from the context at handoff time
    expect(controller.status()).toMatchObject({
      returnThinking: "medium",
    });
  });
});

describe("prewalk single-path contract", () => {
  const armed = () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    controller.executionBoundary("session-1")!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: "Change target " + (index + 1),
        validation: "Run check " + (index + 1),
      })),
    });
    run.prewalkBoundary = { ref: "pi.edit", nestedToolCallId: "edit-one" };
    return { controller, pending: claimFabricHandoff(controller, run, "session-1", "json")! };
  };

  it("binds the single path to an in-session model switch", async () => {
    const { controller, pending } = armed();
    expect(pending.kind).toBe("prewalk-research");
    expect(pending.audit.ref).toBe("fabric.prewalk");
    expect(pending.args).not.toHaveProperty("thinking");
    expect(pending.args).not.toHaveProperty("fallbackModels");

    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(controller, ext.value, pending, ctx.value);

    expect(ext.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", id: "executor" }),
    );
  });
});

describe("prewalkArmedPrompt", () => {
  it("defines the bounded research protocol before execution", () => {
    const text = prewalkArmedPrompt("anthropic/executor");
    expect(prewalkArmedMessageType()).toBe(PREWALK_ARMED_MESSAGE_TYPE);
    expect(text).toContain("anthropic/executor (research)");
    expect(text).toContain("deep, concrete");
    expect(text).toContain("prewalk.checklist");
    expect(text).toContain("5-9");
    expect(text).toContain("validation");
    expect(text).toContain("stop. Do not make any mutation");
    expect(text).toContain("executor model");
  });

  it("instructs full-pass research budget spend and arxiv + sources clone enrichment", () => {
    const text = prewalkArmedPrompt("anthropic/executor");
    expect(text).toContain("Spend the research budget in full passes");
    expect(text).toContain("Do not drip small queries");
    expect(text).toContain("arXiv");
    expect(text).toContain("sources/");
    const continuation = checklistContinuationPrompt({ items: [], readyAt: 1 });
    expect(continuation).not.toContain("arXiv");
    expect(continuation).not.toContain("drip");
  });

});

const checklistItems = [
  { task: "Change the guard", validation: "Run the guard test" },
  { task: "Update the matching caller", validation: "Run the caller test" },
  { task: "Refresh the docs section", validation: "Read the rendered section" },
  { task: "Run the focused suite", validation: "Confirm every focused test passes" },
  { task: "Check dead code", validation: "Confirm knip reports no unused exports" },
];

const armedWithChecklist = (): PrewalkController => {
  const controller = new PrewalkController();
  controller.arm({
    model: "anthropic/executor",
    sessionId: "session-1",
    task: "Implement the guard",
  });
  controller.executionBoundary("session-1")!.registerChecklist({ items: checklistItems });
  return controller;
};

describe("prewalk checklist handoff", () => {
  it("replays the checklist in the in-place continuation message", async () => {
    const controller = armedWithChecklist();
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(
      controller,
      ext.value,
      pending,
      ctx.value,
    );
    const call = ext.sendMessage.mock.calls.find(
      ([message]) =>
        (message as { customType?: string }).customType ===
        "pi-fabric-prewalk-continue",
    );
    expect(call).toBeDefined();
    const content = String((call![0] as { content?: unknown }).content);
    for (const item of checklistItems) {
      expect(content).toContain(item.task);
      expect(content).toContain(`Validation: ${item.validation}`);
    }
    expect(content).not.toContain(
      "Continue the existing task in this same session under the executor model.",
    );
    expect(content).toMatch(/\[DONE:\d+\]/);
    expect(content).toContain("emit its [DONE:n] marker");
  });

  it("keeps a gated revision's feedback over the checklist task for a trajectory arm", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      verificationMode: "gated",
      maxPhaseRevisions: 1,
    } as never);
    controller.executionBoundary("session-1")!.registerChecklist({ items: checklistItems });
    const first = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    controller.completeHandoff();
    controller.acceptContinuation("session-1", first.audit.nestedToolCallId);
    const verification = execution();
    verification.audits = [];
    verification.gates = [
      {
        gate: "acceptance",
        passed: false,
        disposition: "revise",
        evidence: [{ kind: "command", ref: "pnpm:test" }],
        reason: "one regression failed",
        sequence: 1,
        recordedAt: 20,
        decision: "revise",
        revision: 1,
      },
    ];
    const revision = claimFabricHandoff(controller, verification, "session-1", "json");
    expect(revision).toMatchObject({ kind: "prewalk-research", revision: 1 });
    const task = String(revision?.args.task);
    expect(task).toContain("one regression failed");
    expect(task).toContain("Revision 1");
    for (const item of checklistItems) {
      expect(task).not.toContain(item.task);
    }
  });
});

describe("hasPrewalkArmedPrompt", () => {
  it("matches persisted armed prompts by content only", () => {
    const armed = prewalkArmedPrompt("anthropic/executor");
    const entries = [
      { type: "message", message: { role: "user" } },
      {
        type: "custom_message",
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: [{ type: "text", text: armed }],
      },
      { type: "custom_message", customType: "other-extension", content: armed },
    ];
    expect(hasPrewalkArmedPrompt(entries, armed)).toBe(true);
    expect(hasPrewalkArmedPrompt(entries, prewalkArmedPrompt("other/model"))).toBe(false);
    expect(hasPrewalkArmedPrompt([], armed)).toBe(false);
  });

  it("accepts string content and ignores malformed entries", () => {
    const entries = [
      { type: "custom_message", customType: PREWALK_ARMED_MESSAGE_TYPE, content: "plain" },
      null,
      42,
    ];
    expect(hasPrewalkArmedPrompt(entries, "plain")).toBe(true);
    expect(hasPrewalkArmedPrompt(entries, "other")).toBe(false);
  });
});

describe("withTrajectoryRearmDirective", () => {
  const trajectoryPending = (arm: "off" | "task") => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      arm
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    return { controller, pending };
  };

  it("omits the directive for in-place pendings", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    expect(pending.kind).toBe("prewalk-research");
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the handoff failed", () => {
    const { controller, pending } = trajectoryPending("task");
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: false }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm was one-shot", () => {
    const { controller, pending } = trajectoryPending("off");
    controller.completeHandoff();
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      arm: "off",
    });
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm belongs to another session", () => {
    const { controller, pending } = trajectoryPending("task");
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-2")).toBe("OUTPUT");
  });
});

// Research owns Main through completion, but ownership afterwards is the
// operator's call: "previous" must hand Main back its own model on settle.
describe("research return policy", () => {
  it("restores Main's model after research when the return policy is previous", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    controller.executionBoundary("session-1")!.registerChecklist({
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
    });
    run.prewalkBoundary = { ref: "pi.edit", nestedToolCallId: "edit-one" };
    const pending = claimFabricHandoff(controller, run, "session-1", "json")!;

    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(
      controller,
      ext.value,
      pending,
      ctx.value,
    );

    expect(ext.setModel).toHaveBeenCalled();
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      returnModel: "anthropic/frontier",
    });
    expect(controller.acceptContinuation("session-1", pending.audit.nestedToolCallId)).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({
      settled: true,
      returnModel: "anthropic/frontier",
      status: { state: "idle" },
    });
  });
});

describe("selectPrewalkExecutorModel", () => {
  const routes = [
    "omniroute/opencode-go/deepseek-v4-flash",
    "anthropic/fallback",
    "openai/final-fallback",
  ];

  it("prefers the primary route and falls through to an available fallback", async () => {
    const selection = await selectPrewalkExecutorModel(routes, {
      requireModel: (candidate) => {
        if (candidate !== routes[0]) throw new Error(`Prewalk model is unavailable: ${candidate}`);
        return { provider: "omniroute", id: "opencode-go/deepseek-v4-flash" };
      },
      setModel: async () => true,
    });

    expect(selection).toEqual({ model: routes[0], fallback: false, skipped: [] });
  });

  it("falls through to the first available configured fallback", async () => {
    const selection = await selectPrewalkExecutorModel(routes, {
      requireModel: (candidate) => {
        if (candidate === routes[0] || candidate === routes[1]) {
          throw new Error(`Prewalk model is unavailable: ${candidate}`);
        }
        return { provider: "openai", id: "final-fallback" };
      },
      setModel: async () => true,
    });

    expect(selection).toEqual({
      model: routes[2],
      fallback: true,
      skipped: [
        `${routes[0]}: Prewalk model is unavailable: ${routes[0]}`,
        `${routes[1]}: Prewalk model is unavailable: ${routes[1]}`,
      ],
    });
  });

  it("distinguishes unauthenticated routes from unavailable ones", async () => {
    const selection = await selectPrewalkExecutorModel(routes, {
      requireModel: (candidate) => ({ provider: candidate.split("/")[0], id: candidate.split("/")[1] }),
      setModel: async (model) => (model as { provider: string }).provider === "openai",
    });

    expect(selection).toEqual({
      model: routes[2],
      fallback: true,
      skipped: [`${routes[0]}: no authentication`, `${routes[1]}: no authentication`],
    });
  });

  it("reports a typed terminal failure when every configured route is unavailable", async () => {
    await expect(
      selectPrewalkExecutorModel(routes, {
        requireModel: (candidate) => {
          throw new Error(`Prewalk model is unavailable: ${candidate}`);
        },
        setModel: async () => true,
      }),
    ).rejects.toThrow(
      `No available prewalk executor from ${routes.length} configured route(s): ` +
        routes.map((route) => `${route}: Prewalk model is unavailable: ${route}`).join("; "),
    );
  });
});

describe("prewalk executor args", () => {
  it("forwards the armed thinking level to the executor", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      thinking: "max",
    });

    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;

    expect(pending.args).toMatchObject({ thinking: "max" });
  });
});
