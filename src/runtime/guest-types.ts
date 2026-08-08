export const GUEST_TYPE_DECLARATIONS = `
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type FabricTransport = "auto" | "process" | "tmux" | "screen" | "localterm" | "herdr";
type FabricThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface FabricAction {
  ref: string;
  provider: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network" | "agent";
  effect?: "none" | "workspace" | "state" | "external";
  namespace?: string;
}
interface FabricAgentAdmissionIntent {
  reason: "independent_context" | "separable_parallel" | "capability_gap" | "long_running" | "independent_verification";
  expectedArtifact: string;
}
interface FabricModelRequirements {
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  minContextWindow?: number;
  minOutputTokens?: number;
  maxInputCost?: number;
  maxOutputCost?: number;
}
interface FabricModelRouteDecision {
  version: 1;
  requestedModel: string;
  selectedModel: string;
  kind: "primary" | "fallback";
  reason: "primary" | "primary_unavailable" | "primary_unauthenticated" | "capability_mismatch";
  quality: "preserved" | "downgraded";
  downgradeReasons: string[];
  requirements: FabricModelRequirements;
  considered: Array<{
    model: string;
    eligible: boolean;
    selected?: boolean;
    reasons: string[];
  }>;
}
type FabricAgentLifecycle = "one-shot" | "persistent" | "all";
interface FabricAgentTurnBudget {
  maxTurns: number;
  graceTurns: number;
  outcome?: "within-budget" | "wrap-up-requested" | "exceeded";
}
interface FabricAgentRoleProfile {
  name: string;
  description: string;
  lifecycle: Exclude<FabricAgentLifecycle, "all">;
  goal: string;
  completion: string;
  turnBudget: FabricAgentTurnBudget;
  tools?: string[];
  model?: string;
  thinking?: FabricThinking;
  timeoutMs?: number;
  extensions?: boolean;
  events?: FabricPersistentAgentHostEvent[];
  topics?: string[];
  delivery?: FabricPersistentAgentDelivery;
  responseMode?: "text" | "directive";
  triggerTurn?: boolean;
  coalesce?: boolean;
  freshness?: "latest" | "latest-main-revision";
  source: "builtin" | "user" | "project";
  filePath: string;
}
interface FabricAgentRoleCatalog {
  roles: FabricAgentRoleProfile[];
  diagnostics: string[];
}
interface FabricAgentRequest {
  task: string;
  name?: string;
  role?: string;
  goal?: string;
  completion?: string;
  turnBudget?: FabricAgentTurnBudget;
  transport?: FabricTransport;
  model?: string;
  profile?: string;
  admission?: FabricAgentAdmissionIntent;
  fallbackModels?: string[];
  requirements?: FabricModelRequirements;
  allowQualityDowngrade?: boolean;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  maxTokens?: number;
  extensions?: boolean;
  recursive?: boolean;
  worktree?: boolean;
  schema?: Record<string, unknown>;
}
interface FabricHandoffCall {
  readonly ref: string;
}
interface FabricHandoffFacts {
  readonly calls: readonly FabricHandoffCall[];
  count(ref?: string | readonly string[]): number;
}
type FabricHandoffPredicate = (facts: Readonly<FabricHandoffFacts>) => boolean;
interface FabricHandoffRequest {
  model: string;
  profile?: string;
  admission?: FabricAgentAdmissionIntent;
  fallbackModels?: string[];
  requirements?: FabricModelRequirements;
  allowQualityDowngrade?: boolean;
  task?: string;
  when?: FabricHandoffPredicate;
  name?: string;
  transport?: FabricTransport;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  maxTokens?: number;
  extensions?: boolean;
  recursive?: boolean;
  schema?: Record<string, unknown>;
}
interface FabricHandoffResult {
  scheduled: true;
  status: "deferred";
  boundary: "fabric_exec_end";
}
interface FabricMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}
interface FabricPeerInfo {
  id: string;
  name: string;
  kind: "peer";
  status: "idle" | "running";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}
type FabricParticipantKind = "root" | "agent";
type FabricWireParticipantKind = FabricParticipantKind | "persistentAgent";
type FabricParticipantScope = "local" | "lineage" | "project";
type FabricParticipantCapability = "steer" | "followUp" | "stop" | "attach" | "fabric";
interface FabricParticipantInfo {
  format: 1;
  id: string;
  kind: FabricParticipantKind;
  lifecycle?: "one-shot" | "persistent";
  rootId: string;
  ownerHostId: string;
  ownerIdentityId: string;
  parentId?: string;
  name: string;
  status: string;
  transport: FabricTransport | "host";
  capabilities: FabricParticipantCapability[];
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pendingMessages?: boolean;
  currentTool?: string;
  turns?: number;
  toolCalls?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  persistentAgentQueued?: number;
  persistentAgentMessages?: number;
  controlProtocol: "v1" | "legacy";
  local: boolean;
  stale: boolean;
}
type FabricLifecycleEventType =
  | "pi.input"
  | "pi.agent_start"
  | "pi.agent_end"
  | "pi.turn_end"
  | "pi.agent_settled"
  | "pi.tool_error"
  | "pi.session_compact"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "run.timed_out"
  | "run.budget_exhausted";
type FabricLifecycleDelivery = "steer" | "followUp";
interface FabricLifecycleSource {
  id: string;
  name: string;
  kind: FabricWireParticipantKind;
  rootId: string;
  ownerHostId?: string;
  ownerIdentityId?: string;
}
interface FabricLifecycleEvent {
  version: 1;
  id: string;
  sequence: number;
  event: FabricLifecycleEventType;
  source: FabricLifecycleSource;
  occurredAt: number;
  publishedAt: number;
  runId?: string;
  status?: string;
  data?: unknown;
}
interface FabricLifecycleSubscription {
  format: 1;
  id: string;
  from: string;
  events: FabricLifecycleEventType[];
  to: string;
  delivery: FabricLifecycleDelivery;
  triggerTurn: boolean;
  once: boolean;
  afterSequence: number;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string; kind: "main" | "agent" | "persistentAgent"; sessionId?: string };
  lastDeliveredAt?: number;
  lastEventId?: string;
  lastError?: string;
}
interface FabricAgentHandle {
  id: string;
  kind: "agent";
  lifecycle: "one-shot";
  role: string;
  name: string;
  goal?: string;
  completion?: string;
  turnBudget?: FabricAgentTurnBudget;
  status: string;
  transport: FabricTransport;
  cwd: string;
  model?: string;
  route?: FabricModelRouteDecision;
  profile?: string;
  admission?: FabricAgentAdmissionIntent;
  thinking?: FabricThinking;
  persistentAgentId?: string;
  persistentAgentName?: string;
  traceId?: string;
  spanId?: string;
  parentRunId?: string;
  parentSpanId?: string;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
}
interface FabricRemoteControlResult {
  queued: true;
  messageId: string;
  routed: "mesh";
  acknowledged: true;
}
interface FabricAgentResult extends FabricAgentHandle {
  task: string;
  startedAt: number;
  finishedAt?: number;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  pendingMessages?: { steering: string[]; followUp: string[] };
}
interface FabricModelInfo {
  provider: string;
  id: string;
  name: string;
  key: string;
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}
interface FabricLogLine {
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}
interface FabricAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: FabricAgentResult;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}
interface FabricPersistentAgentLog {
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
    status?: FabricAgentResult;
    events: FabricLogLine[];
    hasMore: boolean;
    before?: number;
  };
  retainedRuns: string[];
}
interface FabricCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: "read" | "write" | "execute" | "network" | "agent";
  effect?: "none" | "workspace" | "state" | "external";
  namespace?: string;
}
interface FabricCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: FabricCapabilityActionHead[];
}
interface FabricCapabilityCatalog {
  kind: "pi-fabric.capability-catalog";
  version: 1;
  root: {
    key: "capability:fabric";
    name: "Fabric capabilities";
    description: string;
    descriptorHash: string;
  };
  providers: FabricCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}
interface FabricToolsApi {
  providers(): Promise<Array<{ name: string; description: string }>>;
  catalog(args?: { provider?: string; limit?: number }): Promise<FabricCapabilityCatalog>;
  list(args?: { provider?: string; namespace?: string; query?: string; limit?: number }): Promise<FabricAction[]>;
  search(args: { query: string; limit?: number }): Promise<FabricAction[]>;
  describe(args: { ref: string }): Promise<FabricAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
  progress(args: { message: string }): Promise<void>;
  models(): Promise<FabricModelInfo[]>;
}
interface FabricCapturedToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  text: string;
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
  source: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}
interface FabricCapturedTool {
  (args?: Record<string, unknown>): Promise<FabricCapturedToolResult>;
}
type FabricExtensionsApi = Record<string, FabricCapturedTool>;
// String-primary tools (read/bash/grep/find/ls) accept a bare string; the
// runtime proxy coerces it to { <primaryField>: string }. Lets the model write
// the natural form (pi.bash("ls")) instead of pi.bash({ command: "ls" }).
// Return shapes differ by tool: read/grep/find/ls return their text as a bare
// string (e.g. const src: string = await pi.read({ path })); bash/edit/write
// return { ok, output, details } (e.g. const { output } = await pi.bash(...)).
// Common alias keys (cmd→command, query→pattern, file→path, dir→path) and a
// flat edit shape ({ path, oldText, newText }) are also accepted; the runtime
// proxy normalizes them to the canonical form before the host validates args.
// Bash timeout is measured in seconds; timeoutMs is converted from milliseconds.
// Extended near-miss repairs: find's name/filename/glob → pattern, write's
// data → content, ls's folder → path, bash's script → command; numeric option
// fields (limit/offset/context/timeout) also accept numeric strings, coerced
// at runtime (2322 diagnostics are suppressed by the type-checker by design).
// bash/edit/write envelopes are proxy-guarded so string-method access
// (.trim(), .split(), iteration) fails with an actionable TypeError pointing
// at .output instead of QuickJS's context-free "not a function" — property-
// miss (2339) checks are suppressed by design, so the runtime gives the hint.
type PiEditOperation = { oldText: string; newText: string; all?: boolean } | { old: string; new: string; all?: boolean } | { old: string; replacement: string; all?: boolean };
interface PiToolsApi {
  read(args: string | { path: string; offset?: number; limit?: number; start?: number; max?: number } | { file: string; offset?: number; limit?: number; start?: number; max?: number }): Promise<string>;
  bash(args: string | { command: string; timeout?: number; timeoutMs?: number; settle?: boolean } | { cmd: string; timeout?: number; timeoutMs?: number; settle?: boolean } | { shell: string; timeout?: number; timeoutMs?: number; settle?: boolean } | { script: string; timeout?: number; timeoutMs?: number; settle?: boolean }): Promise<{ ok: true; output: string; details: unknown } | { ok: false; output: string; details: null; exitCode: number; error: string }>;
  edit(args: { path: string; edits: PiEditOperation[]; all?: boolean } | { file: string; edits: PiEditOperation[]; all?: boolean } | { path: string; oldText: string; newText: string; all?: boolean } | { file: string; oldText: string; newText: string; all?: boolean } | { path: string; old: string; new: string; all?: boolean } | { path: string; old: string; replacement: string; all?: boolean }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(path: string, oldText: string, newText: string): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: { path: string; content: string } | { file: string; content: string } | { path: string; contents: string } | { path: string; body: string } | { path: string; text: string } | { path: string; data: string }): Promise<{ ok: true; output: string; details: unknown }>;
  write(path: string, content: string): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: string | { pattern: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { query: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { regex: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { search: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number }): Promise<string>;
  grep(pattern: string, path?: string, limit?: number): Promise<string>;
  find(args: string | { pattern: string; path?: string; limit?: number; max?: number } | { query: string; path?: string; limit?: number; max?: number } | { regex: string; path?: string; limit?: number; max?: number } | { search: string; path?: string; limit?: number; max?: number } | { name: string; path?: string; limit?: number; max?: number } | { filename: string; path?: string; limit?: number; max?: number } | { glob: string; path?: string; limit?: number; max?: number }): Promise<string>;
  find(pattern: string, path?: string, limit?: number): Promise<string>;
  ls(args?: string | { path?: string; limit?: number; max?: number } | { dir?: string; folder?: string; limit?: number; max?: number } | { file?: string; limit?: number; max?: number }): Promise<string>;
}
type FabricPersistentAgentHostEvent =
  | "resources_discover"
  | "session_start"
  | "session_info_changed"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "session_compact"
  | "session_shutdown"
  | "session_before_tree"
  | "session_tree"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "context"
  | "before_provider_headers"
  | "before_provider_request"
  | "after_provider_response"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "model_select"
  | "thinking_level_select"
  | "user_bash"
  | "tool_error";
type FabricPersistentAgentDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
interface FabricPersistentAgentHostMediaDescriptor {
  readonly type: "image";
  readonly mediaIndex: number;
  readonly mimeType: string;
}
interface FabricPersistentAgentHostSignal {
  readonly payload: unknown;
  readonly media?: readonly FabricPersistentAgentHostMediaDescriptor[];
  readonly idle: boolean;
  readonly observedAt: number;
}
type FabricPersistentAgentActivation =
  | { readonly kind: "hostEvent"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number; readonly event: FabricPersistentAgentHostEvent; readonly mainRevision: number; readonly taskRevision: number; readonly signal?: FabricPersistentAgentHostSignal }
  | { readonly kind: "direct"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number }
  | { readonly kind: "mesh"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number; readonly topic: string };
interface FabricPersistentAgentValidityFacts {
  readonly activation: Readonly<FabricPersistentAgentActivation>;
  readonly current: Readonly<{ latestActivationSequence: number; mainRevision: number; taskRevision: number; idle: boolean; now: number }>;
}
type FabricPersistentAgentValidityDecision = boolean | { valid: boolean; reason?: string };
type FabricPersistentAgentValidWhile = (facts: Readonly<FabricPersistentAgentValidityFacts>) => FabricPersistentAgentValidityDecision;
interface FabricPersistentAgentRequestBase {
  name: string;
  role?: string;
  instructions: string;
  goal?: string;
  completion?: string;
  turnBudget?: FabricAgentTurnBudget;
  events?: FabricPersistentAgentHostEvent[];
  topics?: string[];
  responseMode?: "text" | "directive";
  coalesce?: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricTransport;
  timeoutMs?: number;
  extensions?: boolean;
  validWhile?: FabricPersistentAgentValidWhile;
  budget?: {
    lifetimeActivations?: number;
    windowActivations?: number;
    windowMs?: number;
  };
}
type FabricPersistentAgentRequest = FabricPersistentAgentRequestBase & (
  | { delivery?: "mailbox"; triggerTurn?: false }
  | { delivery: "nextTurn"; triggerTurn?: false }
  | { delivery: "steer" | "followUp"; triggerTurn: boolean }
);
interface FabricPersistentAgentInfo {
  id: string;
  kind: "agent";
  lifecycle: "persistent";
  role: string;
  name: string;
  goal: string;
  completion: string;
  turnBudget: FabricAgentTurnBudget;
  status: "idle" | "queued" | "running" | "stopped";
  events: FabricPersistentAgentHostEvent[];
  topics: string[];
  delivery: FabricPersistentAgentDelivery;
  responseMode: "text" | "directive";
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  extensions?: boolean;
  validWhile?: { version: 1; source: string };
  budget?: {
    policy: { lifetimeActivations: number; windowActivations: number; windowMs: number };
    usage: {
      lifetimeActivations: number;
      lifetimeTokens: number;
      windowStartedAt: number;
      windowActivations: number;
      windowTokens: number;
      rejectedActivations: number;
      lastRejectedAt?: number;
      lastRejection?: "lifetime_exhausted" | "window_exhausted";
    };
    admission: "open" | "lifetime_exhausted" | "window_exhausted";
  };
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
  deliveryCircuit?: {
    state: "closed" | "open" | "half_open";
    failures: number;
    openedAt?: number;
    retryAt?: number;
  };
  sessionFile?: string;
  logDir?: string;
}
type FabricAgentTemplate = FabricPersistentAgentRequest & {
  id: string;
  createdAt: number;
  updatedAt: number;
};

interface FabricPersistentAgentMessage {
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
  error?: string;
  stale?: boolean;
  rejected?: boolean;
  deadLettered?: boolean;
  reason?: string;
  deliveryReceipt?: {
    mesh: {
      status: "published" | "failed" | "dead_lettered";
      attempts: number;
      at: number;
      error?: string;
    };
    main: {
      status: "mailbox" | "not_requested" | "delivered" | "failed" | "dead_lettered" | "circuit_open";
      mode: FabricPersistentAgentDelivery;
      attempts: number;
      at: number;
      error?: string;
    };
  };
}
interface FabricAgentsApi {
  run(args: FabricAgentRequest): Promise<FabricAgentResult>;
  roles(args?: { lifecycle?: Exclude<FabricAgentLifecycle, "all"> }): Promise<FabricAgentRoleCatalog>;
  handoff(args: FabricHandoffRequest): Promise<FabricHandoffResult>;
  spawn(args: FabricAgentRequest): Promise<FabricAgentHandle>;
  wait(args: { id: string }): Promise<FabricAgentResult>;
  status(args: { id: string }): Promise<FabricAgentResult | FabricAgentHandle | FabricMainAgentInfo | FabricPersistentAgentInfo | FabricParticipantInfo>;
  list(args: { scope?: "local"; lifecycle: "persistent" }): Promise<FabricPersistentAgentInfo[]>;
  list(args: { scope: "lineage" | "project"; lifecycle: "persistent" }): Promise<Array<FabricPersistentAgentInfo | FabricParticipantInfo>>;
  list(args: { scope?: "local"; lifecycle: "all" }): Promise<Array<FabricAgentResult | FabricAgentHandle | FabricPersistentAgentInfo>>;
  list(args: { scope: "lineage" | "project"; lifecycle: "all" }): Promise<Array<FabricAgentResult | FabricAgentHandle | FabricPersistentAgentInfo | FabricParticipantInfo>>;
  list(args?: { scope?: FabricParticipantScope; lifecycle?: "one-shot" }): Promise<Array<FabricAgentResult | FabricAgentHandle | FabricParticipantInfo>>;
  list(args: { scope?: FabricParticipantScope; lifecycle: FabricAgentLifecycle }): Promise<Array<FabricAgentResult | FabricAgentHandle | FabricPersistentAgentInfo | FabricParticipantInfo>>;
  members(args?: { scope?: FabricParticipantScope; kinds?: FabricParticipantKind[]; includeStale?: boolean }): Promise<FabricParticipantInfo[]>;
  self(): Promise<FabricParticipantInfo>;
  main(): Promise<FabricMainAgentInfo>;
  peers(): Promise<FabricPeerInfo[]>;
  subscribe(args: {
    from: string;
    events: FabricLifecycleEventType[];
    to?: string;
    delivery: FabricLifecycleDelivery;
    triggerTurn: boolean;
    once?: boolean;
  }): Promise<FabricLifecycleSubscription>;
  subscriptions(args?: { from?: string; to?: string }): Promise<FabricLifecycleSubscription[]>;
  unsubscribe(args: { id: string }): Promise<{ removed: boolean }>;
  models(args?: { runner?: FabricAgentRunner; refresh?: boolean }): Promise<FabricModelInfo[]>;
  stop(args: { id: string }): Promise<FabricAgentResult | FabricPersistentAgentInfo | FabricRemoteControlResult>;
  cleanup(args: { id: string; deleteBranch?: boolean }): Promise<{ cleaned: boolean }>;
  create(args: FabricPersistentAgentRequest): Promise<FabricPersistentAgentInfo>;
  templates(): Promise<FabricAgentTemplate[]>;
  setModel(args: { id: string; model?: string }): Promise<FabricPersistentAgentInfo>;
  setThinking(args: { id: string; thinking?: FabricThinking }): Promise<FabricPersistentAgentInfo>;
  setTools(args: { id: string; tools: string[]; scope?: "project" | "global" }): Promise<FabricPersistentAgentInfo>;
  setEvents(args: { id: string; events: FabricPersistentAgentHostEvent[] }): Promise<FabricPersistentAgentInfo>;
  setDeliveryPolicy(args: {
    id: string;
    delivery: FabricPersistentAgentDelivery;
    triggerTurn: boolean;
    scope?: "project" | "global";
  }): Promise<FabricPersistentAgentInfo>;
  setInstructions(args: {
    id: string;
    instructions: string;
    scope?: "project" | "global";
  }): Promise<FabricPersistentAgentInfo>;
  ask(args: { id: string; message: string; data?: unknown; maxTokens?: number }): Promise<FabricPersistentAgentMessage>;
  tell(args: { id: string; message: string; data?: unknown; maxTokens?: number }): Promise<{ queued: true; messageId: string }>;
  steer(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh"; acknowledged?: boolean }>;
  followUp(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh"; acknowledged?: boolean }>;
  setSteeringMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  setFollowUpMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  telemetry(): Promise<{
    persistent: number;
    open: number;
    lifetimeExhausted: number;
    windowExhausted: number;
    lifetimeActivations: number;
    lifetimeTokens: number;
    rejectedActivations: number;
    queueRejected: number;
    activationDeadLetters: number;
    deliveryDeadLetters: number;
  }>;
  messages(args: { id: string; limit?: number }): Promise<FabricPersistentAgentMessage[]>;
  retryDelivery(args: { id: string; messageId: string }): Promise<FabricPersistentAgentMessage>;
  remove(args: { id: string }): Promise<{ removed: boolean }>;
  log(args: {
    id: string;
    type?: "session" | "run" | "all";
    lines?: number;
    before?: number;
    runId?: string;
  }): Promise<FabricPersistentAgentLog | FabricAgentLog>;
}
interface FabricMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
interface FabricMcpTool {
  (args?: Record<string, unknown>): Promise<FabricMcpResult | unknown>;
}
interface FabricMcpServer {
  [tool: string]: FabricMcpTool;
}
type FabricMcpApi = Record<string, FabricMcpServer> & {
  servers(): Promise<Array<{ name: string; description: string | null; transport: "http" | "stdio" }>>;
  reload(): Promise<{ servers: string[] }>;
  register(args: {
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    overwrite?: boolean;
  }): Promise<{ registered: string }>;
  call(args: { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown>;
};
interface FabricCouncilRunOptions {
  task: string;
  roles: string[];
  transport?: FabricTransport;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  worktree?: boolean;
}
interface FabricCouncilApi {
  run(args: FabricCouncilRunOptions & { synthesize?: true }): Promise<FabricAgentResult>;
  run(args: FabricCouncilRunOptions & { synthesize: false }): Promise<FabricAgentResult[]>;
}
interface FabricConsultPerspective {
  id: string;
  question: string;
  scope?: string[];
  model?: string;
}
type FabricConsultMode = "auto" | "partition" | "challenge" | "compare";
interface FabricConsultRequest {
  objective: string;
  decision: string;
  mode?: FabricConsultMode;
  proposal?: string;
  admission: {
    justification: "context_capacity" | "independent_verification" | "structural_diversity";
    independence: string;
    couldChange: string;
  };
  perspectives: FabricConsultPerspective[];
}
interface FabricConsultEvidence {
  path: string;
  line?: number;
  endLine?: number;
  claim: string;
  ref: string;
}
interface FabricConsultFinding {
  perspectiveId: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  evidence: FabricConsultEvidence[];
}
interface FabricConsultRecommendation {
  perspectiveId: string;
  recommendation: string;
}
interface FabricConsultResult {
  format: 1;
  status:
    | "success"
    | "partial"
    | "inconclusive"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "not_admitted";
  mode?: Exclude<FabricConsultMode, "auto">;
  decision?: string;
  couldChange?: string;
  context: { tokens: number | null; contextWindow: number; ratio: number | null };
  admission?: { code: string; message: string };
  coverage: {
    requested: number;
    started: number;
    completed: number;
    accepted: number;
    failed: number;
    rejected: number;
    missing: string[];
  };
  evidenceCount: number;
  findings: FabricConsultFinding[];
  recommendations: FabricConsultRecommendation[];
  consensus?: string;
  disagreements: FabricConsultRecommendation[];
  risks: string[];
  uncertainty: string[];
  silent?: boolean;
  perspectives: Array<{
    perspectiveId: string;
    status: "completed" | "failed" | "stopped" | "timed_out" | "budget_exhausted" | "not_started" | "accepted" | "silent" | "rejected";
    stance?: "support" | "challenge" | "mixed" | "silent";
    acceptedFindings: number;
    rejectedEvidence: number;
    model?: string;
    error?: string;
    usage?: { tokens: number; cost: number };
  }>;
  usage: { tokens: number; cost: number };
}
interface FabricConsultApi {
  run(args: FabricConsultRequest): Promise<FabricConsultResult>;
}
interface FabricMeshIdentity {
  id: string;
  name: string;
  kind: "main" | "persistentAgent" | "agent";
  sessionId?: string;
}
interface FabricMeshEvent {
  id: string;
  sequence: number;
  topic: string;
  kind: string;
  from: FabricMeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  createdAt: number;
}
interface FabricMeshStateEntry<T = unknown> {
  key: string;
  value: T;
  version: number;
  updatedAt: number;
  updatedBy: FabricMeshIdentity;
}
interface FabricMeshApi {
  self(): Promise<FabricMeshIdentity>;
  publish(args: { topic: string; kind?: string; to?: string; text?: string; data?: unknown }): Promise<FabricMeshEvent>;
  read(args?: { after?: number; topic?: string; to?: string; limit?: number }): Promise<FabricMeshEvent[]>;
  members(args?: { scope?: FabricParticipantScope; kinds?: FabricParticipantKind[]; includeStale?: boolean; limit?: number }): Promise<FabricParticipantInfo[]>;
  get<T = unknown>(args: { key: string }): Promise<FabricMeshStateEntry<T> | null>;
  list<T = unknown>(args?: { prefix?: string; limit?: number }): Promise<Array<FabricMeshStateEntry<T>>>;
  put<T = unknown>(args: { key: string; value: T; ifVersion?: number }): Promise<FabricMeshStateEntry<T>>;
  delete(args: { key: string; ifVersion?: number }): Promise<{ deleted: boolean; version?: number }>;
}
type FabricMemoryBranches = "active" | "all";
interface FabricMemoryEntryRange {
  first: number;
  last: number;
}
interface FabricMemoryRecallArgs {
  query?: string;
  queryMode?: "literal" | "regex";
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  scope?: string;
  page?: number;
  pageSize?: number;
  role?: string;
  tool?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  since?: number;
  until?: number;
  entryRange?: FabricMemoryEntryRange;
}
interface FabricMemoryRecallResult {
  scope?: string;
  branches?: FabricMemoryBranches;
  query?: string | null;
  queryMode?: "literal" | "regex";
  matchMode?: "browse" | "lexical" | "regex" | "structural" | "combined";
  structuralFilters?: {
    role?: string;
    tool?: string;
    ref?: string;
    provider?: string;
    action?: string;
    outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
    since?: number;
    until?: number;
  };
  matchedCount?: number;
  totalMatches?: number;
  totalItems?: number;
  segmentCount?: number;
  segments?: unknown[];
  digestHits?: unknown[];
  items?: unknown[];
  page?: number;
  pageSize?: number;
  hasNext?: boolean;
  coverage?: unknown;
  text?: string;
  error?: { code: string; message: string; [key: string]: unknown };
}
interface FabricMemoryExpandArgs {
  session: string;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: FabricMemoryEntryRange;
}
interface FabricMemoryExpandResult {
  session?: string;
  sourceHash?: string;
  branches?: FabricMemoryBranches;
  lineageFingerprint?: string;
  expanded?: unknown[];
  error?: { code: string; message: string; [key: string]: unknown };
}
interface FabricMemorySessionInfo {
  id: string;
  file: string;
  cwd: string;
  mtime: number;
  entryCount: number;
  tier: "hot" | "cold";
  branches: FabricMemoryBranches;
  lineageFingerprint: string | null;
}
interface FabricMemoryApi {
  recall(args?: FabricMemoryRecallArgs): Promise<FabricMemoryRecallResult>;
  expand(args: FabricMemoryExpandArgs): Promise<FabricMemoryExpandResult>;
  sessions(args?: { scope?: string; branches?: FabricMemoryBranches }): Promise<{
    scope?: string;
    branches?: FabricMemoryBranches;
    sessions?: FabricMemorySessionInfo[];
    error?: { code: string; message: string; [key: string]: unknown };
  }>;
}
interface FabricStateTransitionArgs {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: "state" | "representation";
  complexity?: { files: string[] };
  force?: boolean;
}
interface FabricStateComplexityFile {
  file: string;
  supported: boolean;
  language?: string;
  current?: number;
  recorded?: number;
  delta?: number;
  recordedDelta?: number;
}
interface FabricStateVerificationResult {
  certified: boolean;
  violated: boolean;
  certificationStatus: "certified" | "failed";
  results: unknown[];
  failures: unknown[];
  certificate?: unknown;
  reportingError?: string;
  evidenceDigest: string;
  resultDigest: string;
}
interface FabricOutcomeRecord {
  format: 1;
  id: string;
  runId: string;
  traceId: string;
  objectiveDigest: string;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tokens: number;
  cost: number;
  gateVerdict: "none" | "passed" | "revise" | "abort" | "crashed";
  evidenceCount: number;
  routes: Array<{ requestedModel: string; selectedModel: string; reason: string; quality: "preserved" | "downgraded" }>;
  verified: boolean;
  downgraded: boolean;
  admissionReasons: string[];
  consult?: {
    status: "success" | "partial" | "inconclusive" | "failed" | "cancelled" | "timed_out" | "budget_exhausted" | "not_admitted";
    mode?: "partition" | "challenge" | "compare";
    admissionCode?: string;
    requested: number;
    started: number;
    completed: number;
    accepted: number;
    failed: number;
    rejected: number;
    evidenceCount: number;
    contextRatio: number | null;
    workerTokens: number;
    workerCost: number;
  };
  evaluations: Array<{ kind: "deterministic" | "model_judge"; scorer: string; evaluator?: string; score: number; passed: boolean; evaluatedAt?: number }>;
  recordedAt: number;
}
interface FabricPathLease {
  id: string;
  ownerRunId: string;
  path: string;
  scope: "file" | "tree";
  acquiredAt: number;
  expiresAt: number;
}
interface FabricLeasesApi {
  acquire(args: {
    paths: Array<{ path: string; scope: "file" | "tree" }>;
    ttlMs: number;
  }): Promise<{ leases: FabricPathLease[] }>;
  release(args: { ids: string[] }): Promise<{ released: string[] }>;
  list(): Promise<FabricPathLease[]>;
}
interface FabricOutcomeConfidence {
  low: number;
  high: number;
}
interface FabricOutcomeCandidate {
  model: string;
  samples: number;
  successRate: number;
  successConfidence: FabricOutcomeConfidence;
  verifiedRate: number;
  verifiedConfidence: FabricOutcomeConfidence;
  averageDurationMs: number;
  averageTokens: number;
  averageCost: number;
  downgradeRate: number;
  admissionReasons: Record<string, number>;
  averageScore?: number;
}
interface FabricOutcomeReport {
  status: "insufficient_samples" | "recommended";
  minimumSamples: number;
  recommendedModel?: string;
  candidates: FabricOutcomeCandidate[];
  excluded: Array<{ model: string; samples: number; reason: "insufficient_samples" }>;
}
interface FabricOutcomesApi {
  list(args?: { limit?: number }): Promise<FabricOutcomeRecord[]>;
  status(args: { id: string }): Promise<FabricOutcomeRecord>;
  evaluate(args: { id: string; scorer: "exact" | "contains" | "numeric"; actual: unknown; expected: unknown; tolerance?: number }): Promise<FabricOutcomeRecord>;
  judge(args: { id: string; scorer: string; evaluator: string; score: number; passed: boolean }): Promise<FabricOutcomeRecord>;
  recommend(): Promise<FabricOutcomeReport>;
}
interface FabricStateApi {
  transition(args: FabricStateTransitionArgs): Promise<{ event: FabricMeshEvent; head: unknown }>;
  get(): Promise<{
    head: unknown | null;
    goal: { check: string; description?: string } | null;
    complexity: { files: number; decisionPoints: number; lastNetDelta: number };
    certification: { current: unknown | null; recent: unknown[] };
    recentLabels: string[];
  }>;
  history(args?: { label?: string; limit?: number; includeArchived?: boolean }): Promise<{
    transitions: unknown[];
    labels: string[];
    certifications: unknown[];
  }>;
  complexity(args?: { files?: string[] }): Promise<{ files: FabricStateComplexityFile[]; netDelta: number }>;
  verify(args?: { labels?: string[]; includeArchived?: boolean; timeoutMs?: number }): Promise<FabricStateVerificationResult>;
  goal(args: { check: string; description?: string }): Promise<FabricMeshStateEntry<{ check: string; description?: string }>>;
  checkGoal(args?: { timeoutMs?: number }): Promise<{
    passed: boolean;
    output: string;
    exitCode: number | null;
    error?: string;
  }>;
}
type FabricSchemaEvidence =
  | { kind: "file_exists"; path: string }
  | { kind: "file_absent"; path: string }
  | { kind: "file_contains"; path: string; literal: string }
  | { kind: "file_sha256"; path: string; sha256: string }
  | { kind: "trusted_command"; name: string };
type FabricSchemaFileOperation =
  | { kind: "write"; path: string; content: string; expected: { absent: true } | { sha256: string } }
  | { kind: "edit"; path: string; oldText: string; newText: string; expectedSha256: string }
  | { kind: "delete"; path: string; expectedSha256: string };
interface FabricSchemaEvidenceResult {
  evidence: FabricSchemaEvidence;
  status: "confirmed" | "nonconfirmed" | "error";
  detail: string;
  exitCode?: number | null;
  output?: string;
  observedSha256?: string;
}
interface FabricSchemaStatus {
  mode: "off" | "audit" | "enforce";
  certificateTtlMs: number;
  maxFiles: number;
  maxBytes: number;
  trustedCommands: string[];
  generation: number;
  lastOutcome: "committed" | "rolled_back" | "quarantined" | null;
  hypotheses: Array<{
    id: string;
    label: string;
    status: string;
    generation: number;
    updatedAt: number;
  }>;
}
interface FabricSchemaVerificationResult {
  verified: boolean;
  hypothesisId: string;
  certificate?: string;
  issuedAt?: number;
  expiresAt?: number;
  reason?: string;
  results: FabricSchemaEvidenceResult[];
}
interface FabricSchemaCommitResult {
  outcome: "committed" | "rolled_back" | "quarantined";
  transactionId: string;
  generation?: number;
  paths?: string[];
  postconditions?: FabricSchemaEvidenceResult[];
  complexityReductionCertified?: boolean;
  stateTransition?: unknown;
  error?: string;
  rollbackError?: string;
}
interface FabricSchemaApi {
  status(): Promise<FabricSchemaStatus>;
  hypothesize(args: {
    label: string;
    summary: string;
    evidence: FabricSchemaEvidence[];
    complexityReduction?: boolean;
  }): Promise<{
    hypothesisId: string;
    status: string;
    state: unknown;
    fingerprint: string;
    generation: number;
  }>;
  verify(args: { hypothesisId: string }): Promise<FabricSchemaVerificationResult>;
  commit(args: {
    hypothesisId: string;
    certificate: string;
    operations: FabricSchemaFileOperation[];
    postconditions: FabricSchemaEvidence[];
  }): Promise<FabricSchemaCommitResult>;
  abort(args: { hypothesisId: string; certificate?: string }): Promise<{
    aborted: true;
    hypothesisId: string;
  }>;
}
interface FabricCompactPendingIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy: string;
  requestedAt: number;
}
interface FabricCompactLastCommit {
  at: number;
  requestedBy: string;
  status: "committed" | "cancelled" | "failed";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}
interface FabricCompactApi {
  request(args?: {
    reason?: string;
    instructions?: string;
    preserve?: string[];
    requestedBy?: string;
  }): Promise<{ requested: true; intent: FabricCompactPendingIntent }>;
  status(): Promise<{ pending?: FabricCompactPendingIntent; last?: FabricCompactLastCommit }>;
  cancel(): Promise<{ cancelled: true }>;
}

interface FabricPrewalkChecklistItem {
  task: string;
  validation: string;
}
interface FabricPrewalkSchemaReference {
  repository: string;
  question: string;
  evidenceRefs: string[];
}
interface FabricPrewalkSchemaLocalScope {
  files: string[];
  symbols: string[];
  cascadeRefs: string[];
}
interface FabricPrewalkSchemaContract {
  intent: string;
  references: FabricPrewalkSchemaReference[];
  localScope: FabricPrewalkSchemaLocalScope;
  invariants: string[];
  postconditions: string[];
}
interface FabricPrewalkChecklist {
  items: FabricPrewalkChecklistItem[];
  readyAt: number;
  // Trivial-path escape: a task that clearly fits in one or two small edits
  // records the trivial disposition through the same checklist call, so the
  // controller suppresses the mutation boundary and the executor handoff
  // instead of forcing the 5-9 item ceremony and a model swap.
  trivial?: boolean;
  // Easy-path router: a bounded mid-tier task still hands off to the executor
  // (unlike trivial) but relaxes the planning ceremony to 2-4 items so Main
  // skips deep research on it.
  easy?: boolean;
  schema?: FabricPrewalkSchemaContract;
}
interface FabricPrewalkApi {
  checklist(
    input:
      | { trivial: true }
      | { items: FabricPrewalkChecklistItem[]; easy?: boolean; trivial?: false; schema: FabricPrewalkSchemaContract },
  ): Promise<FabricPrewalkChecklist>;
}

interface FabricWorkflowAgentOptions extends Omit<FabricAgentRequest, "task"> {
  label?: string;
}
type FabricActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
type FabricActivityKind = "agent" | "persistentAgent" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";
interface FabricWorkflowDisplay {
  name?: string;
  description?: string;
}
interface FabricWorkflowPhaseOptions {
  id?: string;
  description?: string;
  total?: number;
}
interface FabricWorkflowPhaseInput extends FabricWorkflowPhaseOptions {
  name: string;
}
interface FabricWorkflowItem {
  id: string;
  label: string;
  status?: FabricActivityStatus;
  phase?: string;
  detail?: string;
  kind?: FabricActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}
type FabricWorkflowEvidenceKind = "command" | "artifact" | "trace" | "custom";
interface FabricWorkflowEvidenceRef {
  kind: FabricWorkflowEvidenceKind;
  ref: string;
  digest?: string;
}
interface FabricWorkflowGateInput {
  gate: string;
  passed: boolean;
  disposition: "advise" | "revise" | "abort";
  evidence: FabricWorkflowEvidenceRef[];
  reason?: string;
  error?: string;
}
interface FabricWorkflowGateResult extends FabricWorkflowGateInput {
  sequence: number;
  recordedAt: number;
  decision: "continue" | "revise" | "abort";
  revision: number;
  failure?: "gate_failed" | "gate_crashed" | "revision_limit";
}

interface FabricWorkflowRunEnvelope {
  version: 1;
  runId: string;
  traceId: string;
  spanId: string;
  parentRunId?: string;
  parentSpanId?: string;
  objectiveDigest: string;
  startedAt: number;
  deadline: number;
  cancellationOwner: string;
}
interface FabricWorkflowRunBudget {
  agents: { limit: number; spent: number; reserved: number; remaining: number };
  tokens: { limit: number; spent: number; reserved: number; remaining: number };
}
interface FabricWorkflowRunContext {
  run: FabricWorkflowRunEnvelope;
  budget: FabricWorkflowRunBudget;
}

type FabricDurablePhaseStatus = "pending" | "ready" | "running" | "completed" | "failed" | "cancelled";
interface FabricDurablePhaseDefinition {
  id: string;
  deps?: string[];
  objective?: string;
  maxAttempts?: number;
}
interface FabricDurablePhase extends FabricDurablePhaseDefinition {
  status: FabricDurablePhaseStatus;
  attempt: number;
  objectiveDigest?: string;
  ownerRunId?: string;
  ownerTraceId?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  evidence?: FabricWorkflowEvidenceRef[];
  outputDigest?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
interface FabricDurableWorkflowRecord {
  format: 1;
  id: string;
  name: string;
  definitionDigest: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  leaseMs: number;
  phases: FabricDurablePhase[];
  createdAt: number;
  updatedAt: number;
  cancelledAt?: number;
  cancelReason?: string;
}
interface FabricDurableClaim {
  workflowId: string;
  leaseToken: string;
  leaseExpiresAt: number;
  phase: FabricDurablePhase;
}
interface FabricDurableRunPhase<T = unknown> extends FabricDurablePhaseDefinition {
  retryable?: boolean;
  run(context: {
    phase: FabricDurablePhase;
    workflow: FabricDurableWorkflowRecord;
    results: Record<string, unknown>;
  }): Promise<T> | T;
}
interface FabricDurableWorkflowApi {
  create(definition: { id: string; name: string; phases: FabricDurablePhaseDefinition[]; leaseMs?: number }): Promise<FabricDurableWorkflowRecord>;
  status(id: string): Promise<FabricDurableWorkflowRecord>;
  list(limit?: number): Promise<FabricDurableWorkflowRecord[]>;
  claim(id: string, phaseId?: string): Promise<FabricDurableClaim | undefined>;
  complete(id: string, input: { phaseId: string; leaseToken: string; evidence?: FabricWorkflowEvidenceRef[]; output?: unknown }): Promise<FabricDurableWorkflowRecord>;
  fail(id: string, input: { phaseId: string; leaseToken: string; error: string; retryable?: boolean }): Promise<FabricDurableWorkflowRecord>;
  resume(id: string): Promise<FabricDurableWorkflowRecord>;
  cancel(id: string, reason?: string): Promise<FabricDurableWorkflowRecord>;
  run<T = unknown>(definition: { id: string; name: string; phases: FabricDurableRunPhase<T>[]; leaseMs?: number }): Promise<{ workflow: FabricDurableWorkflowRecord; results: Record<string, T> }>;
}

interface FabricWorkflowApi {
  context(): Promise<FabricWorkflowRunContext>;
  durable: FabricDurableWorkflowApi;
  agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
  parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
  parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
  pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
  configure(display: FabricWorkflowDisplay): Promise<FabricWorkflowDisplay>;
  phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
  phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
  item(item: FabricWorkflowItem): Promise<FabricWorkflowItem>;
  gate(input: FabricWorkflowGateInput): Promise<FabricWorkflowGateResult>;
  event(event: { message: string; level?: "info" | "success" | "warning" | "error"; data?: unknown }): Promise<void>;
  log(...values: unknown[]): void;
  budget: { total: number; spent(): number; remaining(): number };
}
declare const tools: FabricToolsApi;
declare const pi: PiToolsApi;
declare const extensions: FabricExtensionsApi;
declare const agents: FabricAgentsApi;
declare const mesh: FabricMeshApi;
declare const mcp: FabricMcpApi;
declare const memory: FabricMemoryApi;
declare const state: FabricStateApi;
declare const schema: FabricSchemaApi;
declare const compact: FabricCompactApi;
declare const outcomes: FabricOutcomesApi;
declare const leases: FabricLeasesApi;
declare const council: FabricCouncilApi;
declare const consult: FabricConsultApi;
declare const prewalk: FabricPrewalkApi;
declare const workflow: FabricWorkflowApi;
declare function agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
declare function parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
declare function parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
declare function pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
declare function phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
declare function phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
declare function log(...values: unknown[]): void;
declare const budget: FabricWorkflowApi["budget"];
type FabricRlmRequest = Omit<FabricAgentRequest, "runner" | "recursive"> & { runner?: "pi" };
declare const rlm: { query(args: FabricRlmRequest): Promise<FabricAgentResult> };
interface FabricConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: FabricConsole;
declare const π: Readonly<Record<string, string>>;
// Session carry namespace: a plain mutable object injected into every
// fabric_exec run. Mutations survive across fabric_exec calls within the
// same Pi session (CodeAct REPL pattern) and come back on the next call.
// Only JSON-serializable values persist (functions and undefined are
// dropped), the payload is size-bounded, and the namespace is cleared on
// session start. Not updated when the run is aborted or times out.
declare const carry: Record<string, unknown>;
declare function print(...args: unknown[]): void;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
`;

const FULL_CODE_GLOBAL_DECLARATIONS = [
  "declare const pi: PiToolsApi;\n",
  "declare const extensions: FabricExtensionsApi;\n",
];

export const guestTypeDeclarations = (fullCodeMode: boolean): string =>
  fullCodeMode
    ? GUEST_TYPE_DECLARATIONS
    : FULL_CODE_GLOBAL_DECLARATIONS.reduce(
        (declarations, declaration) => declarations.replace(declaration, ""),
        GUEST_TYPE_DECLARATIONS,
      );
