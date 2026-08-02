import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_INSTALLATION_ID = randomUUID();
const RETAINED_USER_HISTORY_BYTES = 80_000;
const MAX_REMOTE_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REPLACEMENT_HISTORY_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type ActiveModel = NonNullable<ExtensionContext["model"]>;

export interface OpenAINativeResponseItem extends JsonRecord {
  type?: string;
  role?: string;
}

export interface OpenAINativeCompactionDetails {
  version: 1;
  provider: "openai-responses-compaction";
  modelKey: string;
  replacementHistory: OpenAINativeResponseItem[];
  usage?: Usage;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isOpenAINativeResponseItem = (value: unknown): value is OpenAINativeResponseItem =>
  isRecord(value)
  && ((typeof value.type === "string" && value.type.length > 0)
    || (typeof value.role === "string" && value.role.length > 0));

const hostname = (baseUrl: unknown): string | undefined => {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const hasNoBaseUrl = (baseUrl: unknown): boolean =>
  typeof baseUrl !== "string" || baseUrl.trim().length === 0;

const isDirectOpenAIResponsesModel = (model: ActiveModel): boolean =>
  model.api === "openai-responses"
  && model.provider === "openai"
  && (hasNoBaseUrl(model.baseUrl) || hostname(model.baseUrl) === "api.openai.com");

const isOpenAICodexResponsesModel = (model: ActiveModel): boolean =>
  model.api === "openai-codex-responses"
  && (
    (hasNoBaseUrl(model.baseUrl) && model.provider === "openai-codex")
    || hostname(model.baseUrl) === "chatgpt.com"
  );

export const supportsOpenAINativeCompaction = (model: ActiveModel | undefined): model is ActiveModel =>
  model !== undefined
  && (isDirectOpenAIResponsesModel(model) || isOpenAICodexResponsesModel(model));

export const openAINativeModelKey = (model: ActiveModel): string =>
  `${model.provider}:${model.api}:${model.id}`;

const normalizeBaseUrl = (baseUrl: string | undefined, fallback: string): string =>
  (baseUrl?.trim() || fallback).replace(/\/+$/, "");

const endpointUrl = (model: ActiveModel): string => {
  const baseUrl = normalizeBaseUrl(
    model.baseUrl,
    isOpenAICodexResponsesModel(model)
      ? "https://chatgpt.com/backend-api"
      : "https://api.openai.com/v1",
  );
  if (isOpenAICodexResponsesModel(model)) {
    if (baseUrl.endsWith("/codex/responses")) return baseUrl;
    if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
    return `${baseUrl}/codex/responses`;
  }
  if (baseUrl.endsWith("/responses")) return baseUrl;
  return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
};

const codexAccountId = (token: string): string => {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Codex token has no account identity");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
  const auth = isRecord(payload) && isRecord(payload["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : undefined;
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex token has no ChatGPT account id");
  }
  return accountId;
};

const withRemoteCompactionFeature = (
  configured: Record<string, string>,
): Record<string, string> => {
  const featureName = "x-codex-beta-features";
  const existing = Object.entries(configured)
    .find(([name]) => name.toLowerCase() === featureName)?.[1]
    ?.split(",")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0) ?? [];
  const remaining = Object.fromEntries(
    Object.entries(configured).filter(([name]) => name.toLowerCase() !== featureName),
  );
  return {
    ...remaining,
    [featureName]: [...new Set([...existing, "remote_compaction_v2"])].join(","),
  };
};

const requestHeaders = (
  model: ActiveModel,
  apiKey: string,
  configured: Record<string, string> | undefined,
  sessionId: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    ...withRemoteCompactionFeature(configured ?? {}),
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-codex-installation-id": CODEX_INSTALLATION_ID,
    "x-codex-window-id": `${sessionId}:0`,
    session_id: sessionId,
  };
  if (!isOpenAICodexResponsesModel(model)) return headers;
  return {
    ...headers,
    "chatgpt-account-id": codexAccountId(apiKey),
    originator: "pi",
    "OpenAI-Beta": "responses=experimental",
  };
};

const activeTools = (pi: ExtensionAPI): JsonRecord[] => {
  if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return [];
  const enabled = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
};

const reasoningFor = (level: ExtensionContext["thinkingLevel"]): JsonRecord | undefined => {
  if (level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
    return { effort: level, summary: "auto" };
  }
  return undefined;
};

const parseSseEvents = (text: string): unknown[] =>
  text.replace(/\r\n/g, "\n").split("\n\n").flatMap((block) => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data.length === 0 || data === "[DONE]") return [];
    try {
      return [JSON.parse(data) as unknown];
    } catch {
      return [];
    }
  });

const usageFrom = (model: ActiveModel, value: unknown): Usage | undefined => {
  if (!isRecord(value)) return undefined;
  const inputTokens = typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens)
    ? Math.max(0, value.input_tokens)
    : 0;
  const outputTokens = typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens)
    ? Math.max(0, value.output_tokens)
    : 0;
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const cacheRead = typeof details?.cached_tokens === "number" && Number.isFinite(details.cached_tokens)
    ? Math.max(0, details.cached_tokens)
    : 0;
  const cacheWrite = typeof details?.cache_creation_tokens === "number" && Number.isFinite(details.cache_creation_tokens)
    ? Math.max(0, details.cache_creation_tokens)
    : 0;
  const totalTokens = typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens)
    ? Math.max(0, value.total_tokens)
    : inputTokens + outputTokens;
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  usage.cost = calculateCost(model, usage);
  return usage;
};

const compactionResultFrom = (
  events: unknown[],
  model: ActiveModel,
): { item: OpenAINativeResponseItem; usage?: Usage } => {
  let completed = false;
  let usage: Usage | undefined;
  const items: OpenAINativeResponseItem[] = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      throw new Error(typeof event.message === "string" ? event.message : "OpenAI compaction failed");
    }
    if (event.type === "response.failed") throw new Error("OpenAI compaction response failed");
    if (event.type === "response.completed") {
      completed = true;
      usage = usageFrom(model, isRecord(event.response) ? event.response.usage : undefined);
    }
    if (event.type !== "response.output_item.done" || !isRecord(event.item)) continue;
    if (event.item.type === "compaction") items.push(event.item as OpenAINativeResponseItem);
  }
  if (!completed) throw new Error("OpenAI compaction stream ended before completion");
  if (items.length !== 1) throw new Error(`OpenAI compaction returned ${items.length} compaction items`);
  return { item: items[0]!, ...(usage ? { usage } : {}) };
};

const retainedUserHistory = (
  items: readonly OpenAINativeResponseItem[],
): OpenAINativeResponseItem[] => {
  let remainingBytes = RETAINED_USER_HISTORY_BYTES;
  const retained: OpenAINativeResponseItem[] = [];
  for (const item of [...items].reverse()) {
    if (item.role !== "user") continue;
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > remainingBytes) continue;
    retained.unshift(structuredClone(item));
    remainingBytes -= bytes;
  }
  return retained;
};

type ApplicationMessage = Parameters<typeof convertToLlm>[0][number];

export const openAIResponseItemsFor = (
  messages: ApplicationMessage[],
  model: ActiveModel,
): OpenAINativeResponseItem[] => {
  const converted = convertResponsesMessages(
    model,
    { messages: convertToLlm(messages) },
    OPENAI_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false },
  ) as unknown;
  return Array.isArray(converted) ? converted.filter(isOpenAINativeResponseItem) : [];
};

const responseItemsFor = (
  event: SessionBeforeCompactEvent,
  model: ActiveModel,
): OpenAINativeResponseItem[] => {
  const applicationMessages = event.branchEntries.flatMap((entry) => {
    try {
      return sessionEntryToContextMessages(entry);
    } catch {
      return [];
    }
  });
  return openAIResponseItemsFor(applicationMessages, model);
};

export const compactWithOpenAI = async (params: {
  pi: ExtensionAPI;
  event: SessionBeforeCompactEvent;
  context: ExtensionContext;
  existingHistory?: readonly OpenAINativeResponseItem[];
}): Promise<OpenAINativeCompactionDetails | undefined> => {
  const model = params.context.model;
  if (!supportsOpenAINativeCompaction(model)) return undefined;
  const auth = await params.context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  const sessionId = params.context.sessionManager.getSessionId();
  const input = params.existingHistory
    ? structuredClone(params.existingHistory)
    : responseItemsFor(params.event, model);
  const reasoning = reasoningFor(params.context.thinkingLevel);
  const body: JsonRecord = {
    model: model.id,
    input: [...input, { type: "compaction_trigger" }],
    instructions: params.context.getSystemPrompt(),
    tools: activeTools(params.pi),
    parallel_tool_calls: true,
    tool_choice: "auto",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    ...(reasoning ? { reasoning } : {}),
  };
  const response = await fetch(endpointUrl(model), {
    method: "POST",
    headers: requestHeaders(model, auth.apiKey, auth.headers, sessionId),
    body: JSON.stringify(body),
    signal: params.event.signal,
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(`OpenAI compaction failed (${response.status}): ${responseText || response.statusText}`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REMOTE_RESPONSE_BYTES) {
    throw new Error("OpenAI compaction response exceeded 20 MiB");
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_REMOTE_RESPONSE_BYTES) {
    throw new Error("OpenAI compaction response exceeded 20 MiB");
  }
  const nativeResult = compactionResultFrom(parseSseEvents(responseText), model);
  const replacementHistory = [...retainedUserHistory(input), nativeResult.item];
  if (Buffer.byteLength(JSON.stringify(replacementHistory), "utf8") > MAX_REPLACEMENT_HISTORY_BYTES) {
    throw new Error("OpenAI replacement history exceeded 16 MiB");
  }
  return {
    version: 1,
    provider: "openai-responses-compaction",
    modelKey: openAINativeModelKey(model),
    replacementHistory,
    ...(nativeResult.usage ? { usage: nativeResult.usage } : {}),
  };
};
