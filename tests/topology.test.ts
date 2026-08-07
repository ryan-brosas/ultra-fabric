import { describe, expect, it } from "vitest";
import type { MeshEvent } from "../src/mesh/store.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";
import {
  buildProjectMeshTopology,
} from "../src/ui/topology.js";
import type {
  FabricUiPersistentAgent,
  FabricUiAgent,
  FabricUiMain,
  FabricUiStateEntry,
} from "../src/ui/types.js";

const main = (): FabricUiMain => ({
  id: "session:main",
  name: "Main",
  kind: "main",
  status: "running",
  transport: "host",
  cwd: "/tmp/project",
  sessionId: "main",
  startedAt: 1,
  updatedAt: 1,
  pendingMessages: false,
  local: true,
});


const agent = (
  id: string,
  startedAt: number,
  overrides: Partial<FabricUiAgent> = {},
): FabricUiAgent => ({
  id,
  name: id,
  status: "completed",
  transport: "process",
  cwd: "/tmp/project",
  runId: "run-topology",
  phaseId: "analyze",
  startedAt,
  updatedAt: startedAt,
  ...overrides,
});

const persistentAgent = (overrides: Partial<FabricUiPersistentAgent> = {}): FabricUiPersistentAgent => ({
  id: "persistentAgent-1",
  kind: "agent",
  lifecycle: "persistent",
  name: "advisor",
  role: "advisor",
  goal: "Give bounded advice.",
  completion: "Return one recommendation, then idle.",
  turnBudget: { maxTurns: 8, graceTurns: 1 },
  status: "idle",
  events: ["turn_end"],
  topics: ["team.review"],
  delivery: "mailbox",
  responseMode: "directive",
  triggerTurn: false,
  coalesce: true,
  queued: 0,
  messages: 0,
  createdAt: 1,
  updatedAt: 1,
  instructions: "Review project decisions.",
  recentMessages: [],
  ...overrides,
});

const stateEntry = (index: number): FabricUiStateEntry => ({
  key: `tasks/task-${index}`,
  label: `Task ${index}`,
  status: index === 25 ? "blocked" : "claimed",
  owner: "advisor",
  value: { status: "claimed", owner: "advisor" },
  version: index + 1,
  updatedAt: index + 1,
});

const event = (
  id: string,
  sequence: number,
  overrides: Partial<MeshEvent> = {},
): MeshEvent => ({
  id,
  sequence,
  topic: "team.review",
  kind: "finding",
  from: { id: "persistentAgent-1", name: "advisor", kind: "persistentAgent" },
  createdAt: sequence * 100,
  ...overrides,
});

describe("Project mesh topology layout", () => {
  it("shows directory participants even before they emit a mesh route", () => {
    const participants: FabricParticipantInfo[] = [
      {
        format: 1,
        id: "session:peer",
        kind: "root",
        rootId: "session:peer",
        ownerHostId: "session:peer",
        ownerIdentityId: "session:peer",
        name: "main",
        status: "idle",
        transport: "host",
        capabilities: ["steer", "followUp", "fabric"],
        cwd: "/tmp/project",
        sessionId: "peer-session",
        startedAt: 2,
        updatedAt: 3,
        controlProtocol: "v1",
        local: false,
        stale: false,
      },
      {
        format: 1,
        id: "persistentAgent:remote",
        kind: "persistentAgent",
        rootId: "session:peer",
        ownerHostId: "session:peer",
        ownerIdentityId: "session:peer",
        parentId: "session:peer",
        name: "remote advisor",
        status: "idle",
        transport: "host",
        capabilities: ["steer", "followUp", "stop", "fabric"],
        startedAt: 2,
        updatedAt: 3,
        controlProtocol: "v1",
        local: false,
        stale: false,
      },
    ];

    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [],
      agents: [],
      state: [],
      events: [],
      participants,
      now: 1_000,
    });

    expect(model.participants).toMatchObject([
      { id: "session:peer", name: "Peer peer-ses", participant: { kind: "root" } },
      { id: "persistentAgent:remote", name: "remote advisor", participant: { kind: "persistentAgent" } },
    ]);
    expect(model.rows).toContainEqual({
      kind: "meshSection",
      label: "Project participants",
      count: 2,
    });
  });

  it("connects persistentAgents, topics, shared state, and normalized recent routes", () => {
    const persistentAgents = [persistentAgent()];
    const events: MeshEvent[] = [
      event("topic", 1),
      event("input", 2, {
        topic: "fabric.persistentAgent.input",
        kind: "message",
        from: { id: "main", name: "main", kind: "main" },
        data: { persistentAgentId: "persistentAgent-1" },
      }),
      event("output", 3, {
        topic: "fabric.persistentAgent.output",
        kind: "directive",
      }),
      event("lifecycle", 4, {
        topic: "fabric.persistentAgent.lifecycle",
        kind: "settled",
      }),
    ];

    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents,
      agents: [],
      state: [stateEntry(0)],
      events,
      now: 1_000,
    });

    expect(model.rows[0]).toMatchObject({
      kind: "meshRoot",
      entityId: "main:session:main",
      main: { id: "session:main", name: "Main", status: "running" },
    });
    expect(model.topics).toMatchObject([
      {
        id: "topic:team.review",
        subscribers: [{ id: "persistentAgent-1", name: "advisor" }],
        recentEvents: 1,
        status: "running",
      },
    ]);
    expect(model.routes).toHaveLength(3);
    expect(model.routes.map((route) => route.targetKind).sort()).toEqual([
      "main",
      "persistentAgent",
      "topic",
    ]);
    expect(model.entityOrder).toEqual([
      "main:session:main",
      "persistentAgent:persistentAgent-1",
      "topic:team.review",
      "state:tasks/task-0",
      expect.stringContaining("route:"),
      expect.stringContaining("route:"),
      expect.stringContaining("route:"),
    ]);
    expect(model.rows.some((row) => row.kind === "meshLink")).toBe(true);
  });

  it("aggregates identical traffic routes and keeps the latest payload", () => {
    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [persistentAgent()],
      agents: [],
      state: [],
      events: [
        event("first", 1, { text: "first" }),
        event("second", 2, { text: "second" }),
      ],
      now: 1_000,
    });

    expect(model.routes).toMatchObject([
      { count: 2, lastAt: 200, text: "second", targetName: "team.review" },
    ]);
  });

  it("maps known and external transient agents observed in mesh traffic", () => {
    const known = agent("worker-1", 1, { name: "researcher", status: "running" });
    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [persistentAgent()],
      agents: [known],
      state: [],
      events: [
        event("known-agent", 1, {
          from: { id: "worker-1", name: "researcher", kind: "agent" },
        }),
        event("external-agent", 2, {
          from: { id: "external-1", name: "external scout", kind: "agent" },
        }),
      ],
      now: 1_000,
    });

    expect(model.participants).toMatchObject([
      {
        id: "worker-1",
        entityId: "agent:worker-1",
        name: "researcher",
        status: "running",
        routes: 1,
        agent: { id: "worker-1" },
      },
      {
        id: "external-1",
        entityId: "participant:external-1",
        name: "external scout",
        status: "idle",
        routes: 1,
      },
    ]);
    expect(model.rows.filter((row) => row.kind === "meshAgent")).toHaveLength(2);
  });

  it("keeps structured routes distinct when free-form fields contain separators", () => {
    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [],
      agents: [],
      state: [],
      events: [
        event("separator-target", 1, {
          to: "worker|topic",
          topic: "team.review",
          kind: "finding",
          from: { id: "main-1", name: "main", kind: "main" },
        }),
        event("separator-kind", 2, {
          to: "worker",
          topic: "topic",
          kind: "team.review|finding",
          from: { id: "main-1", name: "main", kind: "main" },
        }),
      ],
      now: 1_000,
    });

    expect(model.routes).toHaveLength(2);
    expect(new Set(model.routes.map((route) => route.id)).size).toBe(2);
  });

  it("recognizes a main-session identity when traffic addresses it", () => {
    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [persistentAgent()],
      agents: [],
      state: [],
      events: [
        event("main-presence", 1, {
          from: { id: "main-1", name: "main", kind: "main" },
        }),
        event("to-main", 2, { to: "main-1" }),
      ],
      now: 1_000,
    });

    expect(model.routes).toHaveLength(2);
    expect(model.routes.some((route) => route.targetKind === "main")).toBe(true);
    expect(model.participants.some((participant) => participant.id === "main-1")).toBe(false);
  });

  it("marks explicit failure event kinds without misclassifying benign substrings", () => {
    const model = buildProjectMeshTopology({
      main: main(),
      persistentAgents: [],
      agents: [],
      state: [],
      events: [
        event("failover", 1, { kind: "failover.started" }),
        event("tool-error", 2, { kind: "tool_error" }),
      ],
      now: 1_000,
    });

    expect(model.routes.find((route) => route.kind === "failover.started")?.status).toBe(
      "completed",
    );
    expect(model.routes.find((route) => route.kind === "tool_error")?.status).toBe("failed");
  });

});