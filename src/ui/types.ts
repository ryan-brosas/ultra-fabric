import type { FabricPersistentAgentInfo, FabricPersistentAgentMessage, AgentTemplateDefinition } from "../agents/persistent/types.js";
import type { FabricActivityRun } from "../activity/types.js";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricMainAgentInfo } from "../main-agent.js";
import type {
  FabricParticipantCapability,
  FabricParticipantInfo,
  FabricParticipantKind,
  FabricPeerInfo,
} from "../topology/types.js";
import type { AgentAdmissionIntent, AgentUsage } from "../agents/types.js";
import type { ModelRouteDecision } from "../routing/model-router.js";

export type FabricUiMain = FabricMainAgentInfo;
export type FabricUiPeer = FabricPeerInfo;

export interface FabricUiAgent {
  id: string;
  name: string;
  status: string;
  transport: string;
  cwd: string;
  task?: string;
  model?: string;
  route?: ModelRouteDecision;
  profile?: string;
  admission?: AgentAdmissionIntent;
  thinking?: string;
  currentTool?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  turns?: number;
  toolCalls?: number;
  usage?: AgentUsage;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  persistentAgentId?: string;
  persistentAgentName?: string;
  runId?: string;
  phaseId?: string;
  parentId?: string;
  nestingDepth?: number;
  rootId?: string;
  ownerHostId?: string;
  local?: boolean;
  stale?: boolean;
  participantKind?: FabricParticipantKind;
  capabilities?: FabricParticipantCapability[];
}

export interface FabricUiPersistentAgent extends FabricPersistentAgentInfo {
  /** The persistentAgent's default instruction (persona text); shown and edited in the dashboard. */
  instructions: string;
  recentMessages: FabricPersistentAgentMessage[];
  worker?: FabricUiAgent;
}

export interface FabricUiStateEntry {
  key: string;
  label: string;
  status: string;
  owner?: string;
  detail?: string;
  value: unknown;
  version: number;
  updatedAt: number;
}

export interface FabricDashboardSnapshot {
  now: number;
  widgetDismissedAt?: number;
  runs: FabricActivityRun[];
  main: FabricUiMain;
  peers: FabricUiPeer[];
  participants?: FabricParticipantInfo[];
  agents: FabricUiAgent[];
  persistentAgents: FabricUiPersistentAgent[];
  /** Project-independent persistent-agent templates from the global registry. */
  agentTemplates: AgentTemplateDefinition[];
  state: FabricUiStateEntry[];
  events: MeshEvent[];
  observability?: {
    contextQos: {
      passes: number;
      retiredResults: number;
      retiredChars: number;
      protectedResults: number;
    };
    persistentAgentBudgets: {
      persistentAgents: number;
      open: number;
      lifetimeExhausted: number;
      windowExhausted: number;
      lifetimeActivations: number;
      lifetimeTokens: number;
      rejectedActivations: number;
      queueRejected: number;
      activationDeadLetters: number;
      deliveryDeadLetters: number;
    };
    outcomes: {
      records: number;
      succeeded: number;
      verified: number;
      downgraded: number;
      evaluated: number;
    };
    workflows: number;
    pathLeases: number;
  };
}

export const activeStatuses = new Set([
  "queued",
  "pending",
  "ready",
  "claimed",
  "running",
  "in_progress",
  "blocked",
]);

export const isActiveStatus = (status: string): boolean => activeStatuses.has(status);

export const orderAgentsByCreation = (agents: FabricUiAgent[]): FabricUiAgent[] =>
  agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      (left, right) =>
        (left.agent.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.agent.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ agent }) => agent);
