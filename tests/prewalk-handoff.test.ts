import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResultMessage } from "../src/agents/types.js";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import {
  type BoundaryHandoffRunner,
  PREWALK_ARMED_MESSAGE_TYPE,
  PREWALK_PLAN_MESSAGE_TYPE,
  claimFabricHandoff,
  hasPrewalkArmedPrompt,
  prewalkArmedMessageType,
  prewalkArmedPrompt,
  runFabricHandoffAtBoundary,
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

const outerResult = (): AgentToolResultMessage => ({
  role: "toolResult",
  toolCallId: "outer",
  toolName: "fabric_exec",
  content: [{ type: "text", text: "complete outer result" }],
  details: { success: true },
  isError: false,
  timestamp: 10,
});

const context = () => {
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

const extension = () => {
  const setModel = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn();
  return {
    value: { setModel, sendMessage } as unknown as ExtensionAPI,
    setModel,
    sendMessage,
  };
};

const unusedRunner = () => ({ executeHandoff: vi.fn() });
const completedRunner = () => ({
  executeHandoff: vi.fn(async () => ({ handedOff: true, completed: true, status: "completed" })),
});

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
      kind: "prewalk-in-place",
      args: { model: "anthropic/executor", task: "Implement the guard" },
      triggerRef: "pi.edit",
    });

    const ctx = context();
    const ext = extension();
    const runner = completedRunner();
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/executor" }),
      expect.anything(),
      expect.anything(),
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
      mode: "in-place",
      completed: true,
      trigger: { ref: "pi.edit" },
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

  it("runs the in-place executor off-session so Main keeps its model", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    const pending = claimFabricHandoff(controller, run, "session-1", "json");
    expect(pending).toMatchObject({ kind: "prewalk-in-place" });

    const ctx = context();
    const ext = extension();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: true,
        status: "completed",
      })),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      vi.fn(),
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/executor" }),
      expect.anything(),
      expect.anything(),
    );
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-fabric-prewalk-continue" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(result).toMatchObject({ prewalk: true, mode: "in-place" });
  });

  it("continues research Prewalk in place with the accepted checklist", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "research",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      returnPolicy: "previous",
    });
    const items = Array.from({ length: 5 }, (_, index) => ({
      task: `Change target ${index + 1}`,
      validation: `Run check ${index + 1}`,
    }));
    controller.executionBoundary("session-1")!.registerChecklist({ items });
    expect(controller.isResearchPlanning("session-1")).toBe(true);
    const run = execution();
    run.prewalkBoundary = { ref: "pi.edit", nestedToolCallId: "edit-one" };
    const pending = claimFabricHandoff(controller, run, "session-1", "json");

    expect(pending).toMatchObject({
      kind: "prewalk-research",
      checklist: { items },
      returnPolicy: "executor",
      triggerRef: "pi.edit",
    });

    const host = context();
    const api = extension();
    const result = await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      api.value,
      pending!,
      outerResult(),
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
      mode: "research",
      continued: true,
      model: "anthropic/executor",
    });
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      mode: "research",
      returnPolicy: "executor",
    });
    expect(controller.isResearchPlanning("session-1")).toBe(false);
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
      completedRunner(),
      api.value,
      pending,
      outerResult(),
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

  it("carries the previous Main model through continuation settlement when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      returnPolicy: "previous",
    } as Parameters<PrewalkController["arm"]>[0] & { returnPolicy: "previous" });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      completedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
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

  it("threads the configured fallback models to the in-place executor", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      fallbackModels: ["openai/fallback"],
      sessionId: "session-1",
      task: "Implement the guard",
    } as Parameters<PrewalkController["arm"]>[0] & { fallbackModels: string[] });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending!.fallbackModels).toEqual(["openai/fallback"]);
    const ctx = context();
    const ext = extension();
    const runner = completedRunner();

    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/executor" }),
      expect.anything(),
      expect.anything(),
    );
    expect(result).toMatchObject({ prewalk: true, mode: "in-place", completed: true });
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      model: "anthropic/executor",
      attempt: 1,
    });
  });

  it("blocks a failed in-place continuation without losing task intent", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: false,
        completed: false,
        status: "failed",
        error: "executor authentication failed",
      })),
    };

    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      prewalk: true,
      mode: "in-place",
      completed: false,
      status: "failed",
      error: "executor authentication failed",
    });
    expect(controller.status()).toMatchObject({
      state: "blocked",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      attempt: 1,
      error: "executor authentication failed",
    });
    expect(controller.isArmed("session-1")).toBe(false);
  });

  it("keeps trajectory handoff opt-in and exposes child activity", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending).toMatchObject({
      kind: "prewalk-trajectory",
      audit: { ref: "agents.handoff" },
    });

    const ctx = context();
    const ext = extension();
    let transferredSeed: unknown;
    const runner = {
      executeHandoff: vi.fn(async (_args, invocation, seed) => {
        transferredSeed = seed;
        invocation.activity?.({
          type: "entity",
          id: "child-1",
          kind: "agent",
          name: "Prewalk trajectory executor",
        });
        invocation.update("Agent Prewalk trajectory executor: running · edit");
        invocation.attachPreview?.({ kind: "fabric-agent-tools" });
        return {
          handedOff: true,
          completed: true,
          status: "completed",
          implementation: "implemented",
          agent: { id: "child-1" },
        };
      }),
    };
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      {
        model: "anthropic/executor",
        name: "Prewalk trajectory executor",
        task: "Implement the guard",
      },
      expect.objectContaining({ parentToolCallId: "outer", activity: expect.any(Function) }),
      expect.any(Object),
    );
    expect(transferredSeed).toMatchObject({
      sourceBranch: [
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
      ],
      outerToolResult: { toolCallId: "outer", toolName: "fabric_exec" },
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "entity", id: "child-1" }));
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
    expect(result).toMatchObject({
      prewalk: true,
      mode: "trajectory",
      handedOff: true,
      completed: true,
      implementation: "implemented",
    });
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        display: false,
        content: expect.stringContaining("do not redo it"),
        details: expect.objectContaining({
          mode: "trajectory",
          continuationId: pending!.audit.nestedToolCallId,
        }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      handoffId: pending!.audit.nestedToolCallId,
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuation pending → anthropic/executor",
    );
  });

  it("blocks continuation delivery failure without discarding a completed trajectory", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const ctx = context();
    const ext = extension();
    ext.sendMessage.mockImplementation(() => {
      throw new Error("follow-up queue unavailable");
    });
    const runner: BoundaryHandoffRunner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: true,
        status: "completed",
        implementation: "implemented",
      })),
    };

    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({
      completed: true,
      implementation: "implemented",
      continuationQueued: false,
      continuationError: "follow-up queue unavailable",
    });
    expect(pending.audit.success).toBe(true);
    expect(controller.status()).toMatchObject({
      state: "blocked",
      error: "Prewalk continuation delivery failed: follow-up queue unavailable",
    });
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
      kind: "prewalk-in-place",
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

  it("does not queue the verify continuation after a failed trajectory handoff", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: false,
        status: "failed",
        error: "child crashed",
      })),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({ prewalk: true, mode: "trajectory", completed: false });
    expect(pending!.audit).toMatchObject({ success: false, error: "child crashed" });
    expect(controller.status()).toMatchObject({
      state: "blocked",
      task: "Implement the guard",
      attempt: 1,
      error: "child crashed",
    });
    expect(ext.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-fabric-prewalk-continue" }),
      expect.anything(),
    );
  });

  it("threads the configured thinking level into the trajectory executor args", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      thinking: "high",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending!.args).toMatchObject({ model: "anthropic/executor", thinking: "high" });

    const ctx = context();
    const ext = extension();
    let receivedArgs: Record<string, unknown> | undefined;
    const runner = {
      executeHandoff: vi.fn(async (args) => {
        receivedArgs = args;
        return { handedOff: true, completed: true, status: "completed", implementation: "done" };
      }),
    };
    await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    expect(receivedArgs).toMatchObject({ thinking: "high" });
  });

  it("keeps thinking out of in-place continuation args", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "high",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending!.kind).toBe("prewalk-in-place");
    expect(pending!.args).not.toHaveProperty("thinking");
  });

  it("preserves the thinking level across a re-armed trajectory handoff", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "xhigh",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    await runFabricHandoffAtBoundary(
      controller,
      { executeHandoff: vi.fn(async () => ({ handedOff: true, completed: true, status: "completed" })) },
      extension().value,
      pending!,
      outerResult(),
      context().value,
    );
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      thinking: "xhigh",
      alwaysRearm: true,
    });
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({ settled: true });
    expect(controller.status()).toMatchObject({
      state: "armed",
      thinking: "xhigh",
      alwaysRearm: true,
    });
  });

  it("re-arms after an in-place continuation when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    await runFabricHandoffAtBoundary(
      controller,
      completedRunner(),
      extension().value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      mode: "in-place",
      model: "anthropic/executor",
      alwaysRearm: true,
      task: "Implement the guard",
    });
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({ settled: true });
    expect(controller.status()).toMatchObject({
      state: "armed",
      mode: "in-place",
      model: "anthropic/executor",
      alwaysRearm: true,
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

  it("re-arms after a trajectory handoff when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending).toMatchObject({ kind: "prewalk-trajectory" });

    const ctx = context();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: true,
        status: "completed",
        implementation: "implemented",
      })),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      extension().value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({
      prewalk: true,
      mode: "trajectory",
      completed: true,
      implementation: "implemented",
    });
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      mode: "trajectory",
      model: "anthropic/executor",
      alwaysRearm: true,
      task: "Implement the guard",
    });
    expect(
      withTrajectoryRearmDirective("outer output", pending!, result, controller, "session-1"),
    ).toContain("Prewalk will re-arm");
    expect(
      controller.acceptContinuation("session-1", pending!.audit.nestedToolCallId),
    ).toBe(true);
    expect(controller.settleContinuation("session-1")).toMatchObject({ settled: true });
    expect(controller.status()).toMatchObject({
      state: "armed",
      mode: "trajectory",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuation pending → anthropic/executor",
    );
  });
});

describe("prewalkArmedPrompt", () => {
  it("defines the bounded research protocol before execution", () => {
    const text = prewalkArmedPrompt("research", "anthropic/executor");
    expect(prewalkArmedMessageType("research")).toBe(PREWALK_PLAN_MESSAGE_TYPE);
    expect(text).toContain("anthropic/executor (research)");
    expect(text).toContain("deep, concrete");
    expect(text).toContain("prewalk.checklist");
    expect(text).toContain("5-9");
    expect(text).toContain("validation");
    expect(text).toContain("first successful mutation");
    expect(text).toContain("Do not batch");
    expect(text).toContain("continue the task");
  });

  it("describes the trajectory boundary for Main", () => {
    const text = prewalkArmedPrompt("trajectory", "anthropic/executor");
    expect(text).toContain("anthropic/executor (trajectory)");
    expect(text).toContain("pi.edit / pi.write / schema.commit");
    expect(text).toContain("the executor takes over the implementation there, and a hidden follow-up asks you to verify its work and summarize when it finishes.");
    expect(text).toContain("prewalk.checklist({ items }) call inside fabric_exec with 5-9 ordered items");
    expect(text).toContain("concrete task and a specific validation");
  });

  it("describes in-place continuation for Main", () => {
    const text = prewalkArmedPrompt("in-place", "anthropic/executor");
    expect(text).toContain("this session switches to anthropic/executor and keeps working.");
    expect(text).toContain("prewalk.checklist({ items }) call inside fabric_exec with 5-9 ordered items");
    expect(text).not.toContain("hidden follow-up asks you to verify");
  });
});

const checklistItems = [
  { task: "Change the guard", validation: "Run the guard test" },
  { task: "Update the matching caller", validation: "Run the caller test" },
  { task: "Refresh the docs section", validation: "Read the rendered section" },
  { task: "Run the focused suite", validation: "Confirm every focused test passes" },
  { task: "Check dead code", validation: "Confirm knip reports no unused exports" },
];

const armedWithChecklist = (mode: "in-place" | "trajectory"): PrewalkController => {
  const controller = new PrewalkController();
  controller.arm({
    mode,
    model: "anthropic/executor",
    sessionId: "session-1",
    task: "Implement the guard",
  });
  controller.executionBoundary("session-1")!.registerChecklist({ items: checklistItems });
  return controller;
};

describe("prewalk checklist handoff", () => {
  it("embeds the checklist in the trajectory executor task", () => {
    const controller = armedWithChecklist("trajectory");
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    const task = String((pending.args as { task?: unknown }).task ?? "");
    for (const item of checklistItems) {
      expect(task).toContain(item.task);
      expect(task).toContain(`Validation: ${item.validation}`);
    }
  });

  it("replays the checklist in the in-place continuation message", async () => {
    const controller = armedWithChecklist("in-place");
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json")!;
    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(
      controller,
      completedRunner(),
      ext.value,
      pending,
      outerResult(),
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
  });

  it("keeps a gated revision's feedback over the checklist task for a trajectory arm", () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
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
    expect(revision).toMatchObject({ kind: "prewalk-trajectory", revision: 1 });
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
    const armed = prewalkArmedPrompt("trajectory", "anthropic/executor");
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
    expect(hasPrewalkArmedPrompt(entries, prewalkArmedPrompt("in-place", "other/model"))).toBe(false);
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
  const trajectoryPending = (alwaysRearm: boolean) => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      alwaysRearm,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    return { controller, pending };
  };

  it("appends the directive while a continuous trajectory waits to re-arm", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeHandoff();
    const text = withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1");
    expect(text.startsWith("OUTPUT\n\n")).toBe(true);
    expect(text).toContain("result above is final");
    expect(text).toContain("pi.edit / pi.write in fabric_exec to hand off again");
    expect(text).toContain("keep any fixes scoped to what verification fails.");
  });

  it("omits the directive for in-place pendings", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    expect(pending.kind).toBe("prewalk-in-place");
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the handoff failed", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: false }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm was one-shot", () => {
    const { controller, pending } = trajectoryPending(false);
    controller.completeHandoff();
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      alwaysRearm: false,
    });
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm belongs to another session", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeHandoff();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-2")).toBe("OUTPUT");
  });
});
