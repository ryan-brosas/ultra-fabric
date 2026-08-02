import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FabricAgentTransport } from "../../config.js";
import { normalizeFabricAgentRole } from "../role.js";
import { isFabricThinking, type FabricThinking } from "../../thinking.js";
import { resolvePersistentAgentDeliveryPolicy } from "./delivery-policy.js";
import { normalizePersistentAgentBudgetPolicy } from "./budget.js";
import { FABRIC_PERSISTENT_AGENT_HOST_EVENTS } from "./types.js";
import type {
  FabricPersistentAgentDelivery,
  FabricPersistentAgentHostEvent,
  FabricPersistentAgentRequest,
  FabricPersistentAgentResponseMode,
  AgentTemplateDefinition,
} from "./types.js";

const PERSISTENT_AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,59}$/;
const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const HOST_EVENTS: ReadonlySet<FabricPersistentAgentHostEvent> = new Set(FABRIC_PERSISTENT_AGENT_HOST_EVENTS);
const RESPONSE_MODES = new Set<FabricPersistentAgentResponseMode>(["text", "directive"]);
const TRANSPORTS = new Set<FabricAgentTransport>([
  "auto",
  "process",
  "tmux",
  "screen",
  "localterm",
  "herdr",
]);

interface RegistryFile {
  format: 1;
  persistentAgents: AgentTemplateDefinition[];
}

const atomicWrite = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Resolve a partial id (unique prefix) or an exact name to a definition.
 * Returns undefined when nothing matches, and throws on an ambiguous prefix.
 */
const resolveDefinition = (
  persistentAgents: Map<string, AgentTemplateDefinition>,
  idOrName: string,
): AgentTemplateDefinition | undefined => {
  const exact = persistentAgents.get(idOrName);
  if (exact) return exact;
  const matches = [...persistentAgents.values()].filter(
    (persistentAgent) => persistentAgent.id.startsWith(idOrName) || persistentAgent.name === idOrName,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous Agent template: ${idOrName}`);
  return undefined;
};

/**
 * A project-independent library of Agent templates. Templates carry only a
 * definition, identity, and timestamps, never mailbox or run history. Importing
 * creates a fresh persistent Agent with no inherited session or logs.
 *
 * The registry lives in the user's agent dir (machine-global), independent of
 * any project or mesh, so the same templates are available across every
 * project. Operations are pure file I/O and do not require the mesh to be
 * enabled; only importing, which creates a persistent Agent, depends on the runtime.
 * The registry is read into memory once at construction; run `/fabric reload`
 * to pick up templates added by other Pi sessions. Writes are atomic (write
 * to a temp file then rename) so concurrent sessions cannot corrupt the
 * store, though truly simultaneous edits are last-write-wins.
 */
export class AgentTemplateRegistry {
  readonly #persistentAgents = new Map<string, AgentTemplateDefinition>();
  readonly #path: string;
  readonly #maxBytes: number;

  constructor(agentDir: string, maxInstructionsBytes: number) {
    this.#path = path.join(agentDir, "fabric", "persistentAgents", "global-persistentAgents.json");
    this.#maxBytes = maxInstructionsBytes;
    this.#load();
  }

  list(): AgentTemplateDefinition[] {
    return [...this.#persistentAgents.values()].map(clone);
  }

  resolve(idOrName: string): AgentTemplateDefinition | undefined {
    const found = resolveDefinition(this.#persistentAgents, idOrName);
    return found ? clone(found) : undefined;
  }

  /**
   * Save a definition to the global registry. If a template with the same name
   * already exists, throws unless `overwrite` is true (in which case the
   * existing template is updated in place, keeping its id). Returns the stored
   * definition.
   */
  create(def: FabricPersistentAgentRequest, overwrite = false): AgentTemplateDefinition {
    const validated = this.#validate(def);
    const existing = [...this.#persistentAgents.values()].find((persistentAgent) => persistentAgent.name === validated.name);
    if (existing) {
      if (!overwrite) {
        throw new Error(`An Agent template named ${validated.name} already exists (${existing.id})`);
      }
      const updated: AgentTemplateDefinition = {
        ...existing,
        ...validated,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      };
      this.#persistentAgents.set(existing.id, updated);
      this.#save();
      return clone(updated);
    }
    const created: AgentTemplateDefinition = {
      ...validated,
      id: randomUUID().replaceAll("-", ""),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#persistentAgents.set(created.id, created);
    this.#save();
    return clone(created);
  }

  /**
   * Apply a partial patch to a stored template (e.g. new instructions). Only
   * the supplied fields are replaced; the rest are preserved. Re-validates any
   * changed field.
   */
  update(idOrName: string, patch: Partial<FabricPersistentAgentRequest>): AgentTemplateDefinition {
    const existing = resolveDefinition(this.#persistentAgents, idOrName);
    if (!existing) throw new Error(`Unknown Agent template: ${idOrName}`);
    const merged: FabricPersistentAgentRequest = {
      name: patch.name ?? existing.name,
      role: patch.role ?? existing.role,
      instructions: patch.instructions ?? existing.instructions,
      events: patch.events ?? existing.events,
      topics: patch.topics ?? existing.topics,
      delivery: patch.delivery ?? existing.delivery,
      responseMode: patch.responseMode ?? existing.responseMode,
      triggerTurn: patch.triggerTurn ?? existing.triggerTurn,
      coalesce: patch.coalesce ?? existing.coalesce,
      runner: patch.runner ?? existing.runner,
      ...(patch.model !== undefined ? { model: patch.model } : existing.model ? { model: existing.model } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : existing.thinking ? { thinking: existing.thinking } : {}),
      ...(patch.tools !== undefined ? { tools: patch.tools } : existing.tools ? { tools: existing.tools } : {}),
      ...(patch.transport !== undefined ? { transport: patch.transport } : existing.transport ? { transport: existing.transport } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : existing.timeoutMs ? { timeoutMs: existing.timeoutMs } : {}),
      ...(patch.extensions !== undefined
        ? { extensions: patch.extensions }
        : typeof existing.extensions === "boolean"
          ? { extensions: existing.extensions }
          : {}),
      ...(patch.validWhile !== undefined
        ? { validWhile: patch.validWhile }
        : existing.validWhile
          ? { validWhile: existing.validWhile }
          : {}),
      ...(patch.budget !== undefined
        ? { budget: patch.budget }
        : existing.budget
          ? { budget: existing.budget }
          : {}),
    };
    const validated = this.#validate(merged);
    if (validated.name !== existing.name) {
      const clash = [...this.#persistentAgents.values()].find(
        (persistentAgent) => persistentAgent.id !== existing.id && persistentAgent.name === validated.name,
      );
      if (clash) {
        throw new Error(`An Agent template named ${validated.name} already exists (${clash.id})`);
      }
    }
    const updated: AgentTemplateDefinition = {
      ...validated,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    this.#persistentAgents.set(existing.id, updated);
    this.#save();
    return clone(updated);
  }

  remove(idOrName: string): { removed: boolean } {
    const existing = resolveDefinition(this.#persistentAgents, idOrName);
    if (!existing) return { removed: false };
    this.#persistentAgents.delete(existing.id);
    this.#save();
    return { removed: true };
  }

  /**
   * Strip identity/timestamps from a stored template to produce the request
   * shape PersistentAgentRuntime.create expects. Optionally rename the imported persistentAgent so
   * a template can be stamped into a project under a different name (e.g. to
   * avoid a collision with a live persistentAgent).
   */
  toRequest(def: AgentTemplateDefinition, as?: string): FabricPersistentAgentRequest {
    const name = as?.trim() || def.name;
    const request: FabricPersistentAgentRequest = {
      name,
      role: def.role,
      instructions: def.instructions,
      events: [...def.events],
      topics: [...def.topics],
      delivery: def.delivery,
      responseMode: def.responseMode,
      triggerTurn: def.triggerTurn,
      coalesce: def.coalesce,
      runner: def.runner,
      ...(def.model ? { model: def.model } : {}),
      ...(def.thinking ? { thinking: def.thinking } : {}),
      ...(def.tools ? { tools: [...def.tools] } : {}),
      ...(def.transport ? { transport: def.transport } : {}),
      ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
      ...(typeof def.extensions === "boolean" ? { extensions: def.extensions } : {}),
      ...(def.validWhile ? { validWhile: clone(def.validWhile) } : {}),
      ...(def.budget ? { budget: clone(def.budget) } : {}),
    };
    return request;
  }

  #validate(def: FabricPersistentAgentRequest): Omit<AgentTemplateDefinition, "id" | "createdAt" | "updatedAt"> {
    const name = def.name.trim();
    if (!PERSISTENT_AGENT_NAME_PATTERN.test(name)) throw new Error(`Invalid Agent template name: ${def.name}`);
    const role = normalizeFabricAgentRole(def.role);
    const instructions = def.instructions;
    if (!instructions.trim()) throw new Error("Agent template instructions must not be empty");
    if (Buffer.byteLength(instructions, "utf8") > this.#maxBytes) {
      throw new Error(`Agent template instructions exceed ${this.#maxBytes} bytes`);
    }
    const events = [...new Set(def.events ?? [])];
    for (const event of events) {
      if (!HOST_EVENTS.has(event)) throw new Error(`Unsupported Agent template event: ${event}`);
    }
    const topics = [...new Set(def.topics ?? [])];
    for (const topic of topics) {
      if (!TOPIC_PATTERN.test(topic)) throw new Error(`Invalid Agent template topic: ${topic}`);
    }
    const deliveryPolicy = resolvePersistentAgentDeliveryPolicy(def.delivery, def.triggerTurn);
    const responseMode = def.responseMode ?? "text";
    if (!RESPONSE_MODES.has(responseMode)) {
      throw new Error(`Invalid Agent template response mode: ${def.responseMode}`);
    }
    const coalesce = def.coalesce ?? true;
    const runner = def.runner ?? "pi";
    if (runner !== "pi" && runner !== "claude") {
      throw new Error(`Invalid Agent template runner: ${String(def.runner)}`);
    }
    const model = typeof def.model === "string" && def.model.trim() ? def.model.trim() : undefined;
    const thinking =
      def.thinking !== undefined && isFabricThinking(def.thinking) ? def.thinking : undefined;
    const tools = Array.isArray(def.tools)
      ? [...new Set(def.tools.filter((tool): tool is string => typeof tool === "string"))]
      : undefined;
    const transport =
      def.transport !== undefined && TRANSPORTS.has(def.transport) ? def.transport : undefined;
    const timeoutMs = typeof def.timeoutMs === "number" ? def.timeoutMs : undefined;
    const extensions = typeof def.extensions === "boolean" ? def.extensions : undefined;
    const validWhile = def.validWhile?.version === 1 &&
      typeof def.validWhile.source === "string" &&
      def.validWhile.source.trim() &&
      def.validWhile.source.length <= 16_000
      ? clone(def.validWhile)
      : undefined;
    if (def.validWhile && !validWhile) throw new Error("Invalid Agent template validWhile predicate");
    const budget = normalizePersistentAgentBudgetPolicy(def.budget);
    const budgetConfigured = budget.lifetimeActivations > 0 || budget.windowActivations > 0;
    return {
      name,
      role,
      instructions,
      events,
      topics,
      delivery: deliveryPolicy.delivery,
      responseMode,
      triggerTurn: deliveryPolicy.triggerTurn,
      coalesce,
      runner,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(tools ? { tools } : {}),
      ...(transport ? { transport } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
      ...(validWhile ? { validWhile } : {}),
      ...(budgetConfigured ? { budget } : {}),
    };
  }

  #load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const records = (parsed as { persistentAgents?: unknown }).persistentAgents;
    if (!Array.isArray(records)) return;
    for (const value of records) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Partial<AgentTemplateDefinition>;
      if (
        typeof record.id !== "string" ||
        !/^[a-f0-9]{32}$/.test(record.id) ||
        typeof record.name !== "string" ||
        !PERSISTENT_AGENT_NAME_PATTERN.test(record.name) ||
        typeof record.instructions !== "string" ||
        Buffer.byteLength(record.instructions, "utf8") > this.#maxBytes ||
        typeof record.createdAt !== "number"
      ) {
        continue;
      }
      const events = Array.isArray(record.events)
        ? record.events.filter((event): event is FabricPersistentAgentHostEvent => HOST_EVENTS.has(event))
        : [];
      const topics = Array.isArray(record.topics)
        ? record.topics.filter(
            (topic): topic is string => typeof topic === "string" && TOPIC_PATTERN.test(topic),
          )
        : [];
      const delivery: FabricPersistentAgentDelivery =
        record.delivery === "steer" || record.delivery === "followUp" || record.delivery === "nextTurn"
          ? record.delivery
          : "mailbox";
      const responseMode: FabricPersistentAgentResponseMode =
        record.responseMode === "directive" ? "directive" : "text";
      const triggerTurn =
        (delivery === "steer" || delivery === "followUp") && record.triggerTurn === true;
      const coalesce = record.coalesce !== false;
      const runner = record.runner === "claude" ? "claude" : "pi";
      const thinking: FabricThinking | undefined = isFabricThinking(record.thinking)
        ? record.thinking
        : undefined;
      const tools = Array.isArray(record.tools)
        ? record.tools.filter((tool): tool is string => typeof tool === "string")
        : undefined;
      const transport: FabricAgentTransport | undefined =
        record.transport !== undefined && TRANSPORTS.has(record.transport) ? record.transport : undefined;
      const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
      const extensions = typeof record.extensions === "boolean" ? record.extensions : undefined;
      const validWhile = record.validWhile?.version === 1 &&
        typeof record.validWhile.source === "string" &&
        record.validWhile.source.length <= 16_000
        ? clone(record.validWhile)
        : undefined;
      const budget = normalizePersistentAgentBudgetPolicy(record.budget);
      const budgetConfigured = budget.lifetimeActivations > 0 || budget.windowActivations > 0;
      const def: AgentTemplateDefinition = {
        id: record.id,
        name: record.name,
        role: normalizeFabricAgentRole(record.role),
        instructions: record.instructions,
        events,
        topics,
        delivery,
        responseMode,
        triggerTurn,
        coalesce,
        runner,
        createdAt: record.createdAt,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : record.createdAt,
        ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(tools ? { tools } : {}),
        ...(transport ? { transport } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(extensions !== undefined ? { extensions } : {}),
        ...(validWhile ? { validWhile } : {}),
        ...(budgetConfigured ? { budget } : {}),
      };
      this.#persistentAgents.set(def.id, def);
    }
  }

  #save(): void {
    const file: RegistryFile = { format: 1, persistentAgents: [...this.#persistentAgents.values()] };
    atomicWrite(this.#path, file);
  }
}
