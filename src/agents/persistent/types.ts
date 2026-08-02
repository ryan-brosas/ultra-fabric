import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { FabricAgentRunner, FabricAgentTransport } from "../../config.js";
import type { FabricThinking } from "../../thinking.js";
import type {
  FabricPersistentAgentBudgetInput,
  FabricPersistentAgentBudgetSnapshot,
} from "./budget.js";
import type { FabricLogLine, AgentRunRecord, AgentUsage } from "../types.js";
import type { FabricAgentRole } from "../role.js";
import type { AgentTurnBudget } from "../turn-budget.js";

export type FabricPersistentAgentPiHostEvent = Exclude<ExtensionEvent["type"], "project_trust">;

const defineFabricPersistentAgentPiHostEvents = <
  const Events extends readonly FabricPersistentAgentPiHostEvent[],
>(
  events: Exclude<FabricPersistentAgentPiHostEvent, Events[number]> extends never ? Events : never,
): Events => events;

export const FABRIC_PERSISTENT_AGENT_PI_HOST_EVENTS = defineFabricPersistentAgentPiHostEvents([
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "context",
  "before_provider_headers",
  "before_provider_request",
  "after_provider_response",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "user_bash",
]);

export const FABRIC_PERSISTENT_AGENT_HOST_EVENTS = [
  ...FABRIC_PERSISTENT_AGENT_PI_HOST_EVENTS,
  "tool_error",
] as const;

export type FabricPersistentAgentHostEvent = (typeof FABRIC_PERSISTENT_AGENT_HOST_EVENTS)[number];

const FABRIC_PERSISTENT_AGENT_HOST_EVENT_SET: ReadonlySet<string> = new Set(FABRIC_PERSISTENT_AGENT_HOST_EVENTS);

export const isFabricPersistentAgentHostEvent = (value: unknown): value is FabricPersistentAgentHostEvent =>
  typeof value === "string" && FABRIC_PERSISTENT_AGENT_HOST_EVENT_SET.has(value);

export type FabricPersistentAgentDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
export type FabricPersistentAgentResponseMode = "text" | "directive";
export type FabricPersistentAgentStatus = "idle" | "queued" | "running" | "stopped";
type FabricPersistentAgentCircuitState = "closed" | "open" | "half_open";

export interface FabricPersistentAgentDeliveryCircuit {
  state: FabricPersistentAgentCircuitState;
  failures: number;
  openedAt?: number;
  retryAt?: number;
}

export interface FabricPersistentAgentValidWhileSource {
  version: 1;
  source: string;
}

export interface FabricPersistentAgentValidityDecision {
  valid: boolean;
  reason?: string;
}

export type FabricPersistentAgentActivation =
  | {
      kind: "hostEvent";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
      event: FabricPersistentAgentHostEvent;
      mainRevision: number;
      taskRevision: number;
      signal?: unknown;
    }
  | {
      kind: "direct";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
    }
  | {
      kind: "mesh";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
      topic: string;
    };

export interface FabricPersistentAgentValidityFacts {
  activation: FabricPersistentAgentActivation;
  current: {
    latestActivationSequence: number;
    mainRevision: number;
    taskRevision: number;
    idle: boolean;
    now: number;
  };
}

export interface FabricPersistentAgentRequest {
  name: string;
  role?: FabricAgentRole;
  goal?: string;
  completion?: string;
  turnBudget?: AgentTurnBudget;
  instructions: string;
  /** Asynchronous observations of session-bound Pi events plus synthetic tool_error. */
  events?: FabricPersistentAgentHostEvent[];
  topics?: string[];
  /** Defaults to mailbox. steer/followUp require an explicit triggerTurn choice. */
  delivery?: FabricPersistentAgentDelivery;
  responseMode?: FabricPersistentAgentResponseMode;
  /** Required for steer/followUp; must be false or omitted for mailbox/nextTurn. */
  triggerTurn?: boolean;
  coalesce?: boolean;
  runner?: FabricAgentRunner;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricAgentTransport;
  timeoutMs?: number;
  /**
   * Fabric capability for the persistentAgent. Defaults to true (today's behavior: a Pi
   * persistentAgent is recursively Fabric-equipped with the host-required fabric_exec
   * tool). Set false to disable Fabric for a Pi persistentAgent: the activation runs with
   * extensions:false and recursive:false so fabric_exec is not injected and the
   * persistentAgent cannot call agents.* or mesh.*; the host still manages its mailbox
   * and delivery (same model as a Claude persistentAgent). This does not restrict the
   * persistentAgent's ordinary tool allowlist. Fixed at creation.
   */
  extensions?: boolean;
  /** Serialized guest predicate evaluated before work and before delivery. */
  validWhile?: FabricPersistentAgentValidWhileSource;
  /** Host-owned activation quotas. Zero or omission means unlimited. */
  budget?: FabricPersistentAgentBudgetInput;
}

export interface FabricPersistentAgentInfo {
  id: string;
  kind: "agent";
  lifecycle: "persistent";
  name: string;
  role: FabricAgentRole;
  goal: string;
  completion: string;
  turnBudget: AgentTurnBudget;
  status: FabricPersistentAgentStatus;
  runner: FabricAgentRunner;
  events: FabricPersistentAgentHostEvent[];
  topics: string[];
  delivery: FabricPersistentAgentDelivery;
  responseMode: FabricPersistentAgentResponseMode;
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  extensions?: boolean;
  validWhile?: FabricPersistentAgentValidWhileSource;
  budget?: FabricPersistentAgentBudgetSnapshot;
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
  deliveryCircuit?: FabricPersistentAgentDeliveryCircuit;
  sessionFile?: string;
  logDir?: string;
}

export interface FabricPersistentAgentLog {
  persistentAgentId: string;
  persistentAgentName: string;
  sessionFile: string;
  logDir: string;
  session: FabricLogLine[];
  sessionHasMore: boolean;
  sessionBefore?: number;
  run?: {
    runId: string;
    eventsFile: string;
    status?: AgentRunRecord;
    events: FabricLogLine[];
    hasMore: boolean;
    before?: number;
  };
  retainedRuns: string[];
}

interface FabricPersistentAgentDeliveryReceipt {
  mesh: {
    status: "published" | "failed" | "dead_lettered";
    attempts: number;
    at: number;
    error?: string;
  };
  main: {
    status:
      | "mailbox"
      | "not_requested"
      | "delivered"
      | "failed"
      | "dead_lettered"
      | "circuit_open";
    mode: FabricPersistentAgentDelivery;
    attempts: number;
    at: number;
    error?: string;
  };
}

export interface FabricPersistentAgentMessage {
  id: string;
  persistentAgentId: string;
  persistentAgentName: string;
  direction: "in" | "out";
  source: string;
  createdAt: number;
  text?: string;
  data?: unknown;
  action?: "silent" | "message" | "stop";
  runId?: string;
  runAttempts?: number;
  usage?: AgentUsage;
  error?: string;
  stale?: boolean;
  rejected?: boolean;
  deadLettered?: boolean;
  reason?: string;
  deliveryReceipt?: FabricPersistentAgentDeliveryReceipt;
}

export interface FabricPersistentAgentDirective {
  action: "silent" | "message" | "stop";
  message?: string;
  data?: unknown;
}

export interface FabricPersistentAgentDeliveryRequest {
  persistentAgent: FabricPersistentAgentInfo;
  message: FabricPersistentAgentMessage;
  delivery: Exclude<FabricPersistentAgentDelivery, "mailbox">;
  triggerTurn: boolean;
}

/**
 * A project-independent persistentAgent template stored in the global registry
 * (the user's agent dir, not a project mesh). It carries only the persistentAgent
 * definition (the same fields as FabricPersistentAgentRequest) plus identity and
 * timestamps — never any history (messages, session transcript, or run logs).
 * Agent templates are not live: they are stamped into a project via import,
 * which creates a fresh live persistentAgent with no inherited history.
 */
export interface AgentTemplateDefinition extends FabricPersistentAgentRequest {
  id: string;
  role: FabricAgentRole;
  createdAt: number;
  updatedAt: number;
  // Redeclared required: the registry always materializes these (defaults
  // applied on create and load), so they are never undefined on a stored
  // template. Keeping them required avoids undefined creeping into merges and
  // spreads under exactOptionalPropertyTypes.
  events: FabricPersistentAgentHostEvent[];
  topics: string[];
  delivery: FabricPersistentAgentDelivery;
  responseMode: FabricPersistentAgentResponseMode;
  triggerTurn: boolean;
  coalesce: boolean;
  runner: FabricAgentRunner;
}
