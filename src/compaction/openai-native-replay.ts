import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isOpenAINativeResponseItem,
  openAINativeModelKey,
  openAIResponseItemsFor,
  supportsOpenAINativeCompaction,
  type OpenAINativeCompactionDetails,
  type OpenAINativeResponseItem,
} from "./openai-native.js";

const MAX_REPLACEMENT_HISTORY_ITEMS = 256;
const MAX_REPLACEMENT_HISTORY_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type ActiveModel = NonNullable<ExtensionContext["model"]>;

interface ReplayState {
  modelKey: string;
  explicitHistory: OpenAINativeResponseItem[];
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseDetails = (value: unknown): OpenAINativeCompactionDetails | undefined => {
  if (!isRecord(value) || !isRecord(value.remoteCompaction)) return undefined;
  const remote = value.remoteCompaction;
  if (
    remote.version !== 1
    || remote.provider !== "openai-responses-compaction"
    || typeof remote.modelKey !== "string"
    || remote.modelKey.length === 0
    || remote.modelKey.length > 512
    || !Array.isArray(remote.replacementHistory)
    || remote.replacementHistory.length === 0
    || remote.replacementHistory.length > MAX_REPLACEMENT_HISTORY_ITEMS
    || !remote.replacementHistory.every(isOpenAINativeResponseItem)
  ) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(remote.replacementHistory), "utf8") > MAX_REPLACEMENT_HISTORY_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    version: 1,
    provider: "openai-responses-compaction",
    modelKey: remote.modelKey,
    replacementHistory: structuredClone(remote.replacementHistory),
  };
};

const messageItems = (
  message: Parameters<typeof openAIResponseItemsFor>[0][number],
  model: ActiveModel,
): OpenAINativeResponseItem[] => {
  try {
    return openAIResponseItemsFor([message], model);
  } catch {
    return [];
  }
};

const assistantMatches = (message: JsonRecord, modelKey: string): boolean => {
  const [provider, api, id] = modelKey.split(":", 3);
  return provider !== undefined
    && api !== undefined
    && id !== undefined
    && message.provider === provider
    && message.api === api
    && message.model === id;
};

const restoreState = (
  entries: readonly SessionEntry[],
  model: ActiveModel,
): ReplayState | undefined => {
  let compactionIndex = -1;
  let details: OpenAINativeCompactionDetails | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "compaction") continue;
    compactionIndex = index;
    details = parseDetails(entry.details);
    break;
  }
  if (compactionIndex < 0 || !details || details.modelKey !== openAINativeModelKey(model)) return undefined;
  const explicitHistory = [...details.replacementHistory];
  for (const entry of entries.slice(compactionIndex + 1)) {
    let messages: ReturnType<typeof sessionEntryToContextMessages>;
    try {
      messages = sessionEntryToContextMessages(entry);
    } catch {
      continue;
    }
    for (const message of messages) {
      const candidate = message as unknown;
      if (isRecord(candidate) && candidate.role === "assistant" && !assistantMatches(candidate, details.modelKey)) {
        return undefined;
      }
      explicitHistory.push(...messageItems(message, model));
    }
  }
  return { modelKey: details.modelKey, explicitHistory };
};

export interface OpenAINativeReplayController {
  historyFor: (context: ExtensionContext) => OpenAINativeResponseItem[] | undefined;
}

export const registerOpenAINativeReplay = (
  pi: ExtensionAPI,
  options: { isEnabled: () => boolean },
): OpenAINativeReplayController => {
  const sessions = new Map<string, ReplayState>();
  const sessionId = (context: ExtensionContext): string => context.sessionManager.getSessionId();
  const clear = (context: ExtensionContext): void => {
    sessions.delete(sessionId(context));
  };
  const sync = (context: ExtensionContext): void => {
    if (!options.isEnabled() || !supportsOpenAINativeCompaction(context.model)) {
      clear(context);
      return;
    }
    const restored = restoreState(context.sessionManager.getBranch(), context.model);
    if (restored) sessions.set(sessionId(context), restored);
    else clear(context);
  };

  pi.on("session_start", (_event, context) => sync(context));
  pi.on("session_compact", (_event, context) => sync(context));
  pi.on("session_tree", (_event, context) => sync(context));
  pi.on("model_select", (_event, context) => sync(context));
  pi.on("session_before_switch", (_event, context) => clear(context));
  pi.on("session_before_fork", (_event, context) => clear(context));
  pi.on("session_before_tree", (_event, context) => clear(context));
  pi.on("session_shutdown", () => sessions.clear());

  pi.on("message_end", (event, context) => {
    if (!options.isEnabled() || !supportsOpenAINativeCompaction(context.model)) return;
    const id = sessionId(context);
    const current = sessions.get(id);
    if (!current || current.modelKey !== openAINativeModelKey(context.model)) return;
    const message = event.message as unknown;
    if (!isRecord(message)) return;
    if (message.role === "assistant" && !assistantMatches(message, current.modelKey)) {
      sessions.delete(id);
      return;
    }
    const items = messageItems(event.message, context.model);
    if (items.length === 0) return;
    sessions.set(id, {
      ...current,
      explicitHistory: [...current.explicitHistory, ...items],
    });
  });

  pi.on("before_provider_request", (event, context) => {
    if (!options.isEnabled() || !supportsOpenAINativeCompaction(context.model)) return;
    if (!isRecord(event.payload)) return;
    const current = sessions.get(sessionId(context));
    if (!current || current.modelKey !== openAINativeModelKey(context.model)) return;
    const payload: JsonRecord = {
      ...event.payload,
      input: structuredClone(current.explicitHistory),
    };
    delete payload.messages;
    delete payload.previous_response_id;
    return payload;
  });

  return {
    historyFor: (context) => {
      if (!options.isEnabled() || !supportsOpenAINativeCompaction(context.model)) return undefined;
      const current = sessions.get(sessionId(context));
      if (!current || current.modelKey !== openAINativeModelKey(context.model)) return undefined;
      return structuredClone(current.explicitHistory);
    },
  };
};
