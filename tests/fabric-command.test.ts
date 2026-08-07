import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      sessionId: "session-1",
      task: "Implement the token guard",
      verificationMode: "gated",
      maxPhaseRevisions: 3,
    });
    expect(sendUserMessage).toHaveBeenCalledWith("Implement the token guard");
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("anthropic/executor"),
        display: false,
        details: { model: "anthropic/executor" },
      },
      { deliverAs: "nextTurn" },
    );
    // Advisory framing lands in the queue before the task submission.
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0]!,
    );

        sendMessage.mockClear();
    await handler!("prewalk Research the token guard", context);
    expect(arm).toHaveBeenLastCalledWith(expect.objectContaining({
      task: "Research the token guard",
    }));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("anthropic/executor"),
        display: false,
      }),
      { deliverAs: "nextTurn" },
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
        prewalk: { model: "anthropic/executor" },
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
        "Fabric prewalk blocked → anthropic/executor",
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
        prewalk: {},
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
      sessionId: "session-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("openai/executor"),
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
        prewalk: { model: "anthropic/executor" },
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
            content: prewalkArmedPrompt("anthropic/executor"),
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
          transport: "process",
          name: "review-run",
        }],
      },
      persistentAgents: {
        list: () => [{
          id: "persistentAgent-12345678",
          status: "idle",
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

  it("init copies legacy .pi context to root and reports the copy in notify", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-"));
    mkdirSync(join(scratch, ".pi"), { recursive: true });
    writeFileSync(join(scratch, ".pi", "project.md"), "# legacy project context\n");
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (_name: string, definition: { handler: typeof handler }) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const context = { cwd: scratch, ui: { notify } } as unknown as ExtensionContext;
    registerFabricCommand(pi, {
      state: { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as FabricState,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    await handler!("init", context);
    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain("copied (legacy .pi to root): project.md");
    expect(message).not.toContain("copies its content");
    const createdLine = message.split("\n").find((line) => line.startsWith("created:"));
    expect(createdLine).not.toContain("project.md");
    expect(readFileSync(join(scratch, "project.md"), "utf8")).toBe("# legacy project context\n");
    rmSync(scratch, { recursive: true, force: true });
  });

  const initHarness = (scratch: string, ui: Record<string, unknown>, agents?: unknown) => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (_name: string, definition: { handler: typeof handler }) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    registerFabricCommand(pi, {
      state: { ensure: vi.fn().mockResolvedValue(undefined), ...(agents ? { agents } : {}) } as unknown as FabricState,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    const context = { cwd: scratch, ui } as unknown as ExtensionContext;
    return { handler: handler!, context };
  };

  it("init asks about a greenfield project and threads answers into the scaffold", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-green-"));
    const input = vi
      .fn()
      .mockResolvedValueOnce("acme-billing")
      .mockResolvedValueOnce("Invoicing service for the Acme storefront");
    const { handler, context } = initHarness(scratch, { notify: vi.fn(), input });
    await handler("init", context);
    expect(input).toHaveBeenCalledTimes(2);
    const agents = readFileSync(join(scratch, "AGENTS.md"), "utf8");
    expect(agents).toContain("acme-billing — Invoicing service for the Acme storefront");
    const project = readFileSync(join(scratch, "project.md"), "utf8");
    expect(project).toContain("# Project: acme-billing");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init falls back to placeholders when the greenfield dialog is dismissed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-dismiss-"));
    const input = vi.fn().mockResolvedValue(undefined);
    const { handler, context } = initHarness(scratch, { notify: vi.fn(), input });
    await handler("init", context);
    const agents = readFileSync(join(scratch, "AGENTS.md"), "utf8");
    expect(agents).toContain("<One or two sentences");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init skips the wizard when the project already has a manifest", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-existing-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", dependencies: {} }));
    const input = vi.fn();
    const { handler, context } = initHarness(scratch, { notify: vi.fn(), input });
    await handler("init", context);
    expect(input).not.toHaveBeenCalled();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init asks users and success via select on a greenfield project", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-select-"));
    const input = vi
      .fn()
      .mockResolvedValueOnce("acme-billing")
      .mockResolvedValueOnce("Invoicing service for the Acme storefront");
    const select = vi
      .fn()
      .mockResolvedValueOnce("End users")
      .mockResolvedValueOnce("Stability")
      .mockResolvedValueOnce("Write all");
    const { handler, context } = initHarness(scratch, { notify: vi.fn(), input, select });
    await handler("init", context);
    expect(select).toHaveBeenCalledTimes(3);
    const project = readFileSync(join(scratch, "project.md"), "utf8");
    expect(project).toContain("Primary users: End users");
    expect(project).toContain("Success priority: Stability");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init preview confirm: Cancel aborts before any write", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-cancel-"));
    const input = vi
      .fn()
      .mockResolvedValueOnce("acme-billing")
      .mockResolvedValueOnce("Invoicing service for the Acme storefront");
    const select = vi
      .fn()
      .mockResolvedValueOnce("End users")
      .mockResolvedValueOnce("Stability")
      .mockResolvedValueOnce("Cancel");
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify, input, select });
    await handler("init", context);
    expect(existsSync(join(scratch, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(scratch, ".pi", "fabric.json"))).toBe(false);
    expect(notify.mock.calls[0]![0] as string).toContain("cancelled");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init refreshes tech-stack.md when confirmed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-regen-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    writeFileSync(join(scratch, "tech-stack.md"), "OLD CONTENT");
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify, confirm });
    await handler("init", context);
    expect(confirm).toHaveBeenCalledTimes(1);
    const stack = readFileSync(join(scratch, "tech-stack.md"), "utf8");
    expect(stack).toContain("JavaScript");
    expect(stack).not.toContain("OLD CONTENT");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init keeps an existing tech-stack.md when the refresh is declined", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-keep-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    writeFileSync(join(scratch, "tech-stack.md"), "OLD CONTENT");
    const confirm = vi.fn().mockResolvedValue(false);
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify, confirm });
    await handler("init", context);
    expect(readFileSync(join(scratch, "tech-stack.md"), "utf8")).toBe("OLD CONTENT");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init notify includes next-step guidance", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-next-"));
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify, input: vi.fn().mockResolvedValue(undefined) });
    await handler("init", context);
    expect(notify.mock.calls[0]![0] as string).toContain("/fabric prewalk");
    rmSync(scratch, { recursive: true, force: true });
  });

  const fakeAgents = (brief: string) => ({
    spawn: vi.fn().mockResolvedValue({ id: "r1" }),
    wait: vi.fn().mockResolvedValue({ text: brief, status: "completed" }),
  });

  it("init runs the deep analysis on brownfield and writes the brief into project.md", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-deep-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    const agents = fakeAgents("src/ — core logic\nlib/ — shared utils\nSummary: A and B");
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify }, agents);
    await handler("init", context);
    expect(agents.spawn).toHaveBeenCalledTimes(1);
    expect(agents.spawn.mock.calls[0]![0].role).toBe("explorer");
    const project = readFileSync(join(scratch, "project.md"), "utf8");
    expect(project).toContain("src/ — core logic");
    expect(project).not.toContain("<The main components, how they relate");
    expect(notify.mock.calls[0]![0] as string).toContain("deep analysis: done");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("init skips the deep analysis when agents are unavailable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-nodeep-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    const notify = vi.fn();
    const { handler, context } = initHarness(scratch, { notify });
    await handler("init", context);
    expect(notify.mock.calls[0]![0] as string).toContain("deep analysis: skipped");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("deep analysis never touches files that pre-existed the run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fabric-init-guard-"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    writeFileSync(join(scratch, "AGENTS.md"), "# AGENTS.md\n\n## Architecture & layout\n\n<Where the important code lives and how the pieces relate.>\n");
    const agents = fakeAgents("lib/ — maps the place");
    const { handler, context } = initHarness(scratch, { notify: vi.fn() }, agents);
    await handler("init", context);
    const agentsFile = readFileSync(join(scratch, "AGENTS.md"), "utf8");
    expect(agentsFile).toContain("<Where the important code lives and how the pieces relate.>");
    expect(agentsFile).not.toContain("lib/ — maps the place");
    rmSync(scratch, { recursive: true, force: true });
  });
});
