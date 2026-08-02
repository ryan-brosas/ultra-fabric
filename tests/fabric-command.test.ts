import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  prewalkArmedPrompt,
} from "../src/prewalk/handoff.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import type { FabricUiController } from "../src/ui/controller.js";

describe("/fabric command", () => {
  it("opens the dashboard when invoked without arguments", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: {
            handler: (argumentsText: string, context: ExtensionContext) => Promise<void>;
          },
        ) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricState;
    const fabricUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricUiController;
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    expect(handler).toBeDefined();

    await handler!("", context);

    expect(state.ensure).toHaveBeenCalledWith(context);
    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
  });

  it("arms prewalk with the configured executor and submits an inline task", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage,
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: {
          mode: "in-place",
          model: "anthropic/executor",
          verificationMode: "gated",
          maxPhaseRevisions: 3,
        },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    await handler!("prewalk Implement the token guard", context);

    expect(arm).toHaveBeenCalledWith({
      model: "anthropic/executor",
      mode: "in-place",
      sessionId: "session-1",
      task: "Implement the token guard",
      verificationMode: "gated",
      maxPhaseRevisions: 3,
    });
    expect(sendUserMessage).toHaveBeenCalledWith("Implement the token guard");
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "anthropic/executor"),
        display: false,
        details: { mode: "in-place", model: "anthropic/executor" },
      },
      { deliverAs: "nextTurn" },
    );
    // Advisory framing lands in the queue before the task submission.
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("retries a blocked prewalk with its preserved task", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const pi = {
      sendUserMessage,
      sendMessage: vi.fn(),
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const prewalk = new PrewalkController();
    prewalk.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the token guard",
    });
    prewalk.claim(
      [{
        ref: "pi.edit",
        nestedToolCallId: "edit-1",
        startedAt: 1,
        endedAt: 2,
        success: true,
      }],
      "session-1",
    );
    prewalk.failHandoff("temporary provider failure");
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk,
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    await handler!("prewalk --status", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      [
        "Fabric prewalk blocked (in-place) → anthropic/executor",
        "Task: Implement the token guard",
        "Error: temporary provider failure",
        "Run /fabric prewalk --retry to resume this task.",
      ].join("\n"),
      "info",
    );
    vi.mocked(context.ui.notify).mockClear();

    await handler!("prewalk --retry", context);

    expect(prewalk.status()).toMatchObject({
      state: "armed",
      task: "Implement the token guard",
      attempt: 1,
    });
    expect(prewalk.status()).not.toHaveProperty("error");
    expect(sendUserMessage).toHaveBeenCalledWith("Implement the token guard");
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Fabric prewalk retry armed with preserved task",
      "info",
    );
  });

  it("uses the model picker when prewalk has no configured executor", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage: vi.fn(),
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const select = vi.fn().mockResolvedValue("openai/executor");
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      hasUI: true,
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "executor" },
          { provider: "anthropic", id: "other" },
        ],
      },
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { select, setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    await handler!("prewalk", context);

    expect(select).toHaveBeenCalledWith("Prewalk executor model", [
      "anthropic/other",
      "openai/executor",
    ]);
    expect(arm).toHaveBeenCalledWith({
      model: "openai/executor",
      mode: "in-place",
      sessionId: "session-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "openai/executor"),
        display: false,
      }),
      { deliverAs: "nextTurn" },
    );
  });

  it("skips the armed prompt when the identical one already persists", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage: vi.fn(),
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "trajectory", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [
          {
            type: "custom_message",
            customType: PREWALK_ARMED_MESSAGE_TYPE,
            content: prewalkArmedPrompt("trajectory", "anthropic/executor"),
          },
        ],
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    await handler!("prewalk", context);

    expect(arm).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });


  const registerWith = (state: FabricState) => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    let complete: ((prefix: string) => Array<{ value: string }> | null) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: {
        handler: typeof handler;
        getArgumentCompletions?: typeof complete;
      }) => {
        handler = definition.handler;
        complete = definition.getArgumentCompletions;
      }),
    } as unknown as ExtensionAPI;
    registerFabricCommand(pi, {
      state,
      fabricUi: { openDashboard: vi.fn() } as unknown as FabricUiController,
      capturedTools: { size: 0, list: () => [] } as unknown as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    const notify = vi.fn();
    const context = { ui: { notify, setStatus: vi.fn() } } as unknown as ExtensionContext;
    return {
      run: (args: string) => handler!(args, context),
      complete: (prefix = "") => complete?.(prefix) ?? [],
      notify,
    };
  };

  it("shows both Agent lifecycles in the sole live inventory", async () => {
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      agents: {
        list: () => [{
          id: "agent-12345678",
          status: "running",
          runner: "pi",
          transport: "process",
          name: "review-run",
        }],
      },
      persistentAgents: {
        list: () => [{
          id: "persistentAgent-12345678",
          status: "idle",
          runner: "claude",
          queued: 2,
          name: "reviewer",
        }],
      },
    } as unknown as FabricState;
    const { run, complete, notify } = registerWith(state);

    expect(complete().map((item) => item.value)).toContain("agents");
    expect(complete().map((item) => item.value)).not.toContain("persistentAgents");

    await run("agents");
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/one-shot.*review-run[\s\S]*persistent.*reviewer/),
      "info",
    );

    await run("persistentAgents");
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Usage: /fabric"),
      "warning",
    );
  });

  it("lists active path leases and force-releases them for the operator", async () => {
    const forceRelease = vi.fn().mockResolvedValue({ released: ["lease-1"] });
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { mesh: { enabled: true } },
      pathLeases: {
        forceRelease,
        list: vi.fn().mockResolvedValue([
          {
            id: "lease-1234",
            ownerRunId: "run-a",
            path: "/repo/src",
            scope: "tree",
            acquiredAt: 0,
            expiresAt: Date.now() + 30_000,
          },
        ]),
      },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("leases");
    expect(notify.mock.calls[0]![0]).toContain("/repo/src");
    expect(notify.mock.calls[0]![0]).toContain("run-a");

    await run("leases --release-all");
    expect(forceRelease).toHaveBeenCalledWith(undefined);
    expect(notify.mock.calls[1]![0]).toContain("lease-1");

    await run("leases --release lease-1234");
    expect(forceRelease).toHaveBeenLastCalledWith(["lease-1234"]);
  });

  it("reports an unreadable lease store instead of failing the command", async () => {
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { mesh: { enabled: true } },
      pathLeases: {
        list: vi.fn().mockRejectedValue(new Error("Invalid path lease state; run /fabric leases --release-all to reset it")),
        forceRelease: vi.fn(),
      },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("leases");

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("--release-all"), "error");
  });

  it("ranks outcome recommendations and names pending candidates", async () => {
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { outcomes: { enabled: true } },
      outcomes: {
        summary: () => ({ records: 9, succeeded: 8, verified: 7, downgraded: 1, evaluated: 5 }),
        recommend: vi.fn().mockResolvedValue({
          status: "recommended",
          minimumSamples: 5,
          recommendedModel: "p/a",
          candidates: [
            {
              model: "p/a",
              samples: 6,
              successRate: 1,
              successConfidence: { low: 0.61, high: 1 },
              verifiedRate: 0.5,
              verifiedConfidence: { low: 0.19, high: 0.81 },
              averageDurationMs: 1_200,
              averageTokens: 100,
              averageCost: 0.0125,
              downgradeRate: 0,
              admissionReasons: { separable_parallel: 6 },
              averageScore: 0.9,
            },
          ],
          excluded: [{ model: "p/b", samples: 2, reason: "insufficient_samples" }],
        }),
      },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("outcomes");

    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain("9 records");
    expect(message).toContain("★ p/a");
    expect(message).toContain("50% verified [19%-81%]");
    expect(message).toContain("score 0.90");
    expect(message).toContain("p/b: needs 3 more sample(s)");
    expect(message).toContain("Advisory only");
  });

  it("declines outcome reporting when recording is disabled", async () => {
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { outcomes: { enabled: false } },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("outcomes");

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "warning");
  });

  it("summarizes runtime health across persistentAgents, QoS, outcomes, and leases", async () => {
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { outcomes: { enabled: true }, mesh: { enabled: true } },
      contextQosTelemetry: { passes: 3, retiredResults: 4, retiredChars: 900, protectedResults: 2 },
      persistentAgents: {
        telemetry: () => ({
          persistentAgents: 2,
          open: 1,
          lifetimeExhausted: 0,
          windowExhausted: 1,
          lifetimeActivations: 12,
          lifetimeTokens: 500,
          rejectedActivations: 3,
          queueRejected: 1,
          activationDeadLetters: 2,
          deliveryDeadLetters: 0,
        }),
      },
      outcomes: {
        summary: () => ({ records: 4, succeeded: 4, verified: 3, downgraded: 1, evaluated: 2 }),
      },
      pathLeases: { list: vi.fn().mockResolvedValue([{ id: "l1" }]) },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("health");

    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain("3 rejected");
    expect(message).toContain("2 activation");
    expect(message).toContain("4 retired results");
    expect(message).toContain("3 verified");
    expect(message).toContain("1 active");
  });

  it("reports the live policy surface in status", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.agents.requireAdmissionIntent = true;
    config.agents.capabilityProfiles = { inspect: { tools: ["read"], risks: ["read"] } };
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      cwd: "/repo",
      config,
      registry: { providers: () => [{ name: "pi", description: "Pi core" }] },
      prewalk: { status: () => ({ state: "idle" as const }) },
      persistentAgents: { list: () => [] },
      mesh: { root: "/repo/.pi/fabric/mesh" },
    } as unknown as FabricState;
    const { run, notify } = registerWith(state);

    await run("status");

    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain("admission: required");
    expect(message).toContain("profiles: inspect");
    expect(message).toContain("quality downgrade: blocked");
    expect(message).toContain("prewalk triggers: effects [workspace]");
    expect(message).toContain("pi.edit, pi.write, schema.commit");
    expect(message).toContain("outcomes: on");
    expect(message).toContain("context QoS: on");
  });
});
