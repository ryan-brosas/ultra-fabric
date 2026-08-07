import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentAgentRuntime } from "../src/agents/persistent/manager.js";
import type { FabricPersistentAgentRequest } from "../src/agents/persistent/types.js";
import { AgentTemplateRegistry } from "../src/agents/persistent/template-registry.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type {
  FabricLifecycleEvent,
  FabricLifecycleSubscription,
} from "../src/lifecycle/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type {
  FabricParticipantInfo,
  FabricParticipantSource,
  FabricPeerInfo,
} from "../src/topology/types.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { snapshotHandoffSession } from "./support/handoff-seed.js";
import { AgentManager } from "../src/agents/manager.js";

const roots: string[] = [];
const persistentAgentManagers: PersistentAgentRuntime[] = [];
const agentManagers: AgentManager[] = [];

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
  activity() {},
};

const setup = (
  peers: FabricPeerInfo[] = [],
  members: FabricParticipantInfo[] = [],
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-agents-provider-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const agents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, "runs"),
  });
  agentManagers.push(agents);
  const identity: MeshIdentity = {
    id: "session:test",
    name: "main",
    kind: "main",
    sessionId: "test",
  };
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 };
  const mainDeliveries: FabricMainAgentDeliveryRequest[] = [];
  const mainAgent = {
    id: identity.id,
    local: true,
    matches: (id: string) => id === "main" || id === identity.id,
    info: () => ({
      id: identity.id,
      name: "Main" as const,
      kind: "main" as const,
      status: mainAgent.local ? "idle" as const : "remote" as const,
      runner: "pi" as const,
      transport: "host" as const,
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: mainAgent.local,
    }),
    deliverAgent: (request: FabricMainAgentDeliveryRequest) => {
      mainDeliveries.push(request);
      return {
        queued: true as const,
        messageId: `main-message-${mainDeliveries.length}`,
        routed: "main" as const,
      };
    },
  };
  const persistentAgents = new PersistentAgentRuntime("test", identity, mesh, meshConfig, agents, () => {}, {
    persistentAgentRoot: path.join(root, "persistentAgents"),
    persistent: true,
    mainAgent,
  });
  persistentAgentManagers.push(persistentAgents);
  const agentTemplates = new AgentTemplateRegistry(root, 64 * 1024);
  const participants: FabricParticipantSource = {
    list: (options = {}) =>
      members.filter(
        (participant) =>
          (!options.kinds || options.kinds.includes(participant.kind)) &&
          (options.scope !== "local" || participant.local) &&
          (options.scope !== "lineage" || participant.rootId === identity.id),
      ),
    get: (id) => members.find((participant) => participant.id === id),
    self: () => ({
      format: 1,
      id: identity.id,
      kind: "root",
      rootId: identity.id,
      ownerHostId: identity.id,
      ownerIdentityId: identity.id,
      name: "main",
      status: "idle",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      controlProtocol: "v1",
      local: true,
      stale: false,
    }),
    peers: () => peers,
    async refresh() {},
    scheduleRefresh() {},
  };
  let provider: AgentsProvider;
  const lifecycle = new LifecycleBroker(
    mesh,
    identity,
    participants,
    { enabled: true, pollMs: 20, maxReadEvents: 100 },
    async (subscription, event) => provider.deliverLifecycle(subscription, event),
  );
  agents.attachPersistentLifecycle(persistentAgents, agentTemplates);
  provider = new AgentsProvider(
    agents,
    mainAgent,
    participants,
    undefined,
    lifecycle,
  );
  return { root, persistentAgents, agents, agentTemplates, provider, mainDeliveries };
};

afterEach(async () => {
  await Promise.all(persistentAgentManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(agentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for persistentAgent state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const createRequest = {
  name: "reviewer",
  instructions: "Review code for security defects and reply concisely.",
  events: ["turn_end"],
  delivery: "steer",
  responseMode: "directive",
  triggerTurn: false,
};

describe("AgentsProvider runner support", () => {
  it("lists live peer sessions separately from Main", async () => {
    const peer: FabricPeerInfo = {
      id: "session:peer",
      name: "Peer peer",
      kind: "peer",
      status: "idle",
      transport: "host",
      cwd: process.cwd(),
      sessionId: "peer",
      startedAt: 1,
      updatedAt: 2,
      pendingMessages: false,
      local: false,
    };
    const { provider } = setup([peer]);

    await expect(provider.invoke("peers", {}, context)).resolves.toEqual([peer]);
    expect((await provider.describe("peers", context))?.risk).toBe("read");
  });

  it("creates, lists, and removes source-qualified lifecycle subscriptions", async () => {
    const target: FabricParticipantInfo = {
      format: 1,
      id: "session:test",
      kind: "root",
      rootId: "session:test",
      ownerHostId: "session:test",
      ownerIdentityId: "session:test",
      name: "main",
      status: "idle",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      controlProtocol: "v1",
      local: true,
      stale: false,
    };
    const source: FabricParticipantInfo = {
      ...target,
      id: "session:peer",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      name: "Peer peer",
      sessionId: "peer",
      local: false,
    };
    const { provider } = setup([], [target, source]);

    const subscription = await provider.invoke(
      "subscribe",
      {
        from: source.id,
        events: ["pi.agent_settled"],
        delivery: "followUp",
        triggerTurn: false,
        once: true,
      },
      context,
    ) as { id: string };

    await expect(provider.invoke("subscriptions", { to: "main" }, context)).resolves.toEqual([
      expect.objectContaining({
        id: subscription.id,
        from: source.id,
        to: target.id,
        events: ["pi.agent_settled"],
        triggerTurn: false,
        once: true,
      }),
    ]);
    await expect(
      provider.invoke("unsubscribe", { id: subscription.id }, context),
    ).resolves.toEqual({ removed: true });
    expect((await provider.describe("subscribe", context))?.risk).toBe("agent");
  });

  it("delivers lifecycle envelopes to Main with source identity and passive policy", async () => {
    const { provider, mainDeliveries } = setup();
    const subscription: FabricLifecycleSubscription = {
      format: 1,
      id: "subscription-1",
      from: "session:peer",
      events: ["pi.agent_settled"],
      to: "session:test",
      delivery: "followUp",
      triggerTurn: false,
      once: false,
      afterSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      createdBy: { id: "session:test", name: "main", kind: "main" },
    };
    const event: FabricLifecycleEvent = {
      version: 1,
      id: "event-1",
      sequence: 1,
      event: "pi.agent_settled",
      source: {
        id: "session:peer",
        name: "Peer peer",
        kind: "root",
        rootId: "session:peer",
      },
      occurredAt: 2,
      publishedAt: 3,
    };

    await provider.deliverLifecycle(subscription, event);

    expect(mainDeliveries).toEqual([
      expect.objectContaining({
        from: { id: "session:peer", name: "Peer peer", kind: "main" },
        delivery: "followUp",
        triggerTurn: false,
        data: event,
      }),
    ]);
  });

  it("rejects remote Main delivery after its capabilities are withdrawn", async () => {
    const remoteRoot: FabricParticipantInfo = {
      format: 1,
      id: "session:test",
      kind: "root",
      rootId: "session:test",
      ownerHostId: "session:test",
      ownerIdentityId: "session:test",
      name: "main",
      status: "idle",
      transport: "host",
      capabilities: [],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 2,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const { provider } = setup([], [remoteRoot]);
    (provider.mainAgent as { local: boolean }).local = false;

    await expect(provider.invoke("status", { id: "main" }, context)).resolves.toMatchObject({
      id: remoteRoot.id,
      kind: "main",
      status: "remote",
      local: false,
    });
    await expect(
      provider.routeMessage("main", "too late", undefined, "steer"),
    ).rejects.toThrow(
      "does not support steer",
    );
  });

  it("projects remote agents through members, scoped list, and status", async () => {
    const remote: FabricParticipantInfo = {
      format: 1,
      id: "agent:remote",
      kind: "agent",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: "remote reviewer",
      status: "running",
      transport: "process",
      capabilities: ["steer", "followUp", "stop"],
      cwd: process.cwd(),
      startedAt: 1,
      updatedAt: 2,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const { provider } = setup([], [remote]);

    await expect(
      provider.invoke("members", { scope: "project" }, context),
    ).resolves.toEqual([expect.objectContaining({ id: remote.id, kind: "agent", lifecycle: "one-shot" })]);
    await expect(
      provider.invoke("list", { scope: "project" }, context),
    ).resolves.toEqual([expect.objectContaining({ id: remote.id, kind: "agent", lifecycle: "one-shot" })]);
    await expect(
      provider.invoke("status", { id: remote.id }, context),
    ).resolves.toEqual(expect.objectContaining({ id: remote.id, kind: "agent", lifecycle: "one-shot" }));
    await expect(
      provider.invoke("list", { scope: "lineage" }, context),
    ).resolves.toEqual([]);
  });

  it("projects remote persistent agents through lifecycle-aware scope", async () => {
    const remote: FabricParticipantInfo = {
      format: 1,
      id: "persistent:remote",
      kind: "persistentAgent",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: "remote advisor",
      status: "idle",
      transport: "host",
      capabilities: ["steer", "followUp"],
      startedAt: 1,
      updatedAt: 2,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const { provider } = setup([], [remote]);

    await expect(
      provider.invoke("list", { scope: "project", lifecycle: "persistent" }, context),
    ).resolves.toEqual([
      expect.objectContaining({ id: remote.id, kind: "agent", lifecycle: "persistent" }),
    ]);
    await expect(
      provider.invoke("members", { scope: "project", kinds: ["agent"] }, context),
    ).resolves.toEqual([
      expect.objectContaining({ id: remote.id, kind: "agent", lifecycle: "persistent" }),
    ]);
    await expect(
      provider.invoke("list", { scope: "lineage", lifecycle: "persistent" }, context),
    ).resolves.toEqual([]);
  });

  it("exposes one Agent contract across lifecycles and roles", async () => {
    const { provider } = setup();
    const persistent = await provider.invoke(
      "create",
      { ...createRequest, role: "supervisor" },
      context,
    ) as { id: string; name: string };

    await expect(provider.invoke("list", {}, context)).resolves.toEqual([]);
    await expect(provider.invoke("list", { lifecycle: "persistent" }, context)).resolves.toEqual([
      expect.objectContaining({
        id: persistent.id,
        kind: "agent",
        lifecycle: "persistent",
        role: "supervisor",
        name: "reviewer",
      }),
    ]);
    await expect(provider.invoke("list", { lifecycle: "all" }, context)).resolves.toEqual([
      expect.objectContaining({ id: persistent.id, lifecycle: "persistent", role: "supervisor" }),
    ]);
    await expect(
      provider.invoke("list", { scope: "project", lifecycle: "persistent" }, context),
    ).resolves.toEqual([
      expect.objectContaining({ id: persistent.id, lifecycle: "persistent", role: "supervisor" }),
    ]);
    await expect(provider.invoke("status", { id: persistent.id }, context)).resolves.toMatchObject({
      id: persistent.id,
      kind: "agent",
      lifecycle: "persistent",
      role: "supervisor",
      validWhile: {
        version: 1,
        source: expect.stringContaining("activation.mainRevision === current.mainRevision"),
      },
      name: "reviewer",
    });

    await provider.invoke(
      "create",
      { ...createRequest, name: "global-reviewer", role: "advisor", scope: "global" },
      context,
    );
    await expect(provider.invoke("templates", {}, context)).resolves.toEqual([
      expect.objectContaining({ name: "global-reviewer", role: "advisor" }),
    ]);

    const catalog = await provider.invoke("roles", { lifecycle: "persistent" }, context) as {
      roles: Array<Record<string, unknown>>;
      diagnostics: string[];
    };
    expect(catalog.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "supervisor",
        lifecycle: "persistent",
        delivery: "steer",
        responseMode: "directive",
        triggerTurn: true,
        freshness: "latest-main-revision",
        turnBudget: { maxTurns: 4, graceTurns: 1 },
      }),
    ]));
    expect(catalog.roles.every((role) => !("behavior" in role))).toBe(true);
    expect(catalog.diagnostics).toEqual([]);

    const discovered = await provider.list({}, context);
    expect(discovered.map((descriptor) => descriptor.name)).toContain("roles");
    expect(discovered.map((descriptor) => descriptor.name)).toContain("templates");
    expect(discovered.map((descriptor) => descriptor.name)).toContain("telemetry");
    expect(JSON.stringify(discovered)).not.toMatch(/persistentAgent/i);
    await expect(provider.invoke("telemetry", {}, context)).resolves.toMatchObject({ persistent: 1 });
    for (const removed of ["persistentAgentStatus", "persistentAgents", "persistentAgentTelemetry"]) {
      await expect(provider.describe(removed, context)).resolves.toBeUndefined();
      await expect(provider.invoke(removed, {}, context)).rejects.toThrow("Unknown agents action");
    }
    await expect(
      provider.invoke(
        "create",
        { ...createRequest, name: "invalid-role", role: "not a role!" },
        context,
      ),
    ).rejects.toThrow("Invalid Fabric agent role");
  });

  it("defers explicit handoff until the finalized outer Fabric result", async () => {
    const { provider, root } = setup();
    const source = SessionManager.create(process.cwd(), path.join(root, "source-session"));
    source.appendMessage({
      role: "user",
      content: "Implement the rare token guard 43117",
      timestamp: 1,
    });
    source.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I found the guard and am completing the full program." },
        {
          type: "toolCall",
          id: context.parentToolCallId,
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); return 'verified';",
          },
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "frontier",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    const updates: string[] = [];
    let deferredRequest: Record<string, unknown> | undefined;
    const handoffContext: FabricInvocationContext = {
      ...context,
      extensionContext: {
        sessionManager: source,
        model: { provider: "anthropic", id: "frontier" },
      } as unknown as ExtensionContext,
      update(message) {
        updates.push(message);
      },
      deferHandoff(args) {
        deferredRequest = structuredClone(args);
        return {
          scheduled: true,
          status: "deferred",
          boundary: "fabric_exec_end",
        };
      },
    };
    const args = {
      model: "anthropic/executor",
      task: "Finish the implementation and verify it.",
      transport: "process",
    };

    await expect(provider.invoke("handoff", args, handoffContext)).resolves.toMatchObject({
      status: "deferred",
      boundary: "fabric_exec_end",
    });
    expect(deferredRequest).toEqual(args);
    expect(fs.existsSync(path.join(root, "runs"))).toBe(false);

    const outerToolResult = {
      role: "toolResult" as const,
      toolCallId: context.parentToolCallId,
      toolName: "fabric_exec",
      content: [{ type: "text" as const, text: "verified after every nested call" }],
      details: { success: true },
      isError: false,
      timestamp: 3,
    };
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      outerToolResult,
      context.parentToolCallId,
    );
    const result = (await provider.executeHandoff(
      deferredRequest!,
      handoffContext,
      seed,
    )) as {
      handedOff: boolean;
      completed: boolean;
      status: string;
      implementation: string;
      agent: { id: string; model: string };
    };

    expect(result).toMatchObject({
      handedOff: true,
      completed: true,
      status: "completed",
      implementation: "fake worker complete",
      agent: { model: "anthropic/executor" },
    });
    expect(updates).toContainEqual(expect.stringContaining("caller is waiting"));
    expect(updates).toContainEqual(expect.stringContaining("completed implementation"));
    const task = fs.readFileSync(
      path.join(root, "runs", result.agent.id, "task.txt"),
      "utf8",
    );
    expect(task).toContain("inherited conversation trajectory");
    expect(task).toContain("Finish the implementation and verify it.");
    const handoffDirectory = path.join(root, "runs", result.agent.id, "handoff-session");
    const [sessionName] = fs.readdirSync(handoffDirectory);
    const seededSession = SessionManager.open(path.join(handoffDirectory, sessionName!));
    const seededMessages = seededSession.buildSessionContext().messages;
    expect(JSON.stringify(seededMessages)).toContain("Implement the rare token guard 43117");
    expect(seededMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(seededMessages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "toolCall",
          name: "fabric_exec",
          id: context.parentToolCallId,
        }),
      ]),
    });
    expect(seededMessages[2]).toEqual(outerToolResult);
    expect(seededSession.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
  });

  it("requires an explicit target model for handoff", async () => {
    const { provider, root } = setup();
    const source = SessionManager.inMemory(root);
    const handoffContext = {
      ...context,
      extensionContext: { sessionManager: source } as unknown as ExtensionContext,
    };
    await expect(provider.invoke("handoff", {}, handoffContext)).rejects.toThrow(
      /requires an explicit Pi target model/,
    );
    const descriptor = await provider.describe("handoff", handoffContext);
    expect(descriptor?.risk).toBe("agent");
    const schema = descriptor?.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["model"]);
    expect(schema.properties).toHaveProperty("task");
    expect(schema.properties).not.toHaveProperty("when");
    expect(schema.properties).not.toHaveProperty("checkpoint");
  });

  it("propagates the invocation trace into child records", async () => {
    const { provider } = setup();
    const tracedContext: FabricInvocationContext = {
      ...context,
      run: {
        version: 1,
        runId: "fabric-run",
        traceId: "trace-root",
        spanId: "fabric-span",
        objectiveDigest: "digest",
        startedAt: 1,
        deadline: 10_000,
        cancellationOwner: "fabric-run",
      },
    };

    const result = await provider.invoke(
      "run",
      { task: "return a short result", name: "traced-agent", transport: "process" },
      tracedContext,
    );

    expect(result).toMatchObject({
      traceId: "trace-root",
      spanId: expect.any(String),
      parentRunId: "fabric-run",
      parentSpanId: "fabric-span",
    });
  });

  it("attaches a structured child-tool preview to blocking agent runs", async () => {
    const { provider } = setup();
    const previews: unknown[] = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview);
      },
    };

    await provider.invoke(
      "run",
      { task: "return a short result", name: "preview-agent", transport: "process" },
      previewContext,
    );

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      name: "preview-agent",
      status: "completed",
      owner: "agent",
      text: "fake worker complete",
      tools: expect.any(Array),
    });
  });

  it("refreshes bounded agent previews when only the transcript changes", async () => {
    const { provider } = setup();
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };

    await provider.invoke(
      "run",
      { task: "STREAM_PREVIEW", name: "stream-preview-agent", transport: "process" },
      previewContext,
    );

    const liveTools = previews
      .filter((preview) => preview.status === "running")
      .flatMap((preview) => preview.tools as Array<{ label?: string; toolName?: string }> ?? []);
    expect(liveTools.some((tool) => (tool.toolName ?? tool.label) === "read")).toBe(true);
    expect(liveTools.some((tool) => (tool.toolName ?? tool.label) === "bash")).toBe(true);
    expect(previews.length).toBeLessThanOrEqual(4);
  }, 10_000);

  it("attaches previews and reports friendly names while waiting for spawned agents", async () => {
    const { provider } = setup();
    const updates: string[] = [];
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      update(message) {
        updates.push(message);
      },
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };
    const handle = await provider.invoke(
      "spawn",
      { task: "return a short result", name: "wait-preview-agent", transport: "process" },
      previewContext,
    ) as { id: string; name: string };

    await provider.invoke("wait", { id: handle.id }, previewContext);

    expect(updates.some((message) => message.startsWith("Agent wait-preview-agent:"))).toBe(true);
    expect(updates.join("\n")).not.toContain(handle.id.slice(0, 8));
    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      id: handle.id,
      name: "wait-preview-agent",
      status: "completed",
      owner: "agent",
    });
  });

  it("propagates direct persistentAgent activation lineage into the child run", async () => {
    const { provider, agents } = setup();
    const persistentAgent = await provider.invoke("create", createRequest, context) as { id: string };
    const runSpy = vi.spyOn(agents, "run");
    const tracedContext: FabricInvocationContext = {
      ...context,
      run: {
        version: 1,
        runId: "fabric-run",
        traceId: "trace-root",
        spanId: "fabric-span",
        objectiveDigest: "digest",
        startedAt: 1,
        deadline: 10_000,
        cancellationOwner: "fabric-run",
      },
    };

    const message = await provider.invoke(
      "ask",
      { id: persistentAgent.id, message: "inspect", maxTokens: 20 },
      tracedContext,
    ) as { runId: string };

    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 20,
        runContext: expect.objectContaining({ runId: "fabric-run", traceId: "trace-root" }),
      }),
      expect.any(AbortSignal),
    );
    expect(agents.status(message.runId)).toMatchObject({
      traceId: "trace-root",
      spanId: message.runId,
      parentRunId: "fabric-run",
      parentSpanId: "fabric-span",
    });
  });

  it("preserves persistentAgent quotas and reports aggregate admission telemetry", async () => {
    const { provider } = setup();
    const persistentAgent = await provider.invoke(
      "create",
      {
        ...createRequest,
        name: "quota-provider",
        budget: { lifetimeActivations: 1 },
      },
      context,
    ) as { id: string };
    await provider.invoke("ask", { id: persistentAgent.id, message: "first" }, context);
    await expect(
      provider.invoke("ask", { id: persistentAgent.id, message: "second" }, context),
    ).rejects.toThrow("Persistent Agent admission lifetime budget exhausted");

    await expect(provider.invoke("telemetry", {}, context)).resolves.toMatchObject({
      persistent: 1,
      open: 0,
      lifetimeExhausted: 1,
      windowExhausted: 0,
      lifetimeActivations: 1,
      rejectedActivations: 1,
    });
  });

  it("propagates host-only Consult read scopes without exposing a request field", async () => {
    const { provider } = setup();
    const scopedContext: FabricInvocationContext = {
      ...context,
      consultReadScope: { scopes: ["src/auth"] },
    };
    await expect(provider.invoke("run", {
      task: "inspect scoped auth",
      tools: ["read", "grep", "find", "ls"],
      extensions: false,
      recursive: false,
    }, scopedContext)).resolves.toMatchObject({
      extensions: "false",
      consultReadScope: ["src/auth"],
    });
    const descriptor = await provider.describe("run", context);
    expect(descriptor?.inputSchema.properties).not.toHaveProperty("consultReadScope");
  });

  it("enforces configured admission intent and compiles a host capability profile", async () => {
    const { provider, agents } = setup();
    agents.config.requireAdmissionIntent = true;
    agents.config.capabilityProfiles.inspect = {
      tools: ["read", "grep"],
      risks: ["read"],
    };
    try {
      await expect(provider.invoke("run", { task: "inspect" }, context)).rejects.toThrow(
        "requires an admission intent",
      );
      await expect(provider.invoke("run", {
        task: "inspect",
        profile: "inspect",
        admission: {
          reason: "independent_context",
          expectedArtifact: "bounded findings",
        },
      }, context)).resolves.toMatchObject({
        profile: "inspect",
        tools: ["read", "grep"],
        admission: {
          reason: "independent_context",
          expectedArtifact: "bounded findings",
        },
      });
    } finally {
      agents.config.requireAdmissionIntent = false;
      delete agents.config.capabilityProfiles.inspect;
    }
  });

  it("routes Pi agents by declared capability before launch", async () => {
    const { provider } = setup();
    const models = new Map([
      ["p/text", {
        provider: "p", id: "text", input: ["text"], reasoning: true,
        contextWindow: 100_000, maxTokens: 16_000,
        cost: { input: 3, output: 15 },
      }],
      ["p/vision", {
        provider: "p", id: "vision", input: ["text", "image"], reasoning: true,
        contextWindow: 100_000, maxTokens: 16_000,
        cost: { input: 3, output: 15 },
      }],
    ]);
    const routedContext: FabricInvocationContext = {
      ...context,
      extensionContext: {
        modelRegistry: {
          find: (provider: string, id: string) => models.get(`${provider}/${id}`),
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        },
      } as unknown as ExtensionContext,
    };

    const result = await provider.invoke(
      "run",
      {
        task: "inspect image",
        model: "p/text",
        fallbackModels: ["p/vision"],
        requirements: { input: ["text", "image"] },
      },
      routedContext,
    );

    expect(result).toMatchObject({
      model: "p/vision",
      route: {
        version: 1,
        requestedModel: "p/text",
        selectedModel: "p/vision",
        reason: "capability_mismatch",
        quality: "preserved",
      },
    });
  });

  it("does not let a request elevate quality-downgrade policy", async () => {
    const { provider, agents } = setup();
    const models = new Map([
      ["p/frontier", {
        provider: "p", id: "frontier", input: ["text"], reasoning: true,
        contextWindow: 200_000, maxTokens: 32_000,
        cost: { input: 5, output: 20 },
      }],
      ["p/small", {
        provider: "p", id: "small", input: ["text"], reasoning: true,
        contextWindow: 100_000, maxTokens: 8_000,
        cost: { input: 1, output: 4 },
      }],
    ]);
    const routedContext: FabricInvocationContext = {
      ...context,
      extensionContext: {
        modelRegistry: {
          find: (provider: string, id: string) => models.get(`${provider}/${id}`),
          getApiKeyAndHeaders: async (model: { id: string }) =>
            model.id === "frontier"
              ? { ok: false, error: "missing auth" }
              : { ok: true, apiKey: "test" },
        },
      } as unknown as ExtensionContext,
    };
    const request = {
      task: "fallback",
      model: "p/frontier",
      fallbackModels: ["p/small"],
      allowQualityDowngrade: true,
    };

    await expect(provider.invoke("run", request, routedContext)).rejects.toThrow(
      "quality_downgrade_blocked",
    );
    agents.config.allowQualityDowngrade = true;
    try {
      await expect(provider.invoke("run", request, routedContext)).resolves.toMatchObject({
        model: "p/small",
        route: {
          quality: "downgraded",
          downgradeReasons: ["smaller_context", "smaller_output"],
        },
      });
    } finally {
      agents.config.allowQualityDowngrade = false;
    }
  });

  it("attaches the final preview for persistentAgents that settle before the first poll", async () => {
    const { provider } = setup();
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };

    await provider.invoke("ask", { id: persistentAgent.id, message: "inspect quickly" }, previewContext);

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      status: "completed",
      owner: "persistentAgent",
      tools: expect.any(Array),
    });
  });

  it("ignores persistentAgent timeout overrides below the configured default", async () => {
    const { provider, persistentAgents } = setup();
    const inherited = (await provider.invoke(
      "create",
      { ...createRequest, name: "inherited-timeout", timeoutMs: 240_000 },
      context,
    )) as { id: string };
    const longer = (await provider.invoke(
      "create",
      { ...createRequest, name: "longer-timeout", timeoutMs: 7_200_000 },
      context,
    )) as { id: string };

    expect(persistentAgents.definition(inherited.id)).not.toHaveProperty("timeoutMs");
    expect(persistentAgents.definition(longer.id).timeoutMs).toBe(7_200_000);
  });

  it("enumerates models from any registered provider extension and fails closed", async () => {
    const { provider } = setup();
    const makora = {
      provider: "makora",
      id: "deepseek-ai/DeepSeek-V4-Pro",
      name: "DeepSeek V4 Pro",
    };
    const pluginContext = {
      ...context,
      extensionContext: {
        modelRegistry: { getAvailable: () => [makora] },
      } as unknown as ExtensionContext,
    };

    await expect(provider.invoke("models", { runner: "pi" }, pluginContext)).resolves.toEqual([
      {
        ...makora,
        key: "makora/deepseek-ai/DeepSeek-V4-Pro",
      },
    ]);

    const unavailableContext = {
      ...context,
      extensionContext: {
        modelRegistry: { getAvailable: () => { throw new Error("registry unavailable"); } },
      } as unknown as ExtensionContext,
    };
    await expect(provider.invoke("models", { runner: "pi" }, unavailableContext)).resolves.toEqual([]);
  });

});

describe("AgentsProvider persistentAgent ownership privacy", () => {
  it("does not expose passive persistentAgent mailboxes, definitions, or logs", async () => {
    const members: FabricParticipantInfo[] = [];
    const { provider, persistentAgents } = setup([], members);
    const persistentAgent = await persistentAgents.create(createRequest as FabricPersistentAgentRequest);
    members.push({
      format: 1,
      id: persistentAgent.id,
      kind: "persistentAgent",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: persistentAgent.name,
      status: "idle",
      transport: "host",
      capabilities: ["steer", "followUp", "stop", "fabric"],
      startedAt: persistentAgent.createdAt,
      updatedAt: persistentAgent.updatedAt,
      controlProtocol: "v1",
      local: false,
      stale: false,
    });

    await expect(provider.invoke("list", { lifecycle: "persistent" }, context)).resolves.toEqual([]);
    await expect(provider.invoke("status", { id: persistentAgent.id }, context)).resolves.toMatchObject({
      kind: "agent",
      lifecycle: "persistent",
    });
    for (const action of ["messages", "retryDelivery", "export", "log"] as const) {
      await expect(provider.invoke(action, { id: persistentAgent.id }, context)).rejects.toThrow(
        "private data is available only from its owner",
      );
    }
  });
});

describe("AgentsProvider Agent templates", () => {
  it("creates a global template and lists it separately from project persistentAgents", async () => {
    const { provider, persistentAgents, agentTemplates } = setup();
    const template = await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    expect((template as { name: string }).name).toBe("reviewer");
    expect(agentTemplates.list()).toHaveLength(1);
    // project scope (default) lists live persistentAgents, not templates
    expect(await provider.invoke("list", { lifecycle: "persistent" }, context)).toEqual([]);
    expect(await provider.invoke("templates", {}, context)).toHaveLength(1);
    expect(persistentAgents.list()).toEqual([]);
  });

  it("imports a global template as a fresh live persistentAgent without history", async () => {
    const { provider, persistentAgents } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const persistentAgent = (await provider.invoke("import", { name: "reviewer" }, context)) as {
      id: string;
      name: string;
      messages: number;
    };
    expect(persistentAgent.name).toBe("reviewer");
    expect(persistentAgents.list()).toHaveLength(1);
    // fresh persistentAgent starts with no mailbox history
    expect(persistentAgent.messages).toBe(0);
    expect(persistentAgents.instructions(persistentAgent.id)).toBe(createRequest.instructions);
  });

  it("reapplies the current role contract when importing an older template", async () => {
    const { provider, agentTemplates } = setup();
    agentTemplates.create({
      name: "legacy-supervisor",
      role: "supervisor",
      instructions: "Watch the release.",
    });

    const imported = await provider.invoke("import", { name: "legacy-supervisor" }, context);
    expect(imported).toMatchObject({
      role: "supervisor",
      validWhile: {
        version: 1,
        source: expect.stringContaining("activation.mainRevision === current.mainRevision"),
      },
      turnBudget: { maxTurns: 4, graceTurns: 1 },
    });
  });

  it("exports a project persistentAgent to a global template without its history", async () => {
    const { provider, persistentAgents, agentTemplates } = setup();
    const persistentAgent = (await provider.invoke(
      "create",
      { ...createRequest, extensions: false, tools: ["read"] },
      context,
    )) as { id: string };
    // build some mailbox history so we can prove it is not exported
    await provider.invoke("ask", { id: persistentAgent.id, message: "inspect auth" }, context);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.status(persistentAgent.id).messages).toBeGreaterThan(0);

    const template = (await provider.invoke("export", { id: persistentAgent.id }, context)) as {
      name: string;
      instructions: string;
    };
    expect(template.name).toBe("reviewer");
    expect(template.instructions).toBe(createRequest.instructions);
    expect(agentTemplates.list()).toHaveLength(1);
    // a template carries no history at all
    const stored = agentTemplates.resolve("reviewer")!;
    expect(stored).not.toHaveProperty("messages");
    expect(stored).not.toHaveProperty("sessionFile");
    expect(stored.extensions).toBe(false);

    // re-importing yields a fresh persistentAgent with no inherited history
    const fresh = (await provider.invoke("import", { name: "reviewer", as: "reviewer-2" }, context)) as {
      messages: number;
      extensions?: boolean;
    };
    expect(fresh.messages).toBe(0);
    expect(fresh.extensions).toBe(false);
  });

  it("export collides without overwrite and replaces with it", async () => {
    const { provider } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    await expect(provider.invoke("export", { id: persistentAgent.id }, context)).rejects.toThrow(/already exists/);
    const replaced = (await provider.invoke("export", { id: persistentAgent.id, overwrite: true }, context)) as {
      name: string;
    };
    expect(replaced.name).toBe("reviewer");
  });

  it("migrates a persistent persistentAgent model and thinking without replacing its session", async () => {
    const { provider, persistentAgents } = setup();
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as {
      id: string;
      sessionFile?: string;
    };
    const sessionFile = persistentAgents.status(persistentAgent.id).sessionFile;

    await provider.invoke(
      "setModel",
      { id: persistentAgent.id, model: "anthropic/executor" },
      context,
    );
    await provider.invoke("setThinking", { id: persistentAgent.id, thinking: "low" }, context);
    expect(persistentAgents.status(persistentAgent.id)).toMatchObject({
      model: "anthropic/executor",
      thinking: "low",
      sessionFile,
    });

    await provider.invoke("setModel", { id: persistentAgent.id }, context);
    await provider.invoke("setThinking", { id: persistentAgent.id }, context);
    expect(persistentAgents.status(persistentAgent.id)).not.toHaveProperty("model");
    expect(persistentAgents.status(persistentAgent.id)).not.toHaveProperty("thinking");
    expect(persistentAgents.status(persistentAgent.id).sessionFile).toBe(sessionFile);
  });

  it("updates tool allowlists for project persistentAgents and global templates", async () => {
    const { provider, persistentAgents, agentTemplates } = setup();
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setTools", { id: persistentAgent.id, tools: ["read", "grep"] }, context);
    expect(persistentAgents.status(persistentAgent.id).tools).toEqual(["read", "grep"]);

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const templateId = agentTemplates.resolve("templar")!.id;
    await provider.invoke(
      "setTools",
      { id: templateId, tools: [], scope: "global" },
      context,
    );
    expect(agentTemplates.resolve("templar")!.tools).toEqual([]);

    const supervisor = await provider.invoke(
      "create",
      { ...createRequest, name: "supervisor-live", role: "supervisor" },
      context,
    ) as { id: string };
    await expect(
      provider.invoke("setTools", { id: supervisor.id, tools: ["bash"] }, context),
    ).rejects.toThrow("Agent role supervisor does not allow tools: bash");

    await provider.invoke(
      "create",
      { ...createRequest, name: "supervisor-template", role: "supervisor", scope: "global" },
      context,
    );
    await expect(provider.invoke(
      "setTools",
      { id: "supervisor-template", tools: ["bash"], scope: "global" },
      context,
    )).rejects.toThrow("Agent role supervisor does not allow tools: bash");
  });


  it("accepts the complete host-event catalog through create and setEvents", async () => {
    const { provider, persistentAgents } = setup();
    const persistentAgent = (await provider.invoke(
      "create",
      {
        ...createRequest,
        events: ["before_agent_start", "tool_call", "tool_result", "message_update"],
      },
      context,
    )) as { id: string };
    expect(persistentAgents.status(persistentAgent.id).events).toEqual([
      "before_agent_start",
      "tool_call",
      "tool_result",
      "message_update",
    ]);

    await provider.invoke(
      "setEvents",
      { id: persistentAgent.id, events: ["context", "before_provider_request", "session_tree"] },
      context,
    );
    expect(persistentAgents.status(persistentAgent.id).events).toEqual([
      "context",
      "before_provider_request",
      "session_tree",
    ]);
  });

  it("routes explicit outbox redelivery through the local persistentAgent owner", async () => {
    const { provider, persistentAgents } = setup();
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    const retry = vi.spyOn(persistentAgents, "retryDelivery").mockResolvedValue({
      id: "message-1",
      persistentAgentId: persistentAgent.id,
      persistentAgentName: "reviewer",
      direction: "out",
      source: "direct",
      createdAt: 1,
    });

    await provider.invoke(
      "retryDelivery",
      { id: persistentAgent.id, messageId: "message-1" },
      context,
    );

    expect(retry).toHaveBeenCalledWith(persistentAgent.id, "message-1");
  });

  it("validates and updates delivery policies for project persistentAgents and global templates", async () => {
    const { provider, persistentAgents, agentTemplates } = setup();
    const { triggerTurn: _triggerTurn, ...ambiguous } = createRequest;
    await expect(provider.invoke("create", ambiguous, context)).rejects.toThrow(
      /requires explicit triggerTurn/,
    );

    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke(
      "setDeliveryPolicy",
      { id: persistentAgent.id, delivery: "steer", triggerTurn: true },
      context,
    );
    expect(persistentAgents.status(persistentAgent.id)).toMatchObject({ delivery: "steer", triggerTurn: true });

    await provider.invoke(
      "create",
      { ...createRequest, name: "templar", scope: "global" },
      context,
    );
    const templateId = agentTemplates.resolve("templar")!.id;
    await provider.invoke(
      "setDeliveryPolicy",
      { id: templateId, delivery: "followUp", triggerTurn: true, scope: "global" },
      context,
    );
    expect(agentTemplates.resolve(templateId)).toMatchObject({
      delivery: "followUp",
      triggerTurn: true,
    });
  });

  it("edits instructions for project and global scopes", async () => {
    const { provider, persistentAgents, agentTemplates } = setup();
    const persistentAgent = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setInstructions", { id: persistentAgent.id, instructions: "Be brief." }, context);
    expect(persistentAgents.instructions(persistentAgent.id)).toBe("Be brief.");

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const globalId = agentTemplates.resolve("templar")!.id;
    await provider.invoke("setInstructions", { id: globalId, instructions: "Template brief.", scope: "global" }, context);
    expect(agentTemplates.resolve("templar")!.instructions).toBe("Template brief.");
  });

  it("removes a global template via scoped remove", async () => {
    const { provider, agentTemplates } = setup();
    const template = (await provider.invoke(
      "create",
      { ...createRequest, scope: "global" },
      context,
    )) as { id: string };
    await provider.invoke("remove", { id: template.id, scope: "global" }, context);
    expect(agentTemplates.list()).toEqual([]);
  });
});

describe("AgentsProvider steering", () => {
  const readSteerFile = (root: string, id: string): Array<Record<string, unknown>> => {
    const file = path.join(root, "runs", id, "steer.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("discovers and addresses the root Main agent through its stable alias", async () => {
    const { provider, mainDeliveries } = setup();

    await expect(provider.invoke("main", {}, context)).resolves.toMatchObject({
      id: "session:test",
      name: "Main",
      kind: "main",
      local: true,
    });
    await expect(
      provider.invoke("status", { id: "main" }, context),
    ).resolves.toMatchObject({ id: "session:test", name: "Main" });

    const steer = await provider.invoke(
      "steer",
      { id: "main", message: "prioritize the failing test", data: { source: "supervisor" } },
      context,
    );
    const followUp = await provider.invoke(
      "followUp",
      { id: "session:test", message: "then summarize the fix" },
      context,
    );

    expect(steer).toEqual({
      queued: true,
      messageId: "main-message-1",
      routed: "main",
    });
    expect(followUp).toEqual({
      queued: true,
      messageId: "main-message-2",
      routed: "main",
    });
    expect(mainDeliveries).toMatchObject([
      {
        from: { id: "session:test", kind: "main" },
        message: "prioritize the failing test",
        delivery: "steer",
        data: { source: "supervisor" },
      },
      {
        message: "then summarize the fix",
        delivery: "followUp",
      },
    ]);
  });

  it("steer routes to a local running agent and queues a steer command", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: handle.id, message: "focus on refresh tokens" },
      context,
    )) as { queued: boolean; messageId: string; routed: string };
    expect(result).toEqual({ queued: true, messageId: expect.any(String), routed: "local" });
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "steer", message: "focus on refresh tokens" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("accepts an owner-addressed control command for a local agent", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const acceptance = await provider.acceptControl(
      {
        version: 1,
        commandId: "command-1",
        targetId: handle.id,
        operation: "followUp",
        replyTo: "session:peer",
        message: "summarize after the current turn",
        requestedAt: Date.now(),
      },
      { id: "session:peer", name: "peer", kind: "main", sessionId: "peer" },
    );

    expect(acceptance).toMatchObject({ accepted: true, messageId: expect.any(String) });
    expect(readSteerFile(root, handle.id)[0]).toMatchObject({
      type: "follow_up",
      message: "summarize after the current turn",
    });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("steer routes to a local persistentAgent as a mailbox message", async () => {
    const { provider } = setup();
    const persistentAgent = (await provider.invoke(
      "create",
      { name: "steered", instructions: "reply", responseMode: "text" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: persistentAgent.id, message: "check session expiry" },
      context,
    )) as { routed: string };
    expect(result.routed).toBe("local");
    const messages = (await provider.invoke("messages", { id: persistentAgent.id }, context)) as Array<{
      direction: string;
      data?: { message?: string };
    }>;
    expect(
      messages.some(
        (message) => message.direction === "in" && message.data?.message === "check session expiry",
      ),
    ).toBe(true);
  });

  it("rejects an unknown remote id instead of broadcasting an unverified steer", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke(
        "steer",
        { id: "not-a-local-id", message: "from elsewhere" },
        context,
      ),
    ).rejects.toThrow("Unknown Fabric participant");
  });

  it("setSteeringMode routes to a local agent", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await provider.invoke("setSteeringMode", { id: handle.id, mode: "all" }, context);
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "set_steering_mode", mode: "all" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("setSteeringMode throws for a non-local id (no mesh fallback)", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("setSteeringMode", { id: "unknown-id", mode: "all" }, context),
    ).rejects.toThrow(/Unknown Fabric agent/);
  });

  it("setSteeringMode rejects an invalid mode", async () => {
    const { provider } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await expect(
      provider.invoke("setSteeringMode", { id: handle.id, mode: "always" }, context),
    ).rejects.toThrow(/Invalid steering mode/);
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact enqueues a compact entry for a running pi child", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "compact",
      { id: handle.id, instructions: "Keep the test plan" },
      context,
    )) as { queued: true; messageId: string };
    expect(result.queued).toBe(true);
    expect(typeof result.messageId).toBe("string");
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "compact", instructions: "Keep the test plan" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact descriptor is agent-risk with required id", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("compact", context);
    expect(descriptor?.risk).toBe("agent");
    const schema = descriptor?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["id"]);
    expect(schema.properties).toHaveProperty("instructions");
    expect(schema.additionalProperties).toBe(false);
  });

  it("compact rejects an unknown id", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("compact", { id: "not-a-real-id" }, context),
    ).rejects.toThrow(/Unknown Fabric agent/);
  });
});
