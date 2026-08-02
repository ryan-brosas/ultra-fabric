import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentAgentRuntime } from "../src/agents/persistent/manager.js";
import { evaluatePersistentAgentValidWhile } from "../src/agents/persistent/predicate.js";
import type { FabricPersistentAgentValidityFacts } from "../src/agents/persistent/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { AgentManager } from "../src/agents/manager.js";

const roots: string[] = [];
const managers: PersistentAgentRuntime[] = [];
const agents: AgentManager[] = [];

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for persistentAgent");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-valid-while-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const worker = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, "runs"),
  });
  agents.push(worker);
  const identity: MeshIdentity = { id: "session:test", name: "main", kind: "main", sessionId: "test" };
  const deliveries: string[] = [];
  const persistentAgents = new PersistentAgentRuntime(
    "test",
    identity,
    mesh,
    { ...DEFAULT_FABRIC_CONFIG.mesh, persistentAgentPollMs: 20 },
    worker,
    ({ message }) => { if (message.text) deliveries.push(message.text); },
    { persistentAgentRoot: path.join(root, "persistentAgents") },
  );
  managers.push(persistentAgents);
  return { persistentAgents, deliveries, mesh };
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(agents.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hostFacts = (): FabricPersistentAgentValidityFacts => ({
  activation: {
    kind: "hostEvent",
    id: "activation",
    source: "host:tool_error",
    sequence: 1,
    createdAt: 10,
    event: "tool_error",
    mainRevision: 2,
    taskRevision: 1,
    signal: { payload: { message: "grep returned exit code 1" }, idle: false, observedAt: 10 },
  },
  current: {
    latestActivationSequence: 1,
    mainRevision: 3,
    taskRevision: 1,
    idle: false,
    now: 20,
  },
});

describe("persistent persistentAgent validWhile", () => {
  it("evaluates synchronous regex predicates with a diagnostic verdict", async () => {
    const result = await evaluatePersistentAgentValidWhile(
      {
        version: 1,
        source: `({ activation, current }) => {
          const text = JSON.stringify(activation.signal ?? {});
          return /exit code 1/i.test(text) && activation.mainRevision !== current.mainRevision
            ? { valid: false, reason: "recovered error" }
            : true;
        }`,
      },
      hostFacts(),
    );
    expect(result).toEqual({ valid: false, reason: "recovered error" });
  });

  it("serializes a programmatic predicate before agents.create reaches the host", async () => {
    let received: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `return agents.create({
        name: "advisor",
        instructions: "Advise.",
        validWhile: ({ activation, current }) =>
          activation.kind !== "hostEvent" || activation.taskRevision === current.taskRevision,
      });`,
      async (ref, args) => {
        expect(ref).toBe("agents.create");
        received = args;
        return { id: "persistentAgent" };
      },
      { timeoutMs: 2_000, memoryLimitBytes: 64 * 1024 * 1024 },
    );
    expect(result.terminationReason).toBe("completed");
    expect(received?.validWhile).toMatchObject({ version: 1 });
    expect((received?.validWhile as { source: string }).source).toContain("taskRevision");
  });

  it("invalidates a tool-error activation when Main advances before it runs", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "advisor",
      instructions: "Advise.",
      events: ["tool_error"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      validWhile: {
        version: 1,
        source: "({ activation, current }) => activation.kind !== 'hostEvent' || activation.mainRevision === current.mainRevision",
      },
    });
    persistentAgents.dispatchHostEvent("tool_error", { signal: { idle: false } });
    persistentAgents.noteMainActivity(false);
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(deliveries).toEqual([]);
    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({ action: "silent", stale: true });
  });

  it("rechecks freshness after mesh publication before steering Main", async () => {
    const { persistentAgents, deliveries, mesh } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "supervisor",
      instructions: "Supervise the current goal.",
      events: ["tool_error"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      validWhile: {
        version: 1,
        source: "({ activation, current }) => activation.kind !== 'hostEvent' || activation.mainRevision === current.mainRevision",
      },
    });
    const originalPublish = mesh.publish.bind(mesh);
    vi.spyOn(mesh, "publish").mockImplementationOnce(async (request) => {
      persistentAgents.noteMainActivity(false);
      return originalPublish(request);
    });

    persistentAgents.dispatchHostEvent("tool_error", { signal: { idle: false } });
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");

    expect(deliveries).toEqual([]);
    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({
      action: "silent",
      stale: true,
    });
  });

  it("skips image-free input before a multimodal persistentAgent run", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "vision-handoff",
      instructions: "Describe attached images.",
      events: ["input"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      validWhile: {
        version: 1,
        source: "({ activation }) => activation.kind !== 'hostEvent' || (activation.signal?.media?.length ?? 0) > 0",
      },
    });

    persistentAgents.dispatchHostEvent("input", { signal: { payload: { text: "text only" }, idle: false } });
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(deliveries).toEqual([]);
    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({ action: "silent", stale: true });

    persistentAgents.dispatchHostEvent(
      "input",
      {
        signal: {
          payload: { text: "with image" },
          media: [{ type: "image", mediaIndex: 0, mimeType: "image/png" }],
          idle: false,
        },
      },
      [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    );
    await waitFor(() => deliveries.length === 1);
    expect(deliveries).toEqual(["fake persistentAgent advice"]);
  });

  it("rejects a blocking ask when its direct activation is invalid", async () => {
    const { persistentAgents } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "guarded-mailbox",
      instructions: "Reply.",
      validWhile: {
        version: 1,
        source: "({ activation }) => activation.kind !== 'direct'",
      },
    });
    await expect(persistentAgents.ask(persistentAgent.id, "obsolete request")).rejects.toThrow(
      /activation invalidated/,
    );
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(persistentAgents.messages(persistentAgent.id).at(-1)).toMatchObject({ stale: true, action: "silent" });
  });

  it("implements latest-activation-wins across different host event types", async () => {
    const { persistentAgents, deliveries } = setup();
    const persistentAgent = await persistentAgents.create({
      name: "reviewer",
      instructions: "Review.",
      events: ["tool_error", "agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      validWhile: {
        version: 1,
        source: "({ activation, current }) => activation.sequence === current.latestActivationSequence",
      },
    });
    persistentAgents.dispatchHostEvent("tool_error", { signal: { idle: false } });
    persistentAgents.dispatchHostEvent("agent_settled", { signal: { idle: true } });
    await waitFor(() => persistentAgents.status(persistentAgent.id).status === "idle");
    expect(deliveries).toEqual(["fake persistentAgent advice"]);
    expect(persistentAgents.messages(persistentAgent.id).some((message) => message.stale)).toBe(true);
  });
});
