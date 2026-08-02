import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import type { FabricActorDeliveryRequest } from "../src/actors/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunResult } from "../src/agents/types.js";

const roots: string[] = [];
const actorManagers: ActorManager[] = [];
const agentManagers: AgentManager[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for actor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setup = (
  persistent = false,
  canManageActor?: (id: string) => boolean | undefined,
  onDeliver?: (request: FabricActorDeliveryRequest) => void,
  deliveryMaxAttempts = 1,
  runtime: {
    mesh?: Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>;
    now?: () => number;
    outcomeSink?: { record(input: import("../src/outcomes/store.js").FabricOutcomeInput): Promise<unknown> };
  } = {},
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-test-"));
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
    actorPollMs: 20,
    actorDeliveryMaxAttempts: deliveryMaxAttempts,
    ...runtime.mesh,
  };
  const deliveries: string[] = [];
  const actors = new ActorManager(
    "test",
    identity,
    mesh,
    meshConfig,
    agents,
    onDeliver ?? (({ message }) => {
      if (message.text) deliveries.push(message.text);
    }),
    {
      actorRoot: path.join(root, "actors"),
      persistent,
      ...(canManageActor ? { canManageActor } : {}),
      retryDependencies: {
        sleep: async () => undefined,
        random: () => 0,
      },
      ...(runtime.now ? { now: runtime.now } : {}),
      ...(runtime.outcomeSink ? { outcomeSink: runtime.outcomeSink } : {}),
    },
  );
  actorManagers.push(actors);
  return { actors, mesh, deliveries, root, agents, identity, meshConfig };
};

afterEach(async () => {
  await Promise.all(actorManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(agentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorManager", () => {
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

  it("executes and mutates actors only while this host owns them", async () => {
    let owns = true;
    const { actors, mesh } = setup(false, () => owns);
    const actor = await actors.create({ name: "leased", instructions: "Observe." });
    await waitFor(() => Boolean(mesh.get(`actors/test/${actor.id}`)));

    owns = false;
    expect(() => actors.tell(actor.id, "do not run")).toThrow("owned by another host");
    expect(actors.dispatchHostEvent("input", { text: "ignored" })).toBe(0);
    await expect(actors.setModel(actor.id, "provider/model")).rejects.toThrow(
      "owned by another host",
    );

    owns = true;
    expect(actors.tell(actor.id, "run after takeover")).toMatchObject({ queued: true });
  });

  it("preserves current remote actor records when saving a locally owned actor", async () => {
    let localId: string | undefined;
    const state = setup(true, (id) => localId === undefined || id === localId);
    const local = await state.actors.create({
      name: "local actor",
      instructions: "Local instructions.",
    });
    await state.actors.create({
      name: "remote actor",
      instructions: "Initial remote instructions.",
    });
    localId = local.id;
    const registryPath = path.join(state.root, "actors", "actors.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      actors: Array<Record<string, unknown>>;
    };
    const remote = registry.actors.find((actor) => actor.id !== local.id);
    expect(remote).toBeDefined();
    remote!.instructions = "Updated by remote owner.";
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    await state.actors.setModel(local.id, "provider/local");

    const saved = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      actors: Array<Record<string, unknown>>;
    };
    expect(saved.actors.find((actor) => actor.id !== local.id)?.instructions).toBe(
      "Updated by remote owner.",
    );
  });

  it("discovers the first actor created after an empty standby starts", async () => {
    let ownerOwns = true;
    let standbyOwns = false;
    const state = setup(true, () => ownerOwns);
    const standbyIdentity: MeshIdentity = {
      id: "session:standby",
      name: "main",
      kind: "main",
      sessionId: "standby",
    };
    const standby = new ActorManager(
      "standby",
      standbyIdentity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        canManageActor: () => standbyOwns,
      },
    );
    actorManagers.push(standby);
    expect(standby.list()).toEqual([]);

    const created = await state.actors.create({
      name: "late actor",
      instructions: "Persist after standby startup.",
    });
    await waitFor(() => standby.list().some((actor) => actor.id === created.id));

    ownerOwns = false;
    standbyOwns = true;
    expect(standby.tell(created.id, "continue after takeover")).toMatchObject({
      queued: true,
    });
  });

  it("notifies and releases actor state subscribers", async () => {
    const { actors } = setup();
    const listener = vi.fn();
    const unsubscribe = actors.subscribe(listener);
    const actor = await actors.create({ name: "observer", instructions: "Observe." });
    expect(listener).toHaveBeenCalled();

    const beforeUpdate = listener.mock.calls.length;
    await actors.setModel(actor.id, "provider/model");
    expect(listener.mock.calls.length).toBeGreaterThan(beforeUpdate);

    unsubscribe();
    const beforeUnsubscribedUpdate = listener.mock.calls.length;
    await actors.setThinking(actor.id, "high");
    expect(listener).toHaveBeenCalledTimes(beforeUnsubscribedUpdate);
  });

  it("keeps a persistent actor identity and processes direct mailbox messages", async () => {
    const { actors, agents } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });

    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    expect(reply.actorId).toBe(actor.id);
    expect(reply.deliveryReceipt).toMatchObject({
      mesh: { status: "published" },
      main: { status: "mailbox", mode: "mailbox" },
    });
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", messages: 2 });
    expect(agents.list()).toEqual([]);
    expect(actors.messages(actor.id)).toMatchObject([
      { direction: "in", source: "direct" },
      { direction: "out", source: "direct", text: "fake worker complete" },
    ]);
  });

  it("enforces durable actor window and lifetime admission quotas", async () => {
    let now = 100;
    const { actors } = setup(false, undefined, undefined, 1, {
      now: () => now,
    });
    const actor = await actors.create({
      name: "bounded",
      instructions: "Reply",
      budget: {
        lifetimeActivations: 2,
        windowActivations: 1,
        windowMs: 1_000,
      },
    } as never);

    await actors.ask(actor.id, "first");
    expect(() => actors.tell(actor.id, "too soon")).toThrow(
      "Actor admission window budget exhausted",
    );
    now = 1_100;
    await actors.ask(actor.id, "second");
    now = 2_200;
    expect(() => actors.tell(actor.id, "lifetime exhausted")).toThrow(
      "Actor admission lifetime budget exhausted",
    );
    const status = actors.status(actor.id);
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

  it("records ambient actor outcomes under a synthetic root trace", async () => {
    const record = vi.fn(async () => undefined);
    const { actors } = setup(false, undefined, undefined, 1, {
      outcomeSink: { record },
    });
    const actor = await actors.create({
      name: "observed actor",
      instructions: "Report",
    });

    const reply = await actors.ask(actor.id, "observe this activation");

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

  it("rejects actor queue overflow under the default explicit policy", async () => {
    const { actors, agents } = setup(false, undefined, undefined, 1, {
      mesh: { actorQueueLimit: 1, actorOverflowPolicy: "reject" },
    });
    const actor = await actors.create({ name: "worker", instructions: "Process work." });
    actors.tell(actor.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    actors.tell(actor.id, "queued item");

    expect(() => actors.tell(actor.id, "overflow item")).toThrow(/queue limit reached/);
    expect(actors.status(actor.id).queued).toBe(1);
  });

  it("coalesces actor queue overflow by source when configured", async () => {
    const { actors, agents } = setup(false, undefined, undefined, 1, {
      mesh: { actorQueueLimit: 1, actorOverflowPolicy: "coalesce" },
    });
    const actor = await actors.create({ name: "worker", instructions: "Process work." });
    actors.tell(actor.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    const queued = actors.tell(actor.id, "queued item");

    const coalesced = actors.tell(actor.id, "newest item");

    expect(coalesced.messageId).toBe(queued.messageId);
    expect(actors.status(actor.id).queued).toBe(1);
  });

  it.each([
    ["drop-oldest", "rejected"],
    ["dead-letter", "deadLettered"],
  ] as const)("records %s actor queue displacement", async (policy, terminalField) => {
    const { actors, agents } = setup(false, undefined, undefined, 1, {
      mesh: { actorQueueLimit: 1, actorOverflowPolicy: policy },
    });
    const actor = await actors.create({ name: `worker ${policy}`, instructions: "Process work." });
    actors.tell(actor.id, "HANG in flight");
    await waitFor(() => agents.list().some((run) => run.status === "running"));
    const displaced = actors.tell(actor.id, "old queued item");

    const accepted = actors.tell(actor.id, "new queued item");

    expect(accepted.messageId).not.toBe(displaced.messageId);
    expect(actors.status(actor.id).queued).toBe(1);
    expect(actors.messages(actor.id)).toContainEqual(
      expect.objectContaining({
        direction: "out",
        [terminalField]: true,
        data: { activationId: displaced.messageId },
      }),
    );
  });

  it("delivers schema-validated actor directives through the fixed policy", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await actors.ask(actor.id, "Review this turn");
    expect(reply).toMatchObject({
      action: "message",
      text: "fake actor advice",
      deliveryReceipt: {
        mesh: { status: "published" },
        main: { status: "delivered", mode: "steer" },
      },
    });
    expect(deliveries).toEqual(["fake actor advice"]);
  });

  it("records mesh publication failure independently from mailbox delivery", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages.",
      responseMode: "text",
    });
    vi.spyOn(mesh, "publish").mockRejectedValue(new Error("mesh journal unavailable"));

    const reply = await actors.ask(actor.id, "Review this turn");

    expect(reply.deliveryReceipt).toMatchObject({
      mesh: { status: "failed", error: "mesh journal unavailable" },
      main: { status: "mailbox", mode: "mailbox" },
    });
    expect(actors.status(actor.id).lastError).toBe("mesh journal unavailable");
  });

  it("records active delivery failure instead of swallowing it", async () => {
    const { actors } = setup(false, undefined, () => {
      throw new Error("Main delivery queue unavailable");
    });
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await actors.ask(actor.id, "Review this turn");

    expect(reply).toMatchObject({
      action: "message",
      text: "fake actor advice",
      deliveryReceipt: {
        mesh: { status: "published" },
        main: {
          status: "failed",
          mode: "steer",
          error: "Main delivery queue unavailable",
        },
      },
    });
    expect(actors.status(actor.id).lastError).toBe("Main delivery queue unavailable");
    expect(actors.messages(actor.id).at(-1)).toMatchObject({
      id: reply.id,
      deliveryReceipt: reply.deliveryReceipt,
    });
  });

  it("automatically retries transient delivery with bounded backoff", async () => {
    let attempts = 0;
    const { actors } = setup(
      false,
      undefined,
      () => {
        attempts++;
        if (attempts === 1) throw new Error("transient Main delivery failure");
      },
      3,
    );
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "followUp",
      triggerTurn: true,
    });

    const delivered = await actors.ask(actor.id, "Review this turn");

    expect(delivered.deliveryReceipt?.main).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
    expect(attempts).toBe(2);
  });

  it("opens, suppresses, and half-opens the actor delivery circuit", async () => {
    let now = 1_000;
    let shouldFail = true;
    let deliveries = 0;
    const { actors } = setup(
      false,
      undefined,
      () => {
        deliveries++;
        if (shouldFail) throw new Error("Main unavailable");
      },
      1,
      {
        mesh: {
          actorCircuitFailureThreshold: 1,
          actorCircuitCooldownMs: 100,
        } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
        now: () => now,
      },
    );
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const failed = await actors.ask(actor.id, "first");
    expect(failed.deliveryReceipt?.main.status).toBe("failed");
    expect(actors.status(actor.id).deliveryCircuit).toMatchObject({
      state: "open",
      failures: 1,
      retryAt: 1_100,
    });

    now = 1_050;
    const suppressed = await actors.ask(actor.id, "second");
    expect(suppressed.deliveryReceipt?.main).toMatchObject({
      status: "circuit_open",
      attempts: 0,
    });
    expect(deliveries).toBe(1);

    now = 1_200;
    shouldFail = false;
    const recovered = await actors.ask(actor.id, "third");
    expect(recovered.deliveryReceipt?.main.status).toBe("delivered");
    expect(actors.status(actor.id).deliveryCircuit).toEqual({
      state: "closed",
      failures: 0,
    });
    expect(deliveries).toBe(2);
  });

  it("persists an open delivery circuit across actor ownership reload", async () => {
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
          actorCircuitFailureThreshold: 1,
          actorCircuitCooldownMs: 500,
        } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
        now: () => now,
      },
    );
    const actor = await state.actors.create({
      name: "persistent advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    await state.actors.ask(actor.id, "open circuit");
    await state.actors.close();
    actorManagers.splice(actorManagers.indexOf(state.actors), 1);

    now = 5_100;
    const restored = new ActorManager(
      "standby",
      { id: "session:standby", name: "main", kind: "main", sessionId: "standby" },
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        canManageActor: () => false,
        now: () => now,
      },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id).deliveryCircuit).toEqual({
      state: "open",
      failures: 1,
      openedAt: 5_000,
      retryAt: 5_500,
    });
  });

  it("redelivers a failed outbox message under the same id", async () => {
    let attempts = 0;
    const { actors } = setup(false, undefined, () => {
      attempts++;
      if (attempts === 1) throw new Error("transient Main delivery failure");
    });
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "followUp",
      triggerTurn: true,
    });
    const failed = await actors.ask(actor.id, "Review this turn");
    expect(failed.deliveryReceipt?.main).toMatchObject({
      status: "failed",
      attempts: 1,
    });

    const delivered = await actors.retryDelivery(actor.id, failed.id);

    expect(delivered).toMatchObject({
      id: failed.id,
      deliveryReceipt: {
        main: { status: "delivered", mode: "followUp", attempts: 2 },
      },
    });
    expect(attempts).toBe(2);
    expect(actors.status(actor.id).lastError).toBeUndefined();
  });

  it("dead-letters an outbox channel after its bounded retry budget", async () => {
    const { actors } = setup(false, undefined, () => {
      throw new Error("permanent Main delivery failure");
    });
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    const failed = await actors.ask(actor.id, "Review this turn");

    await actors.retryDelivery(actor.id, failed.id);
    const deadLetter = await actors.retryDelivery(actor.id, failed.id);

    expect(deadLetter.deliveryReceipt?.main).toMatchObject({
      status: "dead_lettered",
      attempts: 3,
      error: "permanent Main delivery failure",
    });
    await expect(actors.retryDelivery(actor.id, failed.id)).rejects.toThrow(
      /already dead-lettered/,
    );
  });

  it("requires explicit active delivery intent and rejects impossible trigger policies", async () => {
    const { actors } = setup();

    await expect(
      actors.create({
        name: "ambiguous",
        instructions: "Advise.",
        delivery: "steer",
      }),
    ).rejects.toThrow(/requires explicit triggerTurn/);
    await expect(
      actors.create({
        name: "impossible",
        instructions: "Advise.",
        delivery: "nextTurn",
        triggerTurn: true,
      }),
    ).rejects.toThrow(/never starts Main/);

    const actor = await actors.create({ name: "mailbox", instructions: "Advise." });
    expect(actor).toMatchObject({ delivery: "mailbox", triggerTurn: false });
  });

  it("updates a live actor delivery policy without recreating its history", async () => {
    const { actors } = setup();
    const actor = await actors.create({ name: "advisor", instructions: "Advise." });
    await actors.tell(actor.id, "remember this");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const messages = actors.status(actor.id).messages;

    await expect(actors.setDeliveryPolicy(actor.id, "mailbox", true)).rejects.toThrow(
      /never starts Main/,
    );
    const active = await actors.setDeliveryPolicy(actor.id, "followUp", true);
    expect(active).toMatchObject({ delivery: "followUp", triggerTurn: true, messages });
    const passive = await actors.setDeliveryPolicy(actor.id, "steer", false);
    expect(passive).toMatchObject({ delivery: "steer", triggerTurn: false, messages });
  });

  it("retries a zero-effect actor startup failure under the same activation", async () => {
    const state = setup(false, undefined, undefined, 1, {
      mesh: {
        actorRunMaxAttempts: 2,
        actorRunBaseDelayMs: 0,
        actorRunMaxDelayMs: 0,
        actorRunJitterMs: 0,
      } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
    });
    const actor = await state.actors.create({ name: "worker", instructions: "Process work." });
    const originalRun = state.agents.run.bind(state.agents);
    const startupFailure: AgentRunResult = {
      id: "startup-failure",
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

    const reply = await state.actors.ask(actor.id, "retry startup");

    expect(reply).toMatchObject({ text: "fake worker complete", runAttempts: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry an actor failure after observable model work", async () => {
    const state = setup(false, undefined, undefined, 1, {
      mesh: {
        actorRunMaxAttempts: 3,
        actorRunBaseDelayMs: 0,
        actorRunMaxDelayMs: 0,
        actorRunJitterMs: 0,
      } as Partial<typeof DEFAULT_FABRIC_CONFIG.mesh>,
    });
    const actor = await state.actors.create({ name: "worker", instructions: "Process work." });
    const effectfulFailure: AgentRunResult = {
      id: "effectful-failure",
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

    await expect(state.actors.ask(actor.id, "do not replay")).rejects.toThrow(
      "model failed after output",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stays ambient and retains the failed run when a directive run fails", async () => {
    const { actors, agents } = setup();
    const actor = await actors.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });

    const reply = await actors.ask(actor.id, "FAIL_DIRECTIVE");
    expect(reply).toMatchObject({ action: "silent" });
    expect((reply.data as { runError: string }).runError).toContain(
      "Structured agent output was invalid",
    );

    await waitFor(() => actors.status(actor.id).status === "idle");
    const status = actors.status(actor.id);
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

    // Removing the actor releases the retained run.
    await actors.remove(actor.id);
    expect(agents.list()).toEqual([]);
  });

  it("restores persistent ambient actors for the same Pi session", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "supervisor",
      instructions: "Watch until the goal is complete.",
      events: ["agent_settled"],
      responseMode: "directive",
    });
    await setupState.actors.close();
    actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);

    const restored = new ActorManager(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { actorRoot: path.join(setupState.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      id: actor.id,
      name: "supervisor",
      status: "idle",
      events: ["agent_settled"],
    });
  });

  it("restores actor admission usage before accepting new work", async () => {
    const state = setup(true, undefined, undefined, 1, { now: () => 100 });
    const actor = await state.actors.create({
      name: "quota owner",
      instructions: "Reply once",
      budget: { lifetimeActivations: 1 },
    } as never);
    await state.actors.ask(actor.id, "consume quota");
    await state.actors.close();
    actorManagers.splice(actorManagers.indexOf(state.actors), 1);

    const restored = new ActorManager(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        now: () => 200,
      },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      budget: {
        admission: "lifetime_exhausted",
        usage: { lifetimeActivations: 1, lifetimeTokens: 3 },
      },
    });
    expect(() => restored.tell(actor.id, "must reject")).toThrow(
      "Actor admission lifetime budget exhausted",
    );
  });

  it("restores accepted queued and in-flight activations with stable ids", async () => {
    const state = setup(true);
    const actor = await state.actors.create({
      name: "durable worker",
      instructions: "Process every accepted item.",
    });
    const inFlight = state.actors.tell(actor.id, "HANG until restart");
    const queued = state.actors.tell(actor.id, "process after restart");
    await waitFor(
      () =>
        state.actors.status(actor.id).queued === 1 &&
        state.agents.list().some((run) => run.status === "running"),
    );

    await state.actors.close();
    actorManagers.splice(actorManagers.indexOf(state.actors), 1);

    const restored = new ActorManager(
      "standby",
      { id: "session:standby", name: "main", kind: "main", sessionId: "standby" },
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        canManageActor: () => false,
      },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      status: "queued",
      queued: 2,
    });
    const inbox = JSON.parse(
      fs.readFileSync(path.join(state.root, "actors", actor.id, "inbox.json"), "utf8"),
    ) as { queued: Array<{ id: string }> };
    expect(inbox.queued.map((item) => item.id)).toEqual([
      inFlight.messageId,
      queued.messageId,
    ]);
  });

  it("replays recovered inbox entries and clears them only after terminal handling", async () => {
    const state = setup(true);
    const actor = await state.actors.create({
      name: "replay worker",
      instructions: "Process every accepted item.",
    });
    const first = state.actors.tell(actor.id, "HANG until restart");
    const second = state.actors.tell(actor.id, "second accepted item");
    await waitFor(
      () =>
        state.actors.status(actor.id).queued === 1 &&
        state.agents.list().some((run) => run.status === "running"),
    );
    await state.actors.close();
    actorManagers.splice(actorManagers.indexOf(state.actors), 1);

    const inboxPath = path.join(state.root, "actors", actor.id, "inbox.json");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      queued: Array<{ id: string; payload: { message: string } }>;
    };
    inbox.queued[0]!.payload.message = "replay first accepted item";
    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2));

    const restored = new ActorManager(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      { actorRoot: path.join(state.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);
    await waitFor(
      () =>
        restored.status(actor.id).status === "idle" &&
        restored.messages(actor.id).filter((message) => message.direction === "out").length === 2,
      5_000,
    );

    expect(
      restored.messages(actor.id).filter((message) => message.direction === "in").map((message) => message.id),
    ).toEqual(expect.arrayContaining([first.messageId, second.messageId]));
    expect(
      (JSON.parse(fs.readFileSync(inboxPath, "utf8")) as { queued: unknown[] }).queued,
    ).toEqual([]);
  });

  it("deduplicates replayed terminal actor output by activation id", async () => {
    const state = setup(true);
    const actor = await state.actors.create({
      name: "idempotent worker",
      instructions: "Process work.",
    });
    const reply = await state.actors.ask(actor.id, "process once");
    const activationId = reply.id.replace(/:out$/, "");
    const inboxPath = path.join(state.root, "actors", actor.id, "inbox.json");
    const durable = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      queued: unknown[];
      outbox: Array<{ id: string }>;
    };
    expect(durable.queued).toEqual([]);
    expect(durable.outbox.map((message) => message.id)).toContain(reply.id);

    await state.actors.close();
    actorManagers.splice(actorManagers.indexOf(state.actors), 1);
    const replay = JSON.parse(fs.readFileSync(inboxPath, "utf8")) as {
      format: number;
      actorId: string;
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

    const restored = new ActorManager(
      "test",
      state.identity,
      state.mesh,
      state.meshConfig,
      state.agents,
      () => {},
      { actorRoot: path.join(state.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);
    await waitFor(
      () => restored.status(actor.id).status === "idle" && restored.status(actor.id).queued === 0,
      5_000,
    );

    expect(
      restored.messages(actor.id).filter(
        (message) => message.direction === "out" && message.id === reply.id,
      ),
    ).toHaveLength(1);
    expect(
      state.mesh.read({ topic: "fabric.actor.output" }).filter((event) => event.id === reply.id),
    ).toHaveLength(1);
  });

  it("resumes a Claude Code session after a persistent actor is restored", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-actor-"));
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
      const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
      const actorRoot = path.join(root, "actors");
      const first = new ActorManager(
        "test",
        identity,
        mesh,
        meshConfig,
        agents,
        () => {},
        { actorRoot, persistent: true },
      );
      actorManagers.push(first);
      const actor = await first.create({
        name: "claude-reviewer",
        instructions: "Review each mailbox item.",
        runner: "claude",
        tools: ["read"],
      });

      const firstReply = await first.ask(actor.id, "first message");
      expect(firstReply.text).toContain("fake claude complete");
      await waitFor(() => first.status(actor.id).status === "idle");
      expect(first.status(actor.id)).toMatchObject({ runner: "claude", status: "idle" });
      await first.close();
      actorManagers.splice(actorManagers.indexOf(first), 1);

      const restored = new ActorManager(
        "test",
        identity,
        mesh,
        meshConfig,
        agents,
        () => {},
        { actorRoot, persistent: true },
      );
      actorManagers.push(restored);
      expect(restored.status(actor.id)).toMatchObject({ runner: "claude", status: "idle" });
      const secondReply = await restored.ask(actor.id, "second message");
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
      expect(restored.readLog(actor.id).session.filter((line) => line.parsed)).not.toHaveLength(0);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("restores project-scoped actors across different Pi sessions", async () => {
    // Project scope stores actors at a shared root (no sessionId segment), so a
    // new Pi session that points at the same root picks up the roster without
    // redefining actors.
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-scope-"));
    roots.push(scopeDir);
    const sharedRoot = path.join(scopeDir, "actors");
    const firstMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const firstAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    agentManagers.push(firstAgents);
    const first = new ActorManager(
      "session-a",
      { id: "session:a", name: "main", kind: "main", sessionId: "session-a" },
      firstMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      firstAgents,
      () => {},
      { actorRoot: sharedRoot, persistent: true },
    );
    actorManagers.push(first);
    const actor = await first.create({
      name: "advisor",
      instructions: "Watch until the goal is complete.",
      responseMode: "directive",
    });
    await first.close();
    actorManagers.splice(actorManagers.indexOf(first), 1);

    // A brand-new Pi session, same shared actor root.
    const secondMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const secondAgents = new AgentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.agents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    agentManagers.push(secondAgents);
    const restored = new ActorManager(
      "session-b",
      { id: "session:b", name: "main", kind: "main", sessionId: "session-b" },
      secondMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      secondAgents,
      () => {},
      { actorRoot: sharedRoot, persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      id: actor.id,
      name: "advisor",
      status: "idle",
    });
  });

  it("routes host events and durable topic events to subscriptions", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent and team events.",
      events: ["agent_settled"],
      topics: ["team.auth"],
      responseMode: "text",
    });

    expect(actors.dispatchHostEvent("agent_settled", { goal: "ship" })).toBe(1);
    await mesh.publish({
      topic: "team.auth",
      from: { id: "peer", name: "peer", kind: "actor" },
      text: "Need review",
    });

    await waitFor(
      () => actors.messages(actor.id).filter((message) => message.direction === "out").length === 2,
    );
    const sources = actors
      .messages(actor.id)
      .filter((message) => message.direction === "out")
      .map((message) => message.source);
    expect(sources).toEqual(["host:agent_settled", "mesh:team.auth"]);
  });

  it("retains completed-run logs and exposes them via readLog", async () => {
    const { actors, agents } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");

    const status = actors.status(actor.id);
    expect(status.sessionFile).toContain("session.jsonl");
    expect(status.logDir).toContain("runs");

    const log = actors.readLog(actor.id, { type: "all" });
    expect(log.actorName).toBe("reviewer");
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
    // copy in the actor directory survives.
    expect(agents.list()).toEqual([]);
  });

  it("retains failed-run logs too so readLog can inspect them", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    await actors.ask(actor.id, "FAIL_DIRECTIVE");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const log = actors.readLog(actor.id, { type: "run" });
    expect(log.session).toEqual([]);
    expect(log.run).toBeDefined();
    expect(log.run!.status?.status).toBe("failed");
    const eventTypes = log.run!.events.map(
      (line) => (line.parsed as { type?: string } | undefined)?.type,
    );
    expect(eventTypes).toContain("agent_start");
  });

  it("setModel updates and clears an actor's model and it takes effect on the next run", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(actors.status(actor.id).model).toBeUndefined();

    await actors.setModel(actor.id, "anthropic/claude-sonnet-4-5");
    expect(actors.status(actor.id).model).toBe("anthropic/claude-sonnet-4-5");

    // The new model is forwarded to the agent run launched for the next message.
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const run = actors.readLog(actor.id, { type: "run" });
    expect(run.run?.status?.model).toBe("anthropic/claude-sonnet-4-5");

    // Clearing the override falls back to the Fabric default (no stored model).
    await actors.setModel(actor.id, undefined);
    expect(actors.status(actor.id).model).toBeUndefined();
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const clearedRun = actors.readLog(actor.id, { type: "run" });
    expect(clearedRun.run?.status?.model).toBeUndefined();

    // Whitespace-only values are treated as clearing the override.
    await actors.setModel(actor.id, "  ");
    expect(actors.status(actor.id).model).toBeUndefined();
  });

  it("setModel throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setModel("nope", "anthropic/claude-sonnet-4-5")).rejects.toThrow(
      "Unknown Fabric actor",
    );
  });

  it("persists a setModel change across actor manager restarts", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.actors.setModel(actor.id, "anthropic/claude-sonnet-4-5");
    await setupState.actors.close();
    actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);

    const restored = new ActorManager(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { actorRoot: path.join(setupState.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id).model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("setTools normalizes and persists an actor tool allowlist", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
    });

    await setupState.actors.setTools(actor.id, [" read ", "grep", "read", ""]);
    expect(setupState.actors.status(actor.id).tools).toEqual(["read", "grep"]);
    expect(setupState.actors.definition(actor.id).tools).toEqual(["read", "grep"]);

    await setupState.actors.close();
    actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);
    const restored = new ActorManager(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { actorRoot: path.join(setupState.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);
    expect(restored.status(actor.id).tools).toEqual(["read", "grep"]);

    await restored.setTools(actor.id, []);
    expect(restored.status(actor.id).tools).toEqual([]);
  });

  it("setThinking updates and clears an actor's thinking and it takes effect on the next run", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(actors.status(actor.id).thinking).toBeUndefined();

    await actors.setThinking(actor.id, "high");
    expect(actors.status(actor.id).thinking).toBe("high");

    // The new thinking is forwarded to the agent run launched for the next message.
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const run = actors.readLog(actor.id, { type: "run" });
    expect(run.run?.status?.thinking).toBe("high");

    // Clearing the override falls back to the Fabric default (medium).
    await actors.setThinking(actor.id, undefined);
    expect(actors.status(actor.id).thinking).toBeUndefined();
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const clearedRun = actors.readLog(actor.id, { type: "run" });
    expect(clearedRun.run?.status?.thinking).toBe("medium");

    // Whitespace-only values are treated as clearing the override.
    await actors.setThinking(actor.id, "  ");
    expect(actors.status(actor.id).thinking).toBeUndefined();
  });

  it("setThinking rejects an invalid thinking level", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await expect(actors.setThinking(actor.id, "turbo")).rejects.toThrow(
      "Invalid Fabric actor thinking level",
    );
    expect(actors.status(actor.id).thinking).toBeUndefined();
  });

  it("setThinking throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setThinking("nope", "high")).rejects.toThrow("Unknown Fabric actor");
  });

  it("persists a setThinking change across actor manager restarts", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.actors.setThinking(actor.id, "xhigh");
    await setupState.actors.close();
    actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);

    const restored = new ActorManager(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.agents,
      () => {},
      { actorRoot: path.join(setupState.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id).thinking).toBe("xhigh");
  });

  it("haltAll aborts an in-flight run and cancels queued work without tearing actors down", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "text",
    });

    // Start a long-running ask (the fake worker hangs until killed). Wait until
    // the run is in flight before queueing a second message, since enqueueing
    // resets the actor status to "queued".
    const askPromise = actors.ask(actor.id, "HANG");
    await waitFor(() => actors.status(actor.id).status === "running");
    actors.tell(actor.id, "queued behind the hanging run");
    expect(actors.status(actor.id).queued).toBe(1);

    expect(actors.haltAll()).toEqual({ halted: 1 });

    // The abort can land before or after the agent process spawns, so the
    // rejection reason is either the semaphore's "Operation aborted" or the
    // transport's "Agent stopped" — both are valid interrupt outcomes.
    await expect(askPromise).rejects.toThrow(/Agent stopped|Operation aborted/);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id).queued).toBe(0);

    // The actor is interrupted, not destroyed: it keeps its identity and can
    // process new messages immediately.
    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", name: "supervisor" });
  });

  it("haltAll skips idle and stopped actors and leaves them usable", async () => {
    const { actors } = setup();
    const idle = await actors.create({
      name: "idle-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    const stopped = await actors.create({
      name: "stopped-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    await actors.stop(stopped.id);

    // An idle actor with no queued work is not counted as halted.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.status(idle.id)).toMatchObject({ status: "idle" });
    expect(actors.status(stopped.id)).toMatchObject({ status: "stopped" });

    // The idle actor is still responsive after a no-op halt.
    const reply = await actors.ask(idle.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("haltAll arms a stop-the-world that suppresses host events until the user resumes", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled"],
      responseMode: "text",
    });

    // Before any halt, host events are delivered normally.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");

    // A halt arms stop-the-world: subsequent host events are suppressed...
    actors.haltAll();
    expect(actors.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(0);

    // ...including other event types, with no time-based expiry.
    expect(actors.dispatchHostEvent("tool_error", { turn: 2 })).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The user resumes by sending a new message: the "input" host event lifts
    // the halt. The watcher does not subscribe to input, so this dispatches to
    // zero actors but reopens the gate.
    expect(actors.dispatchHostEvent("input", { turn: 3 })).toBe(0);

    // After resume, host-event dispatch is delivered again.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 4 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");
  });

  it("delivers mesh messages deferred by stop-the-world immediately after resume", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "mesh-watcher",
      instructions: "Watch mesh messages.",
      responseMode: "text",
    });
    actors.haltAll();
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "agent" },
      to: actor.id,
      text: "deferred while halted",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(actors.messages(actor.id)).toEqual([]);

    actors.dispatchHostEvent("input", { resumed: true });
    await waitFor(() => actors.messages(actor.id).some((message) => message.direction === "in"));
    await waitFor(() => actors.status(actor.id).status === "idle");
  });

  it("exposes the stop-the-world gate via halted, lifting it on the next message", async () => {
    const { actors } = setup();

    // The gate starts disarmed.
    expect(actors.halted).toBe(false);

    // haltAll() arms the gate even when no actor had active work to abort.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);

    // A repeated halt is a no-op (the gate is already armed) — the index.ts
    // ESC handler reads halted to avoid re-notifying on a double-Esc.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);

    // The next message ("input") lifts the gate; it can then re-arm.
    expect(actors.dispatchHostEvent("input", { turn: 1 })).toBe(0);
    expect(actors.halted).toBe(false);
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);
  });

  it("passes host-event images transiently without recording their base64 in the actor registry", async () => {
    const { actors, root } = setup(true);
    const actor = await actors.create({
      name: "image-observer",
      instructions: "Inspect attached images.",
      events: ["input"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
    });
    const data = "cGl4ZWwtc2VjcmV0";
    expect(
      actors.dispatchHostEvent(
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
    await waitFor(() => actors.status(actor.id).status === "idle");

    expect(actors.messages(actor.id).at(-1)).toMatchObject({
      direction: "out",
      action: "message",
      data: { imageCount: 1 },
    });
    const registry = fs.readFileSync(path.join(root, "actors", "actors.json"), "utf8");
    expect(registry).not.toContain(data);
    expect(registry).toContain('"redacted": true');
  });

  it("setEvents replaces an actor's host-event subscriptions and dedupes", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled", "tool_error"],
      responseMode: "text",
    });
    expect(actors.status(actor.id).events).toEqual(["agent_settled", "tool_error"]);

    await actors.setEvents(actor.id, ["input", "turn_end"]);
    expect(actors.status(actor.id).events).toEqual(["input", "turn_end"]);

    // An empty set pauses host-event reactivity without stopping the actor.
    await actors.setEvents(actor.id, []);
    expect(actors.status(actor.id).events).toEqual([]);
    expect(actors.status(actor.id).status).toBe("idle");

    // Duplicates are deduped, preserving first-seen order.
    await actors.setEvents(actor.id, ["agent_settled", "agent_settled"]);
    expect(actors.status(actor.id).events).toEqual(["agent_settled"]);
  });

  it("setEvents rejects an unsupported event", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      responseMode: "text",
    });
    await expect(actors.setEvents(actor.id, ["bogus" as never])).rejects.toThrow(
      "Unsupported Fabric actor event",
    );
    expect(actors.status(actor.id).events).toEqual([]);
  });

  it("setEvents throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setEvents("nope", [])).rejects.toThrow("Unknown Fabric actor");
  });

  it("clearMessages resets an actor's recorded history without stopping it", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.messages(actor.id).length).toBeGreaterThan(0);

    await actors.clearMessages(actor.id);
    expect(actors.messages(actor.id)).toEqual([]);
    // The actor is still alive and responsive.
    expect(actors.status(actor.id).status).toBe("idle");
    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("clearMessages throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.clearMessages("nope")).rejects.toThrow("Unknown Fabric actor");
  });

  it("restarts the drain for successive coalesced host events without stranding an item", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      coalesce: true,
    });
    // Each turn: the actor is idle when the event fires, so a run starts and
    // the drain exits before the next event. A regression in drain restart
    // (the "stuck at queue:1" race) would leave one of these stranded.
    for (let turn = 0; turn < 5; turn++) {
      expect(actors.dispatchHostEvent("agent_settled", { turn })).toBe(1);
      await waitFor(() => actors.status(actor.id).status === "idle");
    }
    expect(deliveries.length).toBe(5);
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", queued: 0 });
  });

  it("processes a host event enqueued while a run is in flight", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      coalesce: true,
    });
    expect(actors.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "running");
    // A second event arrives while the first run is in flight; the running
    // drain must pick it up on its next loop instead of stranding it.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(deliveries.length).toBe(2);
    expect(actors.status(actor.id).queued).toBe(0);
  });

  it("exposes the portable definition without history", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review code.",
      events: ["turn_end"],
      topics: ["team.review"],
      delivery: "steer",
      triggerTurn: false,
      model: "anthropic/sonnet",
    });
    const def = actors.definition(actor.id);
    expect(def).toEqual({
      name: "reviewer",
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
    const { actors } = setup();
    const actor = await actors.create({ name: "advisor", instructions: "Advise." });
    expect(actors.instructions(actor.id)).toBe("Advise.");
    await actors.setInstructions(actor.id, "Advise only when useful.");
    expect(actors.instructions(actor.id)).toBe("Advise only when useful.");
    await expect(actors.setInstructions(actor.id, "   ")).rejects.toThrow(/empty/);
  });
});

describe("ActorManager steering relay", () => {
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
    const disabledConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: false, actorPollMs: 20 };
    const actors = new ActorManager(
      "test",
      { id: "session:t", name: "main", kind: "main" },
      mesh,
      disabledConfig,
      agents,
      () => {},
      { actorRoot: path.join(root, "actors") },
    );
    actorManagers.push(actors);
    await expect(actors.steerRemote("anyone", "hi", "steer")).rejects.toThrow(/disabled/);
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
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
    const actorsA = new ActorManager(
      "a",
      { id: "session:a", name: "main", kind: "main", sessionId: "a" },
      meshA,
      cfg,
      agentsA,
      () => {},
      { actorRoot: path.join(shared, "actorsA") },
    );
    const actorsB = new ActorManager(
      "b",
      { id: "session:b", name: "main", kind: "main", sessionId: "b" },
      meshB,
      cfg,
      agentsB,
      () => {},
      { actorRoot: path.join(shared, "actorsB") },
    );
    actorManagers.push(actorsA, actorsB);

    // A owns a running agent; B steers it by publishing over the shared mesh.
    const handle = await agentsA.spawn({ task: "HANG", transport: "process" });
    const remote = await actorsB.steerRemote(handle.id, "redirect from B", "steer");
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
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
    const rootActors = new ActorManager(
      "root",
      { id: "session:root", name: "Main", kind: "main", sessionId: "root" },
      rootMesh,
      cfg,
      rootAgents,
      () => {},
      { actorRoot: path.join(shared, "root-actors"), mainAgent },
    );
    const peerActors = new ActorManager(
      "peer",
      { id: "agent:peer", name: "peer", kind: "agent", sessionId: "peer" },
      peerMesh,
      cfg,
      peerAgents,
      () => {},
      { actorRoot: path.join(shared, "peer-actors") },
    );
    actorManagers.push(rootActors, peerActors);

    await peerActors.steerRemote(
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

  it("relays a fabric.steer event to a local actor as a mailbox message", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "target",
      instructions: "reply",
      responseMode: "text",
    });
    // Simulate a remote peer publishing a steer addressed to this actor.
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "actor" },
      to: actor.id,
      text: "from a peer",
    });
    await waitFor(
      () =>
        actors
          .messages(actor.id)
          .some(
            (message) =>
              message.direction === "in" &&
              (message.data as { message?: string } | undefined)?.message === "from a peer",
          ),
      3_000,
    );
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.messages(actor.id).some((message) => message.direction === "out")).toBe(true);
  });
});

describe("ActorManager extensions flag (read-only Pi actors)", () => {
    it("runs a read-only Pi actor (extensions:false) without fabric_exec or recursion", async () => {
      const { actors, agents } = setup();
      const runSpy = vi.spyOn(agents, "run");
      const actor = await actors.create({
        name: "readonly-nav",
        instructions: "Read-only navigator.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
      });
      expect(actor.extensions).toBe(false);
      await actors.ask(actor.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });

    it("defaults to Fabric-enabled (extensions true, recursive true) for a Pi actor", async () => {
      const { actors, agents } = setup();
      const runSpy = vi.spyOn(agents, "run");
      const actor = await actors.create({
        name: "default-nav",
        instructions: "Default navigator.",
        runner: "pi",
        responseMode: "text",
      });
      expect(actor.extensions).toBeUndefined();
      await actors.ask(actor.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(true);
      expect(request?.recursive).toBe(true);
    });

    it("persists extensions:false across close and restore", async () => {
      const setupState = setup(true);
      const created = await setupState.actors.create({
        name: "persistent-readonly",
        instructions: "Survive restart read-only.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
      });
      await setupState.actors.close();
      actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);
      const restored = new ActorManager(
        "test",
        setupState.identity,
        setupState.mesh,
        setupState.meshConfig,
        setupState.agents,
        () => {},
        { actorRoot: path.join(setupState.root, "actors"), persistent: true },
      );
      actorManagers.push(restored);
      const runSpy = vi.spyOn(setupState.agents, "run");
      expect(restored.list().find((a) => a.name === "persistent-readonly")?.extensions).toBe(false);
      await restored.ask(created.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });
});
