import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import {
  isFabricPersistentAgentHostEvent,
  type FabricPersistentAgentDelivery,
  type FabricPersistentAgentHostEvent,
  type FabricPersistentAgentRequest,
  type FabricPersistentAgentResponseMode,
} from "./persistent/types.js";
import { normalizeFabricAgentRole, type FabricAgentRole } from "./role.js";
import type { AgentRunRequest, FabricAgentLifecycle } from "./types.js";
import {
  appendAgentTurnBudgetPrompt,
  resolveAgentTurnBudget,
  type AgentTurnBudget,
} from "./turn-budget.js";

export type AgentRoleSource = "builtin" | "user" | "project";

export interface AgentRoleProfile {
  name: FabricAgentRole;
  description: string;
  lifecycle: FabricAgentLifecycle;
  goal: string;
  completion: string;
  behavior: string;
  turnBudget: AgentTurnBudget;
  tools?: string[];
  model?: string;
  thinking?: FabricThinking;
  timeoutMs?: number;
  extensions?: boolean;
  events?: FabricPersistentAgentHostEvent[];
  topics?: string[];
  delivery?: FabricPersistentAgentDelivery;
  responseMode?: FabricPersistentAgentResponseMode;
  triggerTurn?: boolean;
  coalesce?: boolean;
  freshness?: "latest" | "latest-main-revision";
  source: AgentRoleSource;
  filePath: string;
}

const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "lifecycle",
  "goal",
  "completion",
  "maxTurns",
  "graceTurns",
  "tools",
  "model",
  "thinking",
  "timeoutMs",
  "extensions",
  "events",
  "topics",
  "delivery",
  "responseMode",
  "triggerTurn",
  "coalesce",
  "freshness",
]);

const requiredText = (
  value: unknown,
  field: string,
  filePath: string,
): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${filePath}: ${field} is required`);
  }
  return value.trim();
};

const stringList = (value: unknown, field: string, filePath: string): string[] | undefined => {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!entries || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${filePath}: ${field} must be a string list`);
  }
  return [...new Set(entries.map((entry) => String(entry).trim()).filter(Boolean))];
};

export const parseAgentRoleProfile = (
  content: string,
  filePath: string,
  source: AgentRoleSource,
): AgentRoleProfile => {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new Error(`${filePath}: missing frontmatter delimiters`);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(
      `${filePath}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: frontmatter must be an object`);
  }
  const raw = parsed as Record<string, unknown>;
  const unsupported = Object.keys(raw).find((key) => !ALLOWED_FIELDS.has(key));
  if (unsupported) throw new Error(`${filePath}: unsupported field ${unsupported}`);
  const name = normalizeFabricAgentRole(requiredText(raw.name, "name", filePath));
  const description = requiredText(raw.description, "description", filePath);
  const lifecycle = raw.lifecycle;
  if (lifecycle !== "one-shot" && lifecycle !== "persistent") {
    throw new Error(`${filePath}: lifecycle must be one-shot or persistent`);
  }
  if (lifecycle === "one-shot") {
    const persistentField = ["events", "topics", "delivery", "responseMode", "triggerTurn", "coalesce", "freshness"]
      .find((field) => raw[field] !== undefined);
    if (persistentField) {
      throw new Error(`${filePath}: ${persistentField} is available only to persistent roles`);
    }
  }
  const goal = requiredText(raw.goal, "goal", filePath);
  const completion = requiredText(raw.completion, "completion", filePath);
  const behavior = requiredText(match[2], "behavior", filePath);
  const turnBudget = resolveAgentTurnBudget(
    { maxTurns: raw.maxTurns, graceTurns: raw.graceTurns },
    `${filePath} turn budget`,
  );
  const thinking = raw.thinking === undefined
    ? undefined
    : isFabricThinking(raw.thinking)
      ? raw.thinking
      : (() => { throw new Error(`${filePath}: invalid thinking level`); })();
  if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model.trim())) {
    throw new Error(`${filePath}: model must be a non-empty string`);
  }
  const timeoutMs = raw.timeoutMs === undefined
    ? undefined
    : typeof raw.timeoutMs === "number" && Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0
      ? raw.timeoutMs
      : (() => { throw new Error(`${filePath}: timeoutMs must be a positive integer`); })();
  if (raw.extensions !== undefined && typeof raw.extensions !== "boolean") {
    throw new Error(`${filePath}: extensions must be true or false`);
  }
  if (raw.triggerTurn !== undefined && typeof raw.triggerTurn !== "boolean") {
    throw new Error(`${filePath}: triggerTurn must be true or false`);
  }
  if (raw.coalesce !== undefined && typeof raw.coalesce !== "boolean") {
    throw new Error(`${filePath}: coalesce must be true or false`);
  }
  const delivery = raw.delivery === undefined
    ? undefined
    : raw.delivery === "mailbox" || raw.delivery === "steer" ||
        raw.delivery === "followUp" || raw.delivery === "nextTurn"
      ? raw.delivery
      : (() => { throw new Error(`${filePath}: invalid delivery`); })();
  const responseMode = raw.responseMode === undefined
    ? undefined
    : raw.responseMode === "text" || raw.responseMode === "directive"
      ? raw.responseMode
      : (() => { throw new Error(`${filePath}: responseMode must be text or directive`); })();
  if ((delivery === "steer" || delivery === "followUp") && typeof raw.triggerTurn !== "boolean") {
    throw new Error(`${filePath}: active delivery requires explicit triggerTurn`);
  }
  if (raw.triggerTurn !== undefined && delivery !== "steer" && delivery !== "followUp") {
    throw new Error(`${filePath}: triggerTurn is valid only with steer or followUp delivery`);
  }
  const freshness = raw.freshness === undefined
    ? undefined
    : raw.freshness === "latest" || raw.freshness === "latest-main-revision"
      ? raw.freshness
      : (() => { throw new Error(`${filePath}: invalid freshness policy`); })();
  const rawEvents = stringList(raw.events, "events", filePath);
  const events = rawEvents?.map((event) => {
    if (!isFabricPersistentAgentHostEvent(event)) {
      throw new Error(`${filePath}: unsupported host event ${event}`);
    }
    return event;
  });
  const topics = stringList(raw.topics, "topics", filePath);
  const invalidTopic = topics?.find((topic) => !TOPIC_PATTERN.test(topic));
  if (invalidTopic) throw new Error(`${filePath}: invalid topic ${invalidTopic}`);
  const tools = stringList(raw.tools, "tools", filePath);
  return {
    name,
    description,
    lifecycle,
    goal,
    completion,
    behavior,
    turnBudget,
    ...(tools ? { tools } : {}),
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(thinking ? { thinking } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(typeof raw.extensions === "boolean" ? { extensions: raw.extensions } : {}),
    ...(events ? { events } : {}),
    ...(topics ? { topics } : {}),
    ...(delivery ? { delivery } : {}),
    ...(responseMode ? { responseMode } : {}),
    ...(typeof raw.triggerTurn === "boolean" ? { triggerTurn: raw.triggerTurn } : {}),
    ...(typeof raw.coalesce === "boolean" ? { coalesce: raw.coalesce } : {}),
    ...(freshness ? { freshness } : {}),
    source,
    filePath,
  };
};

const collectMarkdown = (directory: string | null): string[] => {
  if (!directory || !fs.existsSync(directory)) return [];
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (current: string): void => {
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
    }
  };
  visit(directory);
  return files.sort();
};

export const renderAgentRolePrompt = (
  profile: AgentRoleProfile,
  task: string,
  supplemental?: string,
): string => appendAgentTurnBudgetPrompt([
  `# Agent role: ${profile.name}`,
  `## Role goal\n${profile.goal}`,
  `## Concrete task\n${task.trim()}`,
  `## Completion contract\n${profile.completion}`,
  `## Role behavior\n${profile.behavior}`,
  supplemental?.trim() ? `## Additional instructions\n${supplemental.trim()}` : "",
  "## Stop condition\nOnce the completion contract is satisfied, return the result and stop. Do not start new work after completion, self-schedule, poll, or wait for more work.",
].filter(Boolean).join("\n\n"), profile.turnBudget);

const roleFreshnessPredicate = (
  freshness: NonNullable<AgentRoleProfile["freshness"]>,
): { version: 1; source: string } => ({
  version: 1,
  source: freshness === "latest"
    ? "({ activation, current }) => activation.sequence === current.latestActivationSequence"
    : "({ activation, current }) => activation.sequence === current.latestActivationSequence && (activation.kind !== 'hostEvent' || activation.mainRevision === current.mainRevision)",
});

const resolveRoleTools = (
  role: FabricAgentRole,
  requested: string[] | undefined,
  profileTools: string[] | undefined,
): string[] | undefined => {
  if (!requested) return profileTools ? [...profileTools] : undefined;
  if (!profileTools) return [...requested];
  const denied = requested.filter((tool) => !profileTools.includes(tool));
  if (denied.length > 0) {
    throw new Error(`Agent role ${role} does not allow tools: ${denied.join(", ")}`);
  }
  return [...requested];
};

const boundedBudget = (
  requested: AgentTurnBudget | undefined,
  ceiling: AgentTurnBudget,
): AgentTurnBudget => requested
  ? {
      maxTurns: Math.min(requested.maxTurns, ceiling.maxTurns),
      graceTurns: Math.min(requested.graceTurns, ceiling.graceTurns),
    }
  : { ...ceiling };

export class AgentRoleRegistry {
  readonly #profiles = new Map<string, AgentRoleProfile>();
  readonly #ambiguous = new Set<string>();
  readonly #roleModels: Record<string, string>;
  readonly diagnostics: string[] = [];

  constructor(options: {
    projectRoot: string;
    builtinDir?: string | null;
    userDir?: string | null;
    projectDir?: string | null;
    roleModels?: Record<string, string>;
  }) {
    this.#roleModels = options.roleModels ?? {};
    const builtinDir = options.builtinDir === undefined
      ? fileURLToPath(new URL("../../agents/", import.meta.url))
      : options.builtinDir;
    const userDir = options.userDir === undefined
      ? path.join(getAgentDir(), "agents")
      : options.userDir;
    const projectDir = options.projectDir === undefined
      ? path.join(options.projectRoot, ".pi", "agents")
      : options.projectDir;
    for (const [directory, source] of [
      [builtinDir, "builtin"],
      [userDir, "user"],
      [projectDir, "project"],
    ] as const) {
      const seen = new Set<string>();
      for (const filePath of collectMarkdown(directory)) {
        try {
          const profile = parseAgentRoleProfile(fs.readFileSync(filePath, "utf8"), filePath, source);
          if (seen.has(profile.name)) {
            this.#ambiguous.add(profile.name);
            this.diagnostics.push(`Duplicate Agent role ${profile.name} in ${source} scope: ${filePath}`);
            continue;
          }
          seen.add(profile.name);
          this.#profiles.set(profile.name, profile);
        } catch (error) {
          this.diagnostics.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  static createDefault(
    projectRoot: string,
    projectTrusted = true,
    roleModels?: Record<string, string>,
  ): AgentRoleRegistry {
    return new AgentRoleRegistry({
      projectRoot,
      ...(projectTrusted ? {} : { projectDir: null }),
      ...(roleModels ? { roleModels } : {}),
    });
  }

  list(): AgentRoleProfile[] {
    return [...this.#profiles.values()].map((profile) => structuredClone(profile));
  }

  require(name: string, lifecycle: FabricAgentLifecycle): AgentRoleProfile {
    const normalized = normalizeFabricAgentRole(name);
    if (this.#ambiguous.has(normalized)) {
      throw new Error(`Ambiguous Agent role profile: ${normalized}`);
    }
    const profile = this.#profiles.get(normalized);
    if (!profile) {
      const available = [...this.#profiles.keys()].sort().join(", ") || "none";
      throw new Error(`Unknown Agent role ${normalized}; define .pi/agents/${normalized}.md or use: ${available}`);
    }
    if (profile.lifecycle !== lifecycle) {
      throw new Error(
        `Agent role ${normalized} requires the ${profile.lifecycle} lifecycle (requested ${lifecycle})`,
      );
    }
    return structuredClone(profile);
  }

  // Precedence: an explicit request model wins, then the host-configured
  // per-role override, then the profile model from markdown. Returning
  // undefined lets the downstream default apply when none of the three set it.
  #resolveModel(role: FabricAgentRole, requestModel: string | undefined, profileModel: string | undefined): string | undefined {
    return requestModel ?? this.#roleModels[role] ?? profileModel;
  }

  #applyRun(
    request: AgentRunRequest,
    lifecycle: FabricAgentLifecycle,
    fallbackRole: FabricAgentRole,
  ): AgentRunRequest {
    const role = normalizeFabricAgentRole(request.role, fallbackRole);
    const profile = this.require(role, lifecycle);
    const requestedBudget = request.turnBudget
      ? resolveAgentTurnBudget(request.turnBudget, "Agent request turnBudget")
      : undefined;
    const tools = resolveRoleTools(role, request.tools, profile.tools);
    return {
      ...request,
      role,
      goal: request.goal?.trim() || profile.goal,
      completion: request.completion?.trim() || profile.completion,
      turnBudget: boundedBudget(requestedBudget, profile.turnBudget),
      systemPrompt: renderAgentRolePrompt(profile, request.task, request.systemPrompt),
      ...(tools ? { tools: [...tools] } : {}),
      ...(() => {
        const model = this.#resolveModel(role, request.model, profile.model);
        return model ? { model } : {};
      })(),
      ...(request.thinking ? {} : profile.thinking ? { thinking: profile.thinking } : {}),
      ...(request.timeoutMs ? {} : profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
      ...(request.extensions !== undefined
        ? profile.extensions === false ? { extensions: false } : {}
        : profile.extensions !== undefined ? { extensions: profile.extensions } : {}),
    };
  }

  validateTools(
    role: FabricAgentRole,
    lifecycle: FabricAgentLifecycle,
    tools: string[],
  ): string[] {
    const profile = this.require(role, lifecycle);
    return resolveRoleTools(profile.name, tools, profile.tools) ?? [];
  }

  applyOneShot(request: AgentRunRequest): AgentRunRequest {
    return this.#applyRun(request, "one-shot", "worker");
  }

  applyPersistentActivation(request: AgentRunRequest): AgentRunRequest {
    return this.#applyRun(request, "persistent", "advisor");
  }

  applyPersistent(request: FabricPersistentAgentRequest): FabricPersistentAgentRequest {
    const role = normalizeFabricAgentRole(request.role, "advisor");
    const profile = this.require(role, "persistent");
    const requestedBudget = request.turnBudget
      ? resolveAgentTurnBudget(request.turnBudget, "Persistent Agent turnBudget")
      : undefined;
    const tools = resolveRoleTools(role, request.tools, profile.tools);
    return {
      ...request,
      role,
      goal: request.goal?.trim() || profile.goal,
      completion: request.completion?.trim() || profile.completion,
      turnBudget: boundedBudget(requestedBudget, profile.turnBudget),
      ...(request.events ? {} : profile.events ? { events: [...profile.events] } : {}),
      ...(request.topics ? {} : profile.topics ? { topics: [...profile.topics] } : {}),
      ...(request.delivery ? {} : profile.delivery ? { delivery: profile.delivery } : {}),
      ...(request.responseMode ? {} : profile.responseMode ? { responseMode: profile.responseMode } : {}),
      ...(request.triggerTurn !== undefined
        ? {}
        : profile.triggerTurn !== undefined ? { triggerTurn: profile.triggerTurn } : {}),
      ...(request.coalesce !== undefined
        ? {}
        : profile.coalesce !== undefined ? { coalesce: profile.coalesce } : {}),
      ...(request.validWhile
        ? {}
        : profile.freshness ? { validWhile: roleFreshnessPredicate(profile.freshness) } : {}),
      ...(tools ? { tools: [...tools] } : {}),
      ...(() => {
        const model = this.#resolveModel(role, request.model, profile.model);
        return model ? { model } : {};
      })(),
      ...(request.thinking ? {} : profile.thinking ? { thinking: profile.thinking } : {}),
      ...(request.timeoutMs ? {} : profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
      ...(request.extensions !== undefined
        ? profile.extensions === false ? { extensions: false } : {}
        : profile.extensions !== undefined ? { extensions: profile.extensions } : {}),
    };
  }
}
