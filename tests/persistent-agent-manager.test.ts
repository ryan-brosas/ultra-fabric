import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentAgentRuntime } from "../src/agents/persistent/manager.js";
import type { FabricPersistentAgentDeliveryRequest } from "../src/agents/persistent/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunResult } from "../src/agents/types.js";

const roots: string[] = [];
const persistentAgentManagers: PersistentAgentRuntime[] = [];
const agentManagers: AgentManager[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for persistentAgent state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setup = (
  persistent = false,
  canManagePersistentAgent?: (id: string) => boolean | undefined,
  onDeliver?: (request: FabricPersistentAgentDeliveryRequest) => void,
  deliveryMaxAttempts = 1,
  runtime: {
    mesh?: Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>;
    now?: () => number;
    outcomeSink?: { record(input: import("../src/outcomes/store.js").FabricOutcomeInput): Promise<unknown> };
  } = {},
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persistentAgent-test-"));
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
  const meshConfig = {
    ...DEFAULT_FABRIC_CONFIG.mesh,
    persistentAgentPollMs: 20,
    persistentAgentDeliveryMaxAttempts: deliveryMaxAttempts,
    ...runtime.mesh,
  };
  const deliveries: string[] = [];
  const persistentAgents = new PersistentAgentRuntime(
    "test",
    identity,
    mesh,
    meshConfig,
    agents,
    onDeliver ?? (({ message }) => {
      if (message.text) deliveries.push(message.text);
    }),
    {
      persistentAgentRoot: path.join(root, "persistentAgents"),
      persistent,
      ...(canManagePersistentAgent ? { canManagePersistentAgent } : {}),
      retryDependencies: {
        sleep: async () => undefined,
        random: () => 0,
      },
      ...(runtime.now ? { now: runtime.now } : {}),
      ...(runtime.outcomeSink ? { outcomeSink: runtime.outcomeSink } : {}),
    },
  );
  persistentAgentManagers.push(persistentAgents);
  return { persistentAgents, mesh, deliveries, root, agents, identity, meshConfig };
};

afterEach(async () => {
  await Promise.all(persistentAgentManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(agentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PersistentAgentRuntime", () => {
  it("uses event monitoring where supported and polling fallback on Windows", async () => {
    const { mesh } = setup();
    const tail = vi.spyOn(mesh, "tail");

    await new Promise((resolve) => setTimeout(resolve, 80));

    if (process.platform === "win32") {
      expect(tail.mock.calls.length).toBeGreaterThan(1);
    } else {
      expect(tail).toHaveBeenCalledTimes(1);
    }
  });

  it("executes and mutates persistentAgents only while this host owns them", async () => {
    let owns = true;
    const { persistentAgents, mesh } = setup(false, () => owns);
    const persistentAgent = await persistentAgents.create({ name: "leased", instructions: "Observe." });
    await waitFor(() => Boolean(mesh.get(`persistentAgents/test/${persistentAgent.id}`)));

    owns = false;
    expect(() => persistentAgents.tell(persistentAgent.id, "do not run")).toThrow("owned by another host");
    expect(persistentAgents.dispatchHostEvent("input", { text: "ignored" })).toBe(0);
    await expect(persistentAgents.setModel(persistentAgent.id, "provider/model")).rejects.toThrow(
      "owned by another host",
    );

    owns = true;
    expect(persistentAgents.tell(persistentAgent.id, "run after takeover")).toMatchObject({ queued: true });
  });

  it("preserves current remote persistentAgent records when saving a locally owned persistentAgent", async () => {
    let localId: string | undefined;
    const state = setup(true, (id) => localId === undefined || id === localId);
    const local = await state.persistentAgents.create({
      name: "local persistentAgent",
      instructions: "Local instructions.",
    });
    await state.persistentAgents.create({
      name: "remote persistentAgent",
      instructions: "Initial remote instructions.",
    });
    localId = local.id;
    const registryPath = path.join(state.root, "persistentAgents", "persistentAgents.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      persistentAgents: Array<Record<string, unknown>>;
    };
    const remote = registry.persistentAgents.find((persistentAgent) => persistentAgent.id !== local.id);
    expect(remote).toBeDefined();
    remote!.instructions = "Updated by remote owner.";
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    await state.persistentAgents.setModel(local.id, "provider/local");

    const saved = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      persistentAgents: Array<Record<string, unknown>>;
    };
    expect(saved.persistentAgents.find((persistentAgent) => persistentAgent.id !== local.id)?.instructions).toBe(
      "Updated by remote owner.",
    );
  });

  it("discovers the first persistentAgent created after an empty standby starts", async () => {
    let ownerOwns = true;
    let standbyOwns = false;
    const state = setup(true, () => ownerOwns);
    const standbyIdentity: MeshIdentity = {
      id: "session:standby",
      name: "main",
      kind: "main",
      sessionId: "standby",
    };
    const standby = new PersistentAgentRuntime(
      "standby",
      standbyIdentity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        persistentAgentRoot: path.join(state.root, "persistentAgents"),
        persistent: true,
        canManagePersistentAgent: () => standbyOwns,
      },
    );
    persistentAgentManagers.push(standby);
    expect(standby.list()).toEqual([]);

    const created = await state.persistentAgents.create({
      name: "late persistentAgent",
      instructions: "Persist after standby startup.",
    });
    await waitFor(() => standby.list().some((persistentAgent) => persistentAgent.id === created.id));

    ownerOwns = false;
    standbyOwns = true;
    expect(standby.tell(created.id, "continue after takeover")).toMatchObject({
      queued: true,
    });
  });

  it("notifies and releases persistentAgent state subscribers", async () => {
    const { persistentAgents } = setup();
    const listener = vi.fn();
    const unsubscribe = persistentAgents.subscribe(listener);
    const persistentAgent = await persistentAgents.create({ name: "observer", instructions: "Observe." });
    expect(listener).toHaveBeenCalled();

    const beforeUpdate = listener.mock.calls.length;
    await persistentAgents.setModel(persistentAgent.id, "provider/model");
    expect(listener.mock.calls.length).toBeGreaterThan(beforeUpdate);

    unsubscribe();
    const beforeUnsubscribedUpdate = listener.mock.calls.length;
    await persistentAgents.setThinking(persistentAgent.id, "high");
    expect(listener).toHaveBeenCalledTimes(beforeUnsubscribedUpdate);
  });

  it("keeps a persistent persistentAgent identity and processes direct mailbox messages", async () => {
    const { persistentAgents, agents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });

    const reply = await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    expect(reply.persistentAgentId).toBe(persistentAgent.id);
    expect(reply.deliveryReceipt).toMatchObject({
      mesh: { status: "published" },
      main: { status: "mailbox", mode: "mailbox" },
    });
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.status(persistentAgent.id)).toMatchObject({ status: "idle", messages: 2 });
    expect(agents.list()).toEqual([]);
    expect(persistentAgents.messages(persistentAgent.id)).toMatchObject([
      { direction: "in", source: "direct" },
      { direction: "out", source: "direct", text: "fake worker complete" },
    ]);
  });

  it("enforces durable persistentAgent window and lifetime admission quotas", async () => {
    let now = 100;
    const { persistentAgents } = setup(false, undefined, undefined, 1, {
      now: () => now,
    });
    const persistentAgent = await persistentAgents.create({
      name: "bounded",
      instructions: "Reply",
      budget: {
        lifetimeActivations: 2,
        windowActivations: 1,
        windowMs: 1_000,
      },
    } as never);

    await persistentAgents.ask(persistentAgent.id, "first");
    expect(() => persistentAgents.tell(persistentAgent.id, "too soon")).toThrow(
      "Persistent Agent admission window budget exhausted",
    );
    now = 1_100;
    await persistentAgents.ask(persistentAgent.id, "second");
    now = 2_200;
    expect(() => persistentAgents.tell(persistentAgent.id, "lifetime exhausted")).toThrow(
      "Persistent Agent admission lifetime budget exhausted",
    );
    const status = persistentAgents.status(persistentAgent.id);
    expect(status).toMatchObject({
      budget: {
        admission: "lifetime_exhausted",
        usage: {
          lifetimeActivations: 2,
          windowActivations: 0,
          rejectedActivations: 2,
        },
      },
    });
    expect(status.budget?.usage.lifetimeTokens).toBeGreaterThan(0);
  });

  it("records ambient persistentAgent outcomes under a synthetic root trace", async () => {
    const record = vi.fn(async () => undefined);
    const { persistentAgents } = setup(false, undefined, undefined, 1, {
      outcomeSink: { record },
    });
    const persistentAgent = await persistentAgents.create({
      name: "observed persistentAgent",
      instructions: "Report",
    });

    const reply = await persistentAgents.ask(persistentAgent.id, "observe this activation");

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      runId: reply.runId,
      traceId: expect.any(String),
      objectiveDigest: expect.any(String),
      outcome: "succeeded",
      tokens: 3,
      gateVerdict: "none",
      routes: [],
    }));
  });

  it("rejects persistentAgent queue overflow under the default explicit policy", async () => {
    const { persistentAgents, agents } = setup(false, undefined, undefined, 1, {
      mesh: { persistentAgentQueueLimit: 1, persistentAgentOverflowPolicy: "reject" },
    });
    const persistentAgent = await persistentAgents.create({ name: "worker", instructions: "Process work." });
    persistentAgents.tell(persistentAgent.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    persistentAgents.tell(persistentAgent.id, "queued item");

    expect(() => persistentAgents.tell(persistentAgent.id, "overflow item")).toThrow(/queue limit reached/);
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(1);
  });

  it("coalesces persistentAgent queue overflow by source when configured", async () => {
    const { persistentAgents, agents } = setup(false, undefined, undefined, 1, {
      mesh: { persistentAgentQueueLimit: 1, persistentAgentOverflowPolicy: "coalesce" },
    });
    const persistentAgent = await persistentAgents.create({ name: "worker", instructions: "Process work." });
    persistentAgents.tell(persistentAgent.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    const queued = persistentAgents.tell(persistentAgent.id, "queued item");

    const coalesced = persistentAgents.tell(persistentAgent.id, "newest item");

    expect(coalesced.messageId).toBe(queued.messageId);
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(1);
  });

  it.each([
    ["drop-oldest", "rejected"],
    ["dead-letter", "deadLettered"],
  ] as const)("records %s persistentAgent queue displacement", async (policy, terminalField) => {
    const { persistentAgents, agents } = setup(false, undefined, undefined, 1, {
      mesh: { persistentAgentQueueLimit: 1, persistentAgentOverflowPolicy: policy },
    });
    const persistentAgent = await persistentAgents.create({ name: `worker ${policy}`, instructions: "Process work." });
    persistentAgents.tell(persistentAgent.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    const displaced = persistentAgents.tell(persistentAgent.id, "old queued item");

    const accepted = persistentAgents.tell(persistentAgent.id, "new queued item");

    expect(accepted.messageId).not.toBe(displaced.messageId);
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(1);
    expect(persistentAgents.messages(persistentAgent.id)).toContainEqual(
      expect.objectContaining({
        direction: "out",
        [terminalField]: true,
        data: { activationId: displaced.messageId },
      }),
    );
  });

  it("delivers schema-validated persistentAgent directives through the fixed policy", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await persistentAgents.ask(persistentAgent.id, "Review this turn");
    expect(reply).toMatchObject({
      action: "message",
      text: "fake persistentAgent advice",
      deliveryReceipt: {
        mesh: { status: "published" },
        main: { status: "delivered", mode: "steer" },
      },
    });
    expect(deliveries).toEqual(["fake persistentAgent advice"]);
  });

  it("records mesh publication failure independently from mailbox delivery", async () => {
    const { persistentAgents, mesh } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages.",
      responseMode: "text",
    });
    vi.spyOn(mesh, "publish").mockRejectedValue(new Error("mesh journal unavailable"));

    const reply = await persistentAgents.ask(persistentAgent.id, "Review this turn");

    expect(reply.deliveryReceipt).toMatchObject({
      mesh: { status: "failed", error: "mesh journal unavailable" },
      main: { status: "mailbox", mode: "mailbox" },
    });
    expect(persistentAgents.status(persistentAgent.id).lastError).toBe("mesh journal unavailable");
  });

  it("records active delivery failure instead of swallowing it", async () => {
    const { persistentAgents } = setup(false, undefined, () => {
      throw new Error("Main delivery queue unavailable");
    });
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await persistentAgents.ask(persistentAgent.id, "Review this turn");

    expect(reply).toMatchObject({
      action: "message",
      text: "fake persistentAgent advice",
      deliveryReceipt: {
        mesh: { status: "published" },
        main: {
          status: "failed",
          mode: "steer",
          error: "Main delivery queue unavailable",
        },
      },
    });
    expect(persistentAgents.status(persistentAgent.id).lastError).toBe("Main delivery queue unavailable");
    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({
      id: reply.id,
      deliveryReceipt: reply.deliveryReceipt,
    });
  });

  it("automatically retries transient delivery with bounded backoff", async () => {
    let attempts = 0;
    const { persistentAgents } = setup(
      false,
      undefined,
      () => {
        attempts++;
        if (attempts === 1) throw new Error("transient Main delivery failure");
      },
      3,
    );
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "followUp",
      triggerTurn: true,
    });

    const delivered = await persistentAgents.ask(persistentAgent.id, "Review this turn");

    expect(delivered.deliveryReceipt?.main).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
    expect(attempts).toBe(2);
  });

  it("opens, suppresses, and half-opens the persistent Agent delivery circuit", async () => {
    let now = 1_000;
    let shouldFail = true;
    let deliveries = 0;
    const { persistentAgents } = setup(
      false,
      undefined,
      () => {
        deliveries++;
        if (shouldFail) throw new Error("Main unavailable");
      },
      1,
      {
        mesh: {
          persistentAgentCircuitFailureThreshold: 1,
          persistentAgentCircuitCooldownMs: 100,
        } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
        now: () => now,
      },
    );
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const failed = await persistentAgents.ask(persistentAgent.id, "first");
    expect(failed.deliveryReceipt?.main.status).toBe("failed");
    expect(persistentAgents.status(persistentAgent.id).deliveryCircuit).toMatchObject({
      state: "open",
      failures: 1,
      retryAt: 1_100,
    });

    now = 1_050;
    const suppressed = await persistentAgents.ask(persistentAgent.id, "second");
    expect(suppressed.deliveryReceipt?.main).toMatchObject({
      status: "circuit_open",
      attempts: 0,
    });
    expect(deliveries).toBe(1);

    now = 1_200;
    shouldFail = false;
    const recovered = await persistentAgents.ask(persistentAgent.id, "third");
    expect(recovered.deliveryReceipt?.main.status).toBe("delivered");
    expect(persistentAgents.status(persistentAgent.id).deliveryCircuit).toEqual({
      state: "closed",
      failures: 0,
    });
    expect(deliveries).toBe(2);
  });

  it("persists an open delivery circuit across persistentAgent ownership reload", async () => {
    let now = 5_000;
    const state = setup(
      true,
      undefined,
      () => {
        throw new Error("Main unavailable");
      },
      1,
      {
        mesh: {
          persistentAgentCircuitFailureThreshold: 1,
          persistentAgentCircuitCooldownMs: 500,
        } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
        now: () => now,
      },
    );
    const persistentAgent = await state.persistentAgents.create({
      name: "persistent advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    await state.persistentAgents.ask(persistentAgent.id, "open circuit");
    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);

    now = 5_100;
    const restored = new PersistentAgentRuntime(
      "standby",
      { id: "session:standby", name: "main", kind: "main", sessionId: "standby" },
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        persistentAgentRoot: path.join(state.root, "persistentAgents"),
        persistent: true,
        canManagePersistentAgent: () => false,
        now: () => now,
      },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id).deliveryCircuit).toEqual({
      state: "open",
      failures: 1,
      openedAt: 5_000,
      retryAt: 5_500,
    });
  });

  it("redelivers a failed outbox message under the same id", async () => {
    let attempts = 0;
    const { persistentAgents } = setup(false, undefined, () => {
      attempts++;
      if (attempts === 1) throw new Error("transient Main delivery failure");
    });
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "followUp",
      triggerTurn: true,
    });
    const failed = await persistentAgents.ask(persistentAgent.id, "Review this turn");
    expect(failed.deliveryReceipt?.main).toMatchObject({
      status: "failed",
      attempts: 1,
    });

    const delivered = await persistentAgents.retryDelivery(persistentAgent.id, failed.id);

    expect(delivered).toMatchObject({
      id: failed.id,
      deliveryReceipt: {
        main: { status: "delivered", mode: "followUp", attempts: 2 },
      },
    });
    expect(attempts).toBe(2);
    expect(persistentAgents.status(persistentAgent.id).lastError).toBeUndefined();
  });

  it("dead-letters an outbox channel after its bounded retry budget", async () => {
    const { persistentAgents } = setup(false, undefined, () => {
      throw new Error("permanent Main delivery failure");
    });
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    const failed = await persistentAgents.ask(persistentAgent.id, "Review this turn");

    await persistentAgents.retryDelivery(persistentAgent.id, failed.id);
    const deadLetter = await persistentAgents.retryDelivery(persistentAgent.id, failed.id);

    expect(deadLetter.deliveryReceipt?.main).toMatchObject({
      status: "dead_lettered",
      attempts: 3,
      error: "permanent Main delivery failure",
    });
    await expect(persistentAgents.retryDelivery(persistentAgent.id, failed.id)).rejects.toThrow(
      /already dead-lettered/,
    );
  });

  it("requires explicit active delivery intent and rejects impossible trigger policies", async () => {
    const { persistentAgents } = setup();

    await expect(
      persistentAgents.create({
        name: "ambiguous",
        instructions: "Advise.",
        delivery: "steer",
      }),
    ).rejects.toThrow(/requires explicit triggerTurn/);
    await expect(
      persistentAgents.create({
        name: "impossible",
        instructions: "Advise.",
        delivery: "nextTurn",
        triggerTurn: true,
      }),
    ).rejects.toThrow(/never starts Main/);

    const persistentAgent = await persistentAgents.create({ name: "mailbox", instructions: "Advise." });
    expect(persistentAgent).toMatchObject({ delivery: "mailbox", triggerTurn: false });
  });

  it("updates a live persistent Agent delivery policy without recreating its history", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({ name: "advisor", instructions: "Advise." });
    await persistentAgents.tell(persistentAgent.id, "remember this");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const messages = persistentAgents.status(persistentAgent.id).messages;

    await expect(persistentAgents.setDeliveryPolicy(persistentAgent.id, "mailbox", true)).rejects.toThrow(
      /never starts Main/,
    );
    const active = await persistentAgents.setDeliveryPolicy(persistentAgent.id, "followUp", true);
    expect(active).toMatchObject({ delivery: "followUp", triggerTurn: true, messages });
    const passive = await persistentAgents.setDeliveryPolicy(persistentAgent.id, "steer", false);
    expect(passive).toMatchObject({ delivery: "steer", triggerTurn: false, messages });
  });

  it("retries a zero-effect persistentAgent startup failure under the same activation", async () => {
    const state = setup(false, undefined, undefined, 1, {
      mesh: {
        persistentAgentRunMaxAttempts: 2,
        persistentAgentRunBaseDelayMs: 0,
        persistentAgentRunMaxDelayMs: 0,
        persistentAgentRunJitterMs: 0,
      } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
    });
    const persistentAgent = await state.persistentAgents.create({ name: "worker", instructions: "Process work." });
    const originalRun = state.agents.run.bind(state.agents);
    const startupFailure: AgentRunResult = {
      id: "startup-failure",
      kind: "agent",
      lifecycle: "one-shot",
      role: "worker",
      name: "worker",
      task: "startup",
      status: "failed",
      runner: "pi",
      transport: "process",
      cwd: process.cwd(),
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      turns: 0,
      toolCalls: 0,
      text: "",
      error: "transport unavailable",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    const run = vi
      .spyOn(state.agents, "run")
      .mockResolvedValueOnce(startupFailure)
      .mockImplementation(originalRun);

    const reply = await state.persistentAgents.ask(persistentAgent.id, "retry startup");

    expect(reply).toMatchObject({ text: "fake worker complete", runAttempts: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry an persistentAgent failure after observable model work", async () => {
    const state = setup(false, undefined, undefined, 1, {
      mesh: {
        persistentAgentRunMaxAttempts: 3,
        persistentAgentRunBaseDelayMs: 0,
        persistentAgentRunMaxDelayMs: 0,
        persistentAgentRunJitterMs: 0,
      } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
    });
    const persistentAgent = await state.persistentAgents.create({ name: "worker", instructions: "Process work." });
    const effectfulFailure: AgentRunResult = {
      id: "effectful-failure",
      kind: "agent",
      lifecycle: "one-shot",
      role: "worker",
      name: "worker",
      task: "effectful",
      status: "failed",
      runner: "pi",
      transport: "process",
      cwd: process.cwd(),
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      turns: 1,
      toolCalls: 0,
      text: "partial",
      error: "model failed after output",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    const run = vi.spyOn(state.agents, "run").mockResolvedValue(effectfulFailure);

    await expect(state.persistentAgents.ask(persistentAgent.id, "do not replay")).rejects.toThrow(
      "model failed after output",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stays ambient and retains the failed run when a directive run fails", async () => {
    const { persistentAgents, agents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await persistentAgents.ask(persistentAgent.id, "FAIL_DIRECTIVE");
    expect(reply).toMatchObject({ action: "silent" });
    expect((reply.data as { runError: string }).runError).toContain(
      "Structured agent output was invalid",
    );

    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const status = persistentAgents.status(persistentAgent.id);
    expect(status).toMatchObject({ status: "idle" });
    expect(status.lastError).toBeUndefined();

    // The failed run is retained for debugging (agents.status(lastRunId)), not cleaned up.
    const retained = agents.list();
    expect(retained).toHaveLength(1);
    const run = agents.status(retained[0]!.id);
    expect(run).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Structured agent output was invalid"),
    });

    // Removing the persistentAgent releases the retained run.
    await persistentAgents.remove(persistentAgent.id);
    expect(agents.list()).toEqual([]);
  });

  it("restores persistent ambient persistentAgents for the same Pi session", async () => {
    const setupState = setup(true);
    const persistentAgent = await setupState.persistentAgents.create({
      name: "supervisor",
      instructions: "Watch until the goal is complete.",
      events: ["agent_settled"],
      responseMode: "directive",
    });
    await setupState.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(setupState.persistentAgents), 1);

    const restored = new PersistentAgentRuntime(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { persistentAgentRoot: path.join(setupState.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id)).toMatchObject({
      id: persistentAgent.id,
      name: "supervisor",
      status: "idle",
      events: ["agent_settled"],
    });
  });

  it("restores persistentAgent admission usage before accepting new work", async () => {
    const state = setup(true, undefined, undefined, 1, { now: () => 100 });
    const persistentAgent = await state.persistentAgents.create({
      name: "quota owner",
      instructions: "Reply once",
      budget: { lifetimeActivations: 1 },
    } as never);
    await state.persistentAgents.ask(persistentAgent.id, "consume quota");
    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);

    const restored = new PersistentAgentRuntime(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        persistentAgentRoot: path.join(state.root, "persistentAgents"),
        persistent: true,
        now: () => 200,
      },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id)).toMatchObject({
      budget: {
        admission: "lifetime_exhausted",
        usage: { lifetimeActivations: 1, lifetimeTokens: 3 },
      },
    });
    expect(() => restored.tell(persistentAgent.id, "must reject")).toThrow(
      "Persistent Agent admission lifetime budget exhausted",
    );
  });

  it("restores accepted queued and in-flight activations with stable ids", async () => {
    const state = setup(true);
    const persistentAgent = await state.persistentAgents.create({
      name: "durable worker",
      instructions: "Process every accepted item.",
    });
    const inFlight = state.persistentAgents.tell(persistentAgent.id, "HANG until restart");
    const queued = state.persistentAgents.tell(persistentAgent.id, "process after restart");
    await waitFor(
      () =>
        state.persistentAgents.status(persistentAgent.id).queued === 1 &&
        state.agents.list().some((run) => run.status === "running"),
    );

    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);

    const restored = new PersistentAgentRuntime(
      "standby",
      { id: "session:standby", name: "main", kind: "main", sessionId: "standby" },
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        persistentAgentRoot: path.join(state.root, "persistentAgents"),
        persistent: true,
        canManagePersistentAgent: () => false,
      },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id)).toMatchObject({
      status: "queued",
      queued: 2,
    });
    const inbox = JSON.parse(
      fs.readFileSync(path.join(state.root, "persistentAgents", persistentAgent.id, "inbox.json"), "utf8"),
    ) as { queued: Array<{ id: string }> };
    expect(inbox.queued.map((item) => item.id)).toEqual([
      inFlight.messageId,
      queued.messageId,
    ]);
  });

  it("replays recovered inbox entries and clears them only after terminal handling", async () => {
    const state = setup(true);
    const persistentAgent = await state.persistentAgents.create({
      name: "replay worker",
      instructions: "Process every accepted item.",
    });
    const first = state.persistentAgents.tell(persistentAgent.id, "HANG until restart");
    const second = state.persistentAgents.tell(persistentAgent.id, "second accepted item");
    await waitFor(
      () =>
        state.persistentAgents.status(persistentAgent.id).queued === 1 &&
        state.agents.list().some((run) => run.status === "running"),
    );
    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);

    const inboxPath = path.join(state.root, "persistentAgents", persistentAgent.id, "inbox.json");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      queued: Array<{ id: string; payload: { message: string } }>;
    };
    inbox.queued[0]!.payload.message = "replay first accepted item";
    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2));

    const restored = new PersistentAgentRuntime(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      { persistentAgentRoot: path.join(state.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);
    await waitFor(
      () =>
        restored.status(persistentAgent.id).status === "idle" &&
        restored.messages(persistentAgent.id).filter((message) => message.direction === "out").length === 2,
      5_000,
    );

    expect(
      restored.messages(persistentAgent.id).filter((message) => message.direction === "in").map((message) => message.id),
    ).toEqual(expect.arrayContaining([first.messageId, second.messageId]));
    expect(
      (JSON.parse(fs.readFileSync(inboxPath, "utf8")) as { queued: unknown[] }).queued,
    ).toEqual([]);
  });

  it("deduplicates replayed terminal persistent Agent output by activation id", async () => {
    const state = setup(true);
    const persistentAgent = await state.persistentAgents.create({
      name: "idempotent worker",
      instructions: "Process work.",
    });
    const reply = await state.persistentAgents.ask(persistentAgent.id, "process once");
    const activationId = reply.id.replace(/:out$/, "");
    const inboxPath = path.join(state.root, "persistentAgents", persistentAgent.id, "inbox.json");
    const durable = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      queued: unknown[];
      outbox: Array<{ id: string }>;
    };
    expect(durable.queued).toEqual([]);
    expect(durable.outbox.map((message) => message.id)).toContain(reply.id);

    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);
    const replay = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      format: number;
      persistentAgentId: string;
      queued: unknown[];
      outbox: unknown[];
    };
    replay.queued = [{
      id: activationId,
      source: "direct",
      payload: { message: "process once" },
      createdAt: reply.createdAt - 1,
      activation: {
        kind: "direct",
        id: activationId,
        source: "direct",
        sequence: 1,
        createdAt: reply.createdAt - 1,
      },
    }];
    fs.writeFileSync(inboxPath, JSON.stringify(replay, null, 2));

    const restored = new PersistentAgentRuntime(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      { persistentAgentRoot: path.join(state.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);
    await waitFor(
      () => restored.status(persistentAgent.id).status === "idle" && restored.status(persistentAgent.id).queued === 0,
      5_000,
    );

    expect(
      restored.messages(persistentAgent.id).filter(
        (message) => message.direction === "out" && message.id === reply.id,
      ),
    ).toHaveLength(1);
    expect(
      state.mesh.read({ topic: "fabric.persistentAgent.output" }).filter((event) => event.id === reply.id),
    ).toHaveLength(1);
  });

  it("resumes a Claude Code session after a persistent persistentAgent is restored", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-persistentAgent-"));
    roots.push(root);
    const invocationLog = path.join(root, "claude-args.jsonl");
    process.env.FAKE_CLAUDE_LOG = invocationLog;
    try {
      const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
      const agents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
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
      const persistentAgentRoot = path.join(root, "persistentAgents");
      const first = new PersistentAgentRuntime(
        "test",
        identity,
        mesh,
        meshConfig,
        agents,
        () => {},
        { persistentAgentRoot, persistent: true },
      );
      persistentAgentManagers.push(first);
      const persistentAgent = await first.create({
        name: "claude-reviewer",
        instructions: "Review each mailbox item.",
        runner: "claude",
        tools: ["read"],
      });

      const firstReply = await first.ask(persistentAgent.id, "first message");
      expect(firstReply.text).toContain("fake claude complete");
      await waitFor(() => first.status(persistentAgent.id).status === "idle");
      expect(first.status(persistentAgent.id)).toMatchObject({ runner: "claude", status: "idle" });
      await first.close();
      persistentAgentManagers.splice(persistentAgentManagers.indexOf(first), 1);

      const restored = new PersistentAgentRuntime(
        "test",
        identity,
        mesh,
        meshConfig,
        agents,
        () => {},
        { persistentAgentRoot, persistent: true },
      );
      persistentAgentManagers.push(restored);
      expect(restored.status(persistentAgent.id)).toMatchObject({ runner: "claude", status: "idle" });
      const secondReply = await restored.ask(persistentAgent.id, "second message");
      expect(secondReply.text).toContain("fake claude complete");

      const invocations = fs
        .readFileSync(invocationLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[] });
      expect(invocations).toHaveLength(2);
      expect(invocations[0]!.argv).not.toContain("--resume");
      const resumeAt = invocations[1]!.argv.indexOf("--resume");
      expect(invocations[1]!.argv[resumeAt + 1]).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(invocations[0]!.argv).not.toContain("--no-session-persistence");
      expect(restored.readLog(persistentAgent.id).session.filter((line) => line.parsed)).not.toHaveLength(0);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("restores project-scoped persistentAgents across different Pi sessions", async () => {
    // Project scope stores persistentAgents at a shared root (no sessionId segment), so a
    // new Pi session that points at the same root picks up the roster without
    // redefining persistentAgents.
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persistentAgent-scope-"));
    roots.push(scopeDir);
    const sharedRoot = path.join(scopeDir, "persistentAgents");
    const firstMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const firstAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    agentManagers.push(firstAgents);
    const first = new PersistentAgentRuntime(
      "session-a",
      { id: "session:a", name: "main", kind: "main", sessionId: "session-a" },
      firstMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 },
      firstAgents,
      () => {},
      { persistentAgentRoot: sharedRoot, persistent: true },
    );
    persistentAgentManagers.push(first);
    const persistentAgent = await first.create({
      name: "advisor",
      instructions: "Watch until the goal is complete.",
      responseMode: "directive",
    });
    await first.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(first), 1);

    // A brand-new Pi session, same shared persistentAgent root.
    const secondMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const secondAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    agentManagers.push(secondAgents);
    const restored = new PersistentAgentRuntime(
      "session-b",
      { id: "session:b", name: "main", kind: "main", sessionId: "session-b" },
      secondMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 },
      secondAgents,
      () => {},
      { persistentAgentRoot: sharedRoot, persistent: true },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id)).toMatchObject({
      id: persistentAgent.id,
      name: "advisor",
      status: "idle",
    });
  });

  it("routes host events and durable topic events to subscriptions", async () => {
    const { persistentAgents, mesh } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "watcher",
      instructions: "Watch parent and team events.",
      events: ["agent_settled"],
      topics: ["team.auth"],
      responseMode: "text",
    });

    expect(persistentAgents.dispatchHostEvent("agent_settled", { goal: "ship" })).toBe(1);
    await mesh.publish({
      topic: "team.auth",
      from: { id: "peer", name: "peer", kind: "persistentAgent" },
      text: "Need review",
    });

    await waitFor(
      () => persistentAgents.messages(persistentAgent.id).filter((message) => message.direction === "out").length === 2,
    );
    const sources = persistentAgents
      .messages(persistentAgent.id)
      .filter((message) => message.direction === "out")
      .map((message) => message.source);
    expect(sources).toEqual(["host:agent_settled", "mesh:team.auth"]);
  });

  it("retains completed-run logs and exposes them via readLog", async () => {
    const { persistentAgents, agents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");

    const status = persistentAgents.status(persistentAgent.id);
    expect(status.sessionFile).toContain("session.jsonl");
    expect(status.logDir).toContain("runs");

    const log = persistentAgents.readLog(persistentAgent.id, { type: "all" });
    expect(log.persistentAgentName).toBe("reviewer");
    expect(log.sessionFile).toContain("session.jsonl");
    const sessionRoles = log.session.map(
      (line) => (line.parsed as { role?: string } | undefined)?.role,
    );
    expect(sessionRoles).toContain("user");
    expect(sessionRoles).toContain("assistant");
    expect(log.run).toBeDefined();
    const eventTypes = log.run!.events.map(
      (line) => (line.parsed as { type?: string } | undefined)?.type,
    );
    expect(eventTypes).toContain("agent_start");
    expect(eventTypes).toContain("message_end");
    expect(log.run!.status?.status).toBe("completed");
    expect(log.retainedRuns).toHaveLength(1);
    // Completed runs are released from the in-memory registry, but the log
    // copy in the persistentAgent directory survives.
    expect(agents.list()).toEqual([]);
  });

  it("retains failed-run logs too so readLog can inspect them", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    await persistentAgents.ask(persistentAgent.id, "FAIL_DIRECTIVE");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const log = persistentAgents.readLog(persistentAgent.id, { type: "run" });
    expect(log.session).toEqual([]);
    expect(log.run).toBeDefined();
    expect(log.run!.status?.status).toBe("failed");
    const eventTypes = log.run!.events.map(
      (line) => (line.parsed as { type?: string } | undefined)?.type,
    );
    expect(eventTypes).toContain("agent_start");
  });

  it("setModel updates and clears an persistentAgent's model and it takes effect on the next run", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(persistentAgents.status(persistentAgent.id).model).toBeUndefined();

    await persistentAgents.setModel(persistentAgent.id, "anthropic/claude-sonnet-4-5");
    expect(persistentAgents.status(persistentAgent.id).model).toBe("anthropic/claude-sonnet-4-5");

    // The new model is forwarded to the agent run launched for the next message.
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const run = persistentAgents.readLog(persistentAgent.id, { type: "run" });
    expect(run.run?.status?.model).toBe("anthropic/claude-sonnet-4-5");

    // Clearing the override falls back to the Fabric default (no stored model).
    await persistentAgents.setModel(persistentAgent.id, undefined);
    expect(persistentAgents.status(persistentAgent.id).model).toBeUndefined();
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const clearedRun = persistentAgents.readLog(persistentAgent.id, { type: "run" });
    expect(clearedRun.run?.status?.model).toBeUndefined();

    // Whitespace-only values are treated as clearing the override.
    await persistentAgents.setModel(persistentAgent.id, "  ");
    expect(persistentAgents.status(persistentAgent.id).model).toBeUndefined();
  });

  it("setModel throws for an unknown persistentAgent", async () => {
    const { persistentAgents } = setup();
    await expect(persistentAgents.setModel("nope", "anthropic/claude-sonnet-4-5")).rejects.toThrow(
      "Unknown Fabric persistent Agent",
    );
  });

  it("persists a setModel change across persistentAgent manager restarts", async () => {
    const setupState = setup(true);
    const persistentAgent = await setupState.persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.persistentAgents.setModel(persistentAgent.id, "anthropic/claude-sonnet-4-5");
    await setupState.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(setupState.persistentAgents), 1);

    const restored = new PersistentAgentRuntime(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { persistentAgentRoot: path.join(setupState.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id).model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("setTools normalizes and persists an persistentAgent tool allowlist", async () => {
    const setupState = setup(true);
    const persistentAgent = await setupState.persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
    });

    await setupState.persistentAgents.setTools(persistentAgent.id, [" read ", "grep", "read", ""]);
    expect(setupState.persistentAgents.status(persistentAgent.id).tools).toEqual(["read", "grep"]);
    expect(setupState.persistentAgents.definition(persistentAgent.id).tools).toEqual(["read", "grep"]);

    await setupState.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(setupState.persistentAgents), 1);
    const restored = new PersistentAgentRuntime(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { persistentAgentRoot: path.join(setupState.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);
    expect(restored.status(persistentAgent.id).tools).toEqual(["read", "grep"]);

    await restored.setTools(persistentAgent.id, []);
    expect(restored.status(persistentAgent.id).tools).toEqual([]);
  });

  it("setThinking updates and clears a persistent Agent's thinking and it takes effect on the next run", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(persistentAgents.status(persistentAgent.id).thinking).toBeUndefined();

    await persistentAgents.setThinking(persistentAgent.id, "high");
    expect(persistentAgents.status(persistentAgent.id).thinking).toBe("high");

    // The new thinking is forwarded to the agent run launched for the next message.
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const run = persistentAgents.readLog(persistentAgent.id, { type: "run" });
    expect(run.run?.status?.thinking).toBe("high");

    // Clearing the instance override restores the advisor role default (high).
    await persistentAgents.setThinking(persistentAgent.id, undefined);
    expect(persistentAgents.status(persistentAgent.id).thinking).toBeUndefined();
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    const clearedRun = persistentAgents.readLog(persistentAgent.id, { type: "run" });
    expect(clearedRun.run?.status?.thinking).toBe("high");

    // Whitespace-only values are treated as clearing the override.
    await persistentAgents.setThinking(persistentAgent.id, "  ");
    expect(persistentAgents.status(persistentAgent.id).thinking).toBeUndefined();
  });

  it("setThinking rejects an invalid thinking level", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await expect(persistentAgents.setThinking(persistentAgent.id, "turbo")).rejects.toThrow(
      "Invalid Fabric persistent Agent thinking level",
    );
    expect(persistentAgents.status(persistentAgent.id).thinking).toBeUndefined();
  });

  it("setThinking throws for an unknown persistentAgent", async () => {
    const { persistentAgents } = setup();
    await expect(persistentAgents.setThinking("nope", "high")).rejects.toThrow("Unknown Fabric persistent Agent");
  });

  it("persists a setThinking change across persistentAgent manager restarts", async () => {
    const setupState = setup(true);
    const persistentAgent = await setupState.persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.persistentAgents.setThinking(persistentAgent.id, "xhigh");
    await setupState.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(setupState.persistentAgents), 1);

    const restored = new PersistentAgentRuntime(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { persistentAgentRoot: path.join(setupState.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id).thinking).toBe("xhigh");
  });

  it("haltAll aborts an in-flight run and cancels queued work without tearing persistentAgents down", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "text",
    });

    // Start a long-running ask (the fake worker hangs until killed). Wait until
    // the run is in flight before queueing a second message, since enqueueing
    // resets the persistentAgent status to "queued".
    const askPromise = persistentAgents.ask(persistentAgent.id, "HANG");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "running");
    persistentAgents.tell(persistentAgent.id, "queued behind the hanging run");
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(1);

    expect(persistentAgents.haltAll()).toEqual({ halted: 1 });

    // The abort can land before or after the agent process spawns, so the
    // rejection reason is either the semaphore's "Operation aborted" or the
    // transport's "Agent stopped" — both are valid interrupt outcomes.
    await expect(askPromise).rejects.toThrow(/Agent stopped|Operation aborted/);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(0);

    // The persistentAgent is interrupted, not destroyed: it keeps its identity and can
    // process new messages immediately.
    const reply = await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.status(persistentAgent.id)).toMatchObject({ status: "idle", name: "supervisor" });
  });

  it("haltAll skips idle and stopped persistentAgents and leaves them usable", async () => {
    const { persistentAgents } = setup();
    const idle = await persistentAgents.create({
      name: "idle-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    const stopped = await persistentAgents.create({
      name: "stopped-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    await persistentAgents.stop(stopped.id);

    // An idle persistentAgent with no queued work is not counted as halted.
    expect(persistentAgents.haltAll()).toEqual({ halted: 0 });
    expect(persistentAgents.status(idle.id)).toMatchObject({ status: "idle" });
    expect(persistentAgents.status(stopped.id)).toMatchObject({ status: "stopped" });

    // The idle persistentAgent is still responsive after a no-op halt.
    const reply = await persistentAgents.ask(idle.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("haltAll arms a stop-the-world that suppresses host events until the user resumes", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled"],
      responseMode: "text",
    });

    // Before any halt, host events are delivered normally.
    expect(persistentAgents.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");

    // A halt arms stop-the-world: subsequent host events are suppressed...
    persistentAgents.haltAll();
    expect(persistentAgents.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(0);

    // ...including other event types, with no time-based expiry.
    expect(persistentAgents.dispatchHostEvent("tool_error", { turn: 2 })).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The user resumes by sending a new message: the "input" host event lifts
    // the halt. The watcher does not subscribe to input, so this dispatches to
    // zero persistentAgents but reopens the gate.
    expect(persistentAgents.dispatchHostEvent("input", { turn: 3 })).toBe(0);

    // After resume, host-event dispatch is delivered again.
    expect(persistentAgents.dispatchHostEvent("agent_settled", { turn: 4 })).toBe(1);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
  });

  it("delivers mesh messages deferred by stop-the-world immediately after resume", async () => {
    const { persistentAgents, mesh } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "mesh-watcher",
      instructions: "Watch mesh messages.",
      responseMode: "text",
    });
    persistentAgents.haltAll();
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "agent" },
      to: persistentAgent.id,
      text: "deferred while halted",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(persistentAgents.messages(persistentAgent.id)).toEqual([]);

    persistentAgents.dispatchHostEvent("input", { resumed: true });
    await waitFor(() => persistentAgents.messages(persistentAgent.id).some((message) => message.direction === "in"));
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
  });

  it("exposes the stop-the-world gate via halted, lifting it on the next message", async () => {
    const { persistentAgents } = setup();

    // The gate starts disarmed.
    expect(persistentAgents.halted).toBe(false);

    // haltAll() arms the gate even when no persistentAgent had active work to abort.
    expect(persistentAgents.haltAll()).toEqual({ halted: 0 });
    expect(persistentAgents.halted).toBe(true);

    // A repeated halt is a no-op (the gate is already armed) — the index.ts
    // ESC handler reads halted to avoid re-notifying on a double-Esc.
    expect(persistentAgents.haltAll()).toEqual({ halted: 0 });
    expect(persistentAgents.halted).toBe(true);

    // The next message ("input") lifts the gate; it can then re-arm.
    expect(persistentAgents.dispatchHostEvent("input", { turn: 1 })).toBe(0);
    expect(persistentAgents.halted).toBe(false);
    expect(persistentAgents.haltAll()).toEqual({ halted: 0 });
    expect(persistentAgents.halted).toBe(true);
  });

  it("passes host-event images transiently without recording their base64 in the persistentAgent registry", async () => {
    const { persistentAgents, root } = setup(true);
    const persistentAgent = await persistentAgents.create({
      name: "image-observer",
      instructions: "Inspect attached images.",
      events: ["input"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    const data = "cGl4ZWwtc2VjcmV0";
    expect(
      persistentAgents.dispatchHostEvent(
        "input",
        {
          signal: {
            payload: {
              type: "input",
              text: "Inspect this image",
              images: [{
                type: "image",
                mediaIndex: 0,
                mimeType: "image/png",
                redacted: true,
              }],
            },
            media: [{ type: "image", mediaIndex: 0, mimeType: "image/png" }],
            idle: false,
          },
        },
        [{ type: "image", data, mimeType: "image/png" }],
      ),
    ).toBe(1);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");

    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({
      direction: "out",
      action: "message",
      data: { imageCount: 1 },
    });
    const registry = fs.readFileSync(path.join(root, "persistentAgents", "persistentAgents.json"), "utf8");
    expect(registry).not.toContain(data);
    expect(registry).toContain('"redacted": true');
  });

  it("does not replay restored image activations without their transient bytes", async () => {
    const state = setup(true);
    const persistentAgent = await state.persistentAgents.create({
      name: "durable-image-observer",
      instructions: "Inspect attached images.",
      events: ["input"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    const data = "cGl4ZWwtc2VjcmV0";
    state.persistentAgents.dispatchHostEvent(
      "input",
      {
        signal: {
          payload: { text: "HANG until restart" },
          media: [{ type: "image", mediaIndex: 0, mimeType: "image/png" }],
          idle: false,
        },
      },
      [{ type: "image", data, mimeType: "image/png" }],
    );
    await waitFor(() => state.agents.list().some((run) => run.status === "running"));
    const runsBeforeRestart = state.agents.list().length;

    await state.persistentAgents.close();
    persistentAgentManagers.splice(persistentAgentManagers.indexOf(state.persistentAgents), 1);
    const restored = new PersistentAgentRuntime(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      { persistentAgentRoot: path.join(state.root, "persistentAgents"), persistent: true },
    );
    persistentAgentManagers.push(restored);

    expect(restored.status(persistentAgent.id).queued).toBe(0);
    expect(restored.messages(persistentAgent.id).at(-1)).toMatchObject({
      direction: "out",
      action: "silent",
      stale: true,
      data: { reason: "transient_media_not_replayable" },
    });
    expect(state.agents.list()).toHaveLength(runsBeforeRestart);
    const inbox = JSON.parse(fs.readFileSync(
      path.join(state.root, "persistentAgents", persistentAgent.id, "inbox.json"),
      "utf8",
    )) as { queued: unknown[] };
    expect(inbox.queued).toEqual([]);
    expect(JSON.stringify(inbox)).not.toContain(data);
  });

  it("setEvents replaces an persistentAgent's host-event subscriptions and dedupes", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled", "tool_error"],
      responseMode: "text",
    });
    expect(persistentAgents.status(persistentAgent.id).events).toEqual(["agent_settled", "tool_error"]);

    await persistentAgents.setEvents(persistentAgent.id, ["input", "turn_end"]);
    expect(persistentAgents.status(persistentAgent.id).events).toEqual(["input", "turn_end"]);

    // An empty set pauses host-event reactivity without stopping the persistentAgent.
    await persistentAgents.setEvents(persistentAgent.id, []);
    expect(persistentAgents.status(persistentAgent.id).events).toEqual([]);
    expect(persistentAgents.status(persistentAgent.id).status).toBe("idle");

    // Duplicates are deduped, preserving first-seen order.
    await persistentAgents.setEvents(persistentAgent.id, ["agent_settled", "agent_settled"]);
    expect(persistentAgents.status(persistentAgent.id).events).toEqual(["agent_settled"]);
  });

  it("setEvents rejects an unsupported event", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "watcher",
      instructions: "Watch parent events.",
      responseMode: "text",
    });
    await expect(persistentAgents.setEvents(persistentAgent.id, ["bogus" as never])).rejects.toThrow(
      "Unsupported Fabric persistent Agent event",
    );
    expect(persistentAgents.status(persistentAgent.id).events).toEqual([]);
  });

  it("setEvents throws for an unknown persistentAgent", async () => {
    const { persistentAgents } = setup();
    await expect(persistentAgents.setEvents("nope", [])).rejects.toThrow("Unknown Fabric persistent Agent");
  });

  it("clearMessages resets an persistentAgent's recorded history without stopping it", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.messages(persistentAgent.id).length).toBeGreaterThan(0);

    await persistentAgents.clearMessages(persistentAgent.id);
    expect(persistentAgents.messages(persistentAgent.id)).toEqual([]);
    // The persistentAgent is still alive and responsive.
    expect(persistentAgents.status(persistentAgent.id).status).toBe("idle");
    const reply = await persistentAgents.ask(persistentAgent.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("clearMessages throws for an unknown persistentAgent", async () => {
    const { persistentAgents } = setup();
    await expect(persistentAgents.clearMessages("nope")).rejects.toThrow("Unknown Fabric persistent Agent");
  });

  it("restarts the drain for successive coalesced host events without stranding an item", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      coalesce: true,
    });
    // Each turn: the persistentAgent is idle when the event fires, so a run starts and
    // the drain exits before the next event. A regression in drain restart
    // (the "stuck at queue:1" race) would leave one of these stranded.
    for (let turn = 0; turn < 5; turn++) {
      expect(persistentAgents.dispatchHostEvent("agent_settled", { turn })).toBe(1);
      await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    }
    expect(deliveries.length).toBe(5);
    expect(persistentAgents.status(persistentAgent.id)).toMatchObject({ status: "idle", queued: 0 });
  });

  it("processes a host event enqueued while a run is in flight", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      coalesce: true,
    });
    expect(persistentAgents.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "running");
    // A second event arrives while the first run is in flight; the running
    // drain must pick it up on its next loop instead of stranding it.
    expect(persistentAgents.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(1);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(deliveries.length).toBe(2);
    expect(persistentAgents.status(persistentAgent.id).queued).toBe(0);
  });

  it("exposes the portable definition without history", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      role: "advisor",
      goal: "Review the current change.",
      completion: "Report material findings or silence.",
      turnBudget: { maxTurns: 4, graceTurns: 1 },
      instructions: "Review code.",
      events: ["turn_end"],
      topics: ["team.review"],
      delivery: "steer",
      triggerTurn: false,
      model: "anthropic/sonnet",
    });
    const def = persistentAgents.definition(persistentAgent.id);
    expect(def).toEqual({
      name: "reviewer",
      role: "advisor",
      goal: "Review the current change.",
      completion: "Report material findings or silence.",
      turnBudget: { maxTurns: 4, graceTurns: 1 },
      instructions: "Review code.",
      events: ["turn_end"],
      topics: ["team.review"],
      delivery: "steer",
      responseMode: "text",
      triggerTurn: false,
      coalesce: true,
      runner: "pi",
      model: "anthropic/sonnet",
    });
    // history never crosses the global⇄project boundary
    expect(def).not.toHaveProperty("id");
    expect(def).not.toHaveProperty("sessionFile");
    expect(def).not.toHaveProperty("messages");
  });

  it("reads and updates the default instruction", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({ name: "advisor", instructions: "Advise." });
    expect(persistentAgents.instructions(persistentAgent.id)).toBe("Advise.");
    await persistentAgents.setInstructions(persistentAgent.id, "Advise only when useful.");
    expect(persistentAgents.instructions(persistentAgent.id)).toBe("Advise only when useful.");
    await expect(persistentAgents.setInstructions(persistentAgent.id, "   ")).rejects.toThrow(/empty/);
  });
});

describe("PersistentAgentRuntime steering relay", () => {
  const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for steer relay");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("steerRemote throws when the mesh is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-relay-"));
    roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const agents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(root, "runs"),
    });
    agentManagers.push(agents);
    const disabledConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: false, persistentAgentPollMs: 20 };
    const persistentAgents = new PersistentAgentRuntime(
      "test",
      { id: "session:t", name: "main", kind: "main" },
      mesh,
      disabledConfig,
      agents,
      () => {},
      { persistentAgentRoot: path.join(root, "persistentAgents") },
    );
    persistentAgentManagers.push(persistentAgents);
    await expect(persistentAgents.steerRemote("anyone", "hi", "steer")).rejects.toThrow(/disabled/);
  });

  it("relays a fabric.steer event across processes to a remote agent", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-relay-"));
    roots.push(shared);
    const meshPath = path.join(shared, "mesh");
    const meshA = new MeshStore(meshPath, 64 * 1024, 100);
    const meshB = new MeshStore(meshPath, 64 * 1024, 100);
    const agentsA = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(shared, "runsA"),
    });
    const agentsB = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(shared, "runsB"),
    });
    agentManagers.push(agentsA, agentsB);
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 };
    const persistentAgentsA = new PersistentAgentRuntime(
      "a",
      { id: "session:a", name: "main", kind: "main", sessionId: "a" },
      meshA,
      cfg,
      agentsA,
      () => {},
      { persistentAgentRoot: path.join(shared, "persistentAgentsA") },
    );
    const persistentAgentsB = new PersistentAgentRuntime(
      "b",
      { id: "session:b", name: "main", kind: "main", sessionId: "b" },
      meshB,
      cfg,
      agentsB,
      () => {},
      { persistentAgentRoot: path.join(shared, "persistentAgentsB") },
    );
    persistentAgentManagers.push(persistentAgentsA, persistentAgentsB);

    // A owns a running agent; B steers it by publishing over the shared mesh.
    const handle = await agentsA.spawn({ task: "HANG", transport: "process" });
    const remote = await persistentAgentsB.steerRemote(handle.id, "redirect from B", "steer");
    expect(remote).toEqual({ queued: true, messageId: expect.any(String), routed: "mesh" });
    const steerFile = path.join(agentsA.runDirectory(handle.id)!, "steer.jsonl");
    await waitFor(
      () => fs.existsSync(steerFile) && fs.readFileSync(steerFile, "utf8").includes("redirect from B"),
      3_000,
    );
    const forwarded = fs
      .readFileSync(steerFile, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ type: "steer", message: "redirect from B" });
    await agentsA.stop(handle.id);
  });

  it("relays a cross-process follow-up to the owning Main session", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-main-relay-"));
    roots.push(shared);
    const meshPath = path.join(shared, "mesh");
    const rootMesh = new MeshStore(meshPath, 64 * 1024, 100);
    const peerMesh = new MeshStore(meshPath, 64 * 1024, 100);
    const rootAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: fakeWorker, runRoot: path.join(shared, "root-runs") },
    );
    const peerAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: fakeWorker, runRoot: path.join(shared, "peer-runs") },
    );
    agentManagers.push(rootAgents, peerAgents);
    const deliveries: FabricMainAgentDeliveryRequest[] = [];
    const mainAgent = {
      id: "session:root",
      local: true,
      matches: (id: string) => id === "main" || id === "session:root",
      info: () => ({
        id: "session:root",
        name: "Main" as const,
        kind: "main" as const,
        status: "idle" as const,
        runner: "pi" as const,
        transport: "host" as const,
        cwd: process.cwd(),
        startedAt: 1,
        updatedAt: 1,
        pendingMessages: false,
        local: true,
      }),
      deliverAgent: (request: FabricMainAgentDeliveryRequest) => {
        deliveries.push(request);
        return { queued: true as const, messageId: "main-1", routed: "main" as const };
      },
    };
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 };
    const rootPersistentAgents = new PersistentAgentRuntime(
      "root",
      { id: "session:root", name: "Main", kind: "main", sessionId: "root" },
      rootMesh,
      cfg,
      rootAgents,
      () => {},
      { persistentAgentRoot: path.join(shared, "root-persistentAgents"), mainAgent },
    );
    const peerPersistentAgents = new PersistentAgentRuntime(
      "peer",
      { id: "agent:peer", name: "peer", kind: "agent", sessionId: "peer" },
      peerMesh,
      cfg,
      peerAgents,
      () => {},
      { persistentAgentRoot: path.join(shared, "peer-persistentAgents") },
    );
    persistentAgentManagers.push(rootPersistentAgents, peerPersistentAgents);

    await peerPersistentAgents.steerRemote(
      "session:root",
      "summarize after implementation",
      "followUp",
      { requestedBy: "peer" },
    );
    await waitFor(() => deliveries.length === 1, 3_000);
    expect(deliveries).toMatchObject([
      {
        from: { id: "agent:peer", kind: "agent" },
        message: "summarize after implementation",
        delivery: "followUp",
        data: { requestedBy: "peer" },
      },
    ]);
  });

  it("relays a fabric.steer event to a local persistentAgent as a mailbox message", async () => {
    const { persistentAgents, mesh } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "target",
      instructions: "reply",
      responseMode: "text",
    });
    // Simulate a remote peer publishing a steer addressed to this persistentAgent.
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "persistentAgent" },
      to: persistentAgent.id,
      text: "from a peer",
    });
    await waitFor(
      () =>
        persistentAgents
          .messages(persistentAgent.id)
          .some(
            (message) =>
              message.direction === "in" &&
              (message.data as { message?: string } | undefined)?.message === "from a peer",
          ),
      3_000,
    );
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.messages(persistentAgent.id).some((message) => message.direction === "out")).toBe(true);
  });
});

describe("PersistentAgentRuntime extensions flag (read-only Pi persistentAgents)", () => {
    it("runs a read-only Pi persistentAgent (extensions:false) without fabric_exec or recursion", async () => {
      const { persistentAgents, agents } = setup();
      const runSpy = vi.spyOn(agents, "run");
      const persistentAgent = await persistentAgents.create({
        name: "readonly-nav",
        instructions: "Read-only navigator.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
      });
      expect(persistentAgent.extensions).toBe(false);
      await persistentAgents.ask(persistentAgent.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });

    it("defaults to Fabric-enabled (extensions true, recursive true) for a Pi persistentAgent", async () => {
      const { persistentAgents, agents } = setup();
      const runSpy = vi.spyOn(agents, "run");
      const persistentAgent = await persistentAgents.create({
        name: "default-nav",
        instructions: "Default navigator.",
        runner: "pi",
        responseMode: "text",
      });
      expect(persistentAgent.extensions).toBeUndefined();
      await persistentAgents.ask(persistentAgent.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(true);
      expect(request?.recursive).toBe(true);
    });

    it("persists extensions:false across close and restore", async () => {
      const setupState = setup(true);
      const created = await setupState.persistentAgents.create({
        name: "persistent-readonly",
        instructions: "Survive restart read-only.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
      });
      await setupState.persistentAgents.close();
      persistentAgentManagers.splice(persistentAgentManagers.indexOf(setupState.persistentAgents), 1);
      const restored = new PersistentAgentRuntime(
        "test",
        setupState.identity,
        setupState.mesh,
        setupState.meshConfig,
        setupState.agents,
        () => {},
        { persistentAgentRoot: path.join(setupState.root, "persistentAgents"), persistent: true },
      );
      persistentAgentManagers.push(restored);
      const runSpy = vi.spyOn(setupState.agents, "run");
      expect(restored.list().find((a) => a.name === "persistent-readonly")?.extensions).toBe(false);
      await restored.ask(created.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });
});
