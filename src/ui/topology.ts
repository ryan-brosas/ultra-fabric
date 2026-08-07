import { createHash } from "node:crypto";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricParticipantInfo } from "../topology/types.js";
import type {
  FabricUiPersistentAgent,
  FabricUiAgent,
  FabricUiMain,
  FabricUiStateEntry,
} from "./types.js";
import { isActiveStatus } from "./types.js";

export interface FabricProjectMeshTopic {
  id: string;
  name: string;
  status: string;
  system: boolean;
  subscribers: Array<{ id: string; name: string; status: string }>;
  recentEvents: number;
  lastEventAt?: number;
}

export interface FabricProjectMeshParticipant {
  id: string;
  entityId: string;
  name: string;
  status: string;
  routes: number;
  lastSeenAt: number;
  agent?: FabricUiAgent;
  participant?: FabricParticipantInfo;
}

export interface FabricProjectMeshRoute {
  id: string;
  fromId: string;
  fromName: string;
  fromKind: string;
  targetId: string;
  targetName: string;
  targetKind: "main" | "persistentAgent" | "agent" | "topic";
  topic: string;
  kind: string;
  status: string;
  count: number;
  lastAt: number;
  text?: string;
}

interface FabricProjectMeshRootRow {
  kind: "meshRoot";
  entityId: string;
  main: FabricUiMain;
  persistentAgents: number;
  agents: number;
  topics: number;
  state: number;
  routes: number;
}

interface FabricProjectMeshSectionRow {
  kind: "meshSection";
  label: string;
  count: number;
}

interface FabricProjectMeshPersistentAgentRow {
  kind: "meshPersistentAgent";
  entityId: string;
  persistentAgent: FabricUiPersistentAgent;
}

interface FabricProjectMeshAgentRow {
  kind: "meshAgent";
  entityId: string;
  participant: FabricProjectMeshParticipant;
  ancestorLast: boolean[];
  isLast: boolean;
}

interface FabricProjectMeshTopicRow {
  kind: "meshTopic";
  entityId: string;
  topic: FabricProjectMeshTopic;
}

interface FabricProjectMeshLinkRow {
  kind: "meshLink";
  relation: "subscribes";
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  status: string;
  isLast: boolean;
}

interface FabricProjectMeshStateRow {
  kind: "meshState";
  entityId: string;
  state: FabricUiStateEntry;
}

interface FabricProjectMeshRouteRow {
  kind: "meshRoute";
  entityId: string;
  route: FabricProjectMeshRoute;
}

export type FabricProjectMeshRow =
  | FabricProjectMeshRootRow
  | FabricProjectMeshSectionRow
  | FabricProjectMeshPersistentAgentRow
  | FabricProjectMeshAgentRow
  | FabricProjectMeshTopicRow
  | FabricProjectMeshLinkRow
  | FabricProjectMeshStateRow
  | FabricProjectMeshRouteRow;

export interface FabricProjectMeshModel {
  participants: FabricProjectMeshParticipant[];
  topics: FabricProjectMeshTopic[];
  routes: FabricProjectMeshRoute[];
  rows: FabricProjectMeshRow[];
  entityOrder: string[];
}

const SYSTEM_TOPICS = new Set([
  "fabric.persistentAgent.input",
  "fabric.persistentAgent.output",
  "fabric.persistentAgent.lifecycle",
  "fabric.compact",
  "fabric.participant.lifecycle",
  "fabric.steer",
  "fabric.control.command",
  "fabric.control.ack",
]);

const IGNORED_ROUTE_TOPICS = new Set([
  "fabric.persistentAgent.lifecycle",
  "fabric.compact",
  "fabric.control.ack",
]);

const eventData = (event: MeshEvent): Record<string, unknown> | undefined =>
  typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : undefined;

const failureEventKinds = new Set([
  "error",
  "failed",
  "failure",
  "blocked",
  "reject",
  "rejected",
]);

const routeStatus = (kind: string): string =>
  kind
    .toLowerCase()
    .split(/[.:/_-]+/)
    .some((part) => failureEventKinds.has(part))
    ? "failed"
    : "completed";

const projectMeshRoutes = (
  main: FabricUiMain,
  persistentAgents: FabricUiPersistentAgent[],
  agents: FabricUiAgent[],
  events: MeshEvent[],
): FabricProjectMeshRoute[] => {
  const persistentAgentByKey = new Map<string, FabricUiPersistentAgent>();
  for (const persistentAgent of persistentAgents) {
    persistentAgentByKey.set(persistentAgent.id, persistentAgent);
    persistentAgentByKey.set(persistentAgent.name, persistentAgent);
  }
  const agentByKey = new Map<string, FabricUiAgent>();
  for (const agent of agents) {
    agentByKey.set(agent.id, agent);
    agentByKey.set(agent.name, agent);
  }
  const mainByKey = new Map<string, string>([
    [main.id, main.name],
    [main.name, main.name],
    ["main", main.name],
  ]);
  for (const event of events) {
    if (event.from.kind !== "main") continue;
    mainByKey.set(event.from.id, event.from.name);
    mainByKey.set(event.from.name, event.from.name);
  }
  const routes = new Map<string, FabricProjectMeshRoute>();
  for (const event of events) {
    if (IGNORED_ROUTE_TOPICS.has(event.topic)) continue;
    const data = eventData(event);
    let targetId: string;
    let targetName: string;
    let targetKind: FabricProjectMeshRoute["targetKind"];
    const persistentAgentInputId =
      event.topic === "fabric.persistentAgent.input" && typeof data?.persistentAgentId === "string"
        ? data.persistentAgentId
        : undefined;
    const controlTarget =
      event.topic === "fabric.control.command" && typeof data?.targetId === "string"
        ? data.targetId
        : undefined;
    const addressed = controlTarget ?? event.to ?? persistentAgentInputId;
    const targetMain = addressed ? mainByKey.get(addressed) : undefined;
    const targetPersistentAgent = addressed ? persistentAgentByKey.get(addressed) : undefined;
    const targetAgent = addressed ? agentByKey.get(addressed) : undefined;
    if (targetMain) {
      targetId = addressed!;
      targetName = targetMain;
      targetKind = "main";
    } else if (targetPersistentAgent) {
      targetId = targetPersistentAgent.id;
      targetName = targetPersistentAgent.name;
      targetKind = "persistentAgent";
    } else if (targetAgent) {
      targetId = targetAgent.id;
      targetName = targetAgent.name;
      targetKind = "agent";
    } else if (addressed) {
      targetId = addressed;
      targetName = addressed;
      targetKind = "agent";
    } else if (event.topic === "fabric.persistentAgent.output") {
      targetId = main.id;
      targetName = main.name;
      targetKind = "main";
    } else {
      targetId = event.topic;
      targetName = event.topic;
      targetKind = "topic";
    }
    const key = JSON.stringify([
      event.from.id,
      event.from.kind,
      targetKind,
      targetId,
      event.topic,
      event.kind,
    ]);
    const existing = routes.get(key);
    if (existing) {
      existing.count++;
      if (event.createdAt >= existing.lastAt) {
        existing.lastAt = event.createdAt;
        if (event.text) existing.text = event.text;
        else delete existing.text;
      }
      if (routeStatus(event.kind) === "failed") existing.status = "failed";
      continue;
    }
    routes.set(key, {
      id: `route:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
      fromId: event.from.id,
      fromName: event.from.name,
      fromKind: event.from.kind,
      targetId,
      targetName,
      targetKind,
      topic: event.topic,
      kind: event.kind,
      status: routeStatus(event.kind),
      count: 1,
      lastAt: event.createdAt,
      ...(event.text ? { text: event.text } : {}),
    });
  }
  return [...routes.values()].sort((left, right) => right.lastAt - left.lastAt);
};

const projectMeshParticipants = (
  agents: FabricUiAgent[],
  routes: FabricProjectMeshRoute[],
  directoryParticipants: FabricParticipantInfo[],
): FabricProjectMeshParticipant[] => {
  const agentByKey = new Map<string, FabricUiAgent>();
  for (const agent of agents) {
    agentByKey.set(agent.id, agent);
    agentByKey.set(agent.name, agent);
  }
  const observed = new Map<
    string,
    { id: string; name: string; lastSeenAt: number; participant?: FabricParticipantInfo }
  >();
  const touch = (
    id: string,
    name: string,
    lastSeenAt: number,
    participant?: FabricParticipantInfo,
  ): void => {
    const existing = observed.get(id);
    if (!existing) {
      observed.set(id, {
        id,
        name,
        lastSeenAt,
        ...(participant ? { participant } : {}),
      });
      return;
    }
    if (lastSeenAt >= existing.lastSeenAt) {
      existing.name = name;
      existing.lastSeenAt = lastSeenAt;
    }
    if (participant) existing.participant = participant;
  };
  for (const participant of directoryParticipants) {
    const name =
      participant.kind === "root" && participant.sessionId
        ? `Peer ${participant.sessionId.slice(0, 8)}`
        : participant.name;
    touch(participant.id, name, participant.updatedAt, participant);
  }
  for (const route of routes) {
    if (route.fromKind === "agent") touch(route.fromId, route.fromName, route.lastAt);
    if (route.targetKind === "agent") touch(route.targetId, route.targetName, route.lastAt);
  }
  return [...observed.values()]
    .map((identity) => {
      const agent = agentByKey.get(identity.id) ?? agentByKey.get(identity.name);
      const routesForParticipant = routes.reduce(
        (count, route) =>
          count +
          ((route.fromKind === "agent" && route.fromId === identity.id) ||
          (route.targetKind === "agent" && route.targetId === identity.id)
            ? route.count
            : 0),
        0,
      );
      return {
        id: identity.id,
        entityId: agent ? `agent:${agent.id}` : `participant:${identity.id}`,
        name: agent?.name ?? identity.name,
        status: agent?.status ?? "idle",
        routes: routesForParticipant,
        lastSeenAt: identity.lastSeenAt,
        ...(agent ? { agent } : {}),
        ...(identity.participant ? { participant: identity.participant } : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(isActiveStatus(right.status)) - Number(isActiveStatus(left.status)) ||
        left.name.localeCompare(right.name),
    );
};

const projectParticipantTree = (
  participants: FabricProjectMeshParticipant[],
): Array<{ participant: FabricProjectMeshParticipant; ancestorLast: boolean[]; isLast: boolean }> => {
  const byId = new Map(participants.map((participant) => [participant.id, participant] as const));
  const children = new Map<string, FabricProjectMeshParticipant[]>();
  const roots: FabricProjectMeshParticipant[] = [];
  for (const participant of participants) {
    const parentId = participant.participant?.parentId ?? participant.agent?.parentId;
    if (!parentId || !byId.has(parentId) || parentId === participant.id) {
      roots.push(participant);
      continue;
    }
    const entries = children.get(parentId) ?? [];
    entries.push(participant);
    children.set(parentId, entries);
  }
  const rows: Array<{
    participant: FabricProjectMeshParticipant;
    ancestorLast: boolean[];
    isLast: boolean;
  }> = [];
  const visited = new Set<string>();
  const visit = (
    participant: FabricProjectMeshParticipant,
    ancestorLast: boolean[],
    isLast: boolean,
  ): void => {
    if (visited.has(participant.id)) return;
    visited.add(participant.id);
    rows.push({ participant, ancestorLast, isLast });
    const descendants = (children.get(participant.id) ?? []).filter(
      (candidate) => !visited.has(candidate.id),
    );
    for (let index = 0; index < descendants.length; index++) {
      const descendant = descendants[index];
      if (descendant) {
        visit(descendant, [...ancestorLast, isLast], index === descendants.length - 1);
      }
    }
  };
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (root) visit(root, [], index === roots.length - 1);
  }
  for (const participant of participants) {
    if (!visited.has(participant.id)) visit(participant, [], true);
  }
  return rows;
};

const projectMeshTopics = (
  persistentAgents: FabricUiPersistentAgent[],
  events: MeshEvent[],
  now: number,
): FabricProjectMeshTopic[] => {
  const names = new Set<string>();
  for (const persistentAgent of persistentAgents) {
    for (const topic of persistentAgent.topics) names.add(topic);
  }
  for (const event of events) {
    if (!SYSTEM_TOPICS.has(event.topic)) names.add(event.topic);
  }
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const topicEvents = events.filter((event) => event.topic === name);
      const lastEventAt = topicEvents.reduce(
        (latest, event) => Math.max(latest, event.createdAt),
        0,
      );
      const subscribers = persistentAgents
        .filter((persistentAgent) => persistentAgent.topics.includes(name))
        .map((persistentAgent) => ({ id: persistentAgent.id, name: persistentAgent.name, status: persistentAgent.status }));
      return {
        id: `topic:${name}`,
        name,
        status: lastEventAt > 0 && now - lastEventAt <= 10_000 ? "running" : "idle",
        system: SYSTEM_TOPICS.has(name),
        subscribers,
        recentEvents: topicEvents.length,
        ...(lastEventAt > 0 ? { lastEventAt } : {}),
      };
    });
};

export const buildProjectMeshTopology = (input: {
  main: FabricUiMain;
  persistentAgents: FabricUiPersistentAgent[];
  agents: FabricUiAgent[];
  state: FabricUiStateEntry[];
  events: MeshEvent[];
  participants?: FabricParticipantInfo[];
  now: number;
}): FabricProjectMeshModel => {
  const topics = projectMeshTopics(input.persistentAgents, input.events, input.now);
  const routes = projectMeshRoutes(input.main, input.persistentAgents, input.agents, input.events);
  const localPersistentAgentIds = new Set(input.persistentAgents.map((persistentAgent) => persistentAgent.id));
  const directoryParticipants = (input.participants ?? []).filter(
    (participant) =>
      participant.id !== input.main.id &&
      !(participant.kind === "persistentAgent" && localPersistentAgentIds.has(participant.id)),
  );
  const participants = projectMeshParticipants(input.agents, routes, directoryParticipants);
  const rows: FabricProjectMeshRow[] = [
    {
      kind: "meshRoot",
      entityId: `main:${input.main.id}`,
      main: input.main,
      persistentAgents: input.persistentAgents.length,
      agents: participants.length,
      topics: topics.length,
      state: input.state.length,
      routes: routes.length,
    },
  ];
  if (input.persistentAgents.length > 0) {
    rows.push({ kind: "meshSection", label: "Persistent agents", count: input.persistentAgents.length });
    for (const persistentAgent of input.persistentAgents) {
      rows.push({ kind: "meshPersistentAgent", entityId: `persistentAgent:${persistentAgent.id}`, persistentAgent });
    }
  }
  if (participants.length > 0) {
    rows.push({
      kind: "meshSection",
      label: "Project participants",
      count: participants.length,
    });
    for (const entry of projectParticipantTree(participants)) {
      rows.push({
        kind: "meshAgent",
        entityId: entry.participant.entityId,
        participant: entry.participant,
        ancestorLast: entry.ancestorLast,
        isLast: entry.isLast,
      });
    }
  }
  if (topics.length > 0) {
    rows.push({ kind: "meshSection", label: "Topics", count: topics.length });
    for (const topic of topics) {
      rows.push({ kind: "meshTopic", entityId: topic.id, topic });
      for (let index = 0; index < topic.subscribers.length; index++) {
        const subscriber = topic.subscribers[index];
        if (!subscriber) continue;
        rows.push({
          kind: "meshLink",
          relation: "subscribes",
          sourceId: subscriber.id,
          sourceName: subscriber.name,
          targetId: topic.id,
          targetName: topic.name,
          status: subscriber.status,
          isLast: index === topic.subscribers.length - 1,
        });
      }
    }
  }
  if (input.state.length > 0) {
    rows.push({ kind: "meshSection", label: "Shared state", count: input.state.length });
    for (const state of input.state) {
      rows.push({ kind: "meshState", entityId: `state:${state.key}`, state });
    }
  }
  if (routes.length > 0) {
    rows.push({ kind: "meshSection", label: "Recent routes", count: routes.length });
    for (const route of routes) {
      rows.push({ kind: "meshRoute", entityId: route.id, route });
    }
  }
  const entityOrder = rows.flatMap((row) =>
    "entityId" in row ? [row.entityId] : [],
  );
  return { participants, topics, routes, rows, entityOrder };
};
