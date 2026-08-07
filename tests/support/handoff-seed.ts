// Test-support module: trajectory handoff seed building. This was previously
// exported from src/agents/handoff.ts but has no production caller (tests only),
// so the implementation moved here with its private helpers.
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../../src/agents/types.js";

interface HandoffSessionSource {
  getBranch(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

interface CurrentModel {
  provider: string;
  id: string;
}

type NativeAssistantMessage = Extract<
  SessionMessageEntry["message"],
  { role: "assistant" }
>;
type NativeAssistantEntry = SessionMessageEntry & {
  message: NativeAssistantMessage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolCall = (value: unknown): value is {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments);

const activeFabricTurn = (
  source: HandoffSessionSource,
  outerToolCallId: string,
): NativeAssistantEntry => {
  const leafId = source.getLeafId();
  const entry = leafId ? source.getEntry(leafId) : undefined;
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(
      "Trajectory handoff requires the active fabric_exec assistant turn to be the session leaf",
    );
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const toolCalls = content.filter(isToolCall);
  if (!toolCalls.some((call) => call.id === outerToolCallId)) {
    throw new Error(
      "Trajectory handoff could not find the active fabric_exec assistant turn in the Pi session",
    );
  }
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== "fabric_exec") {
    throw new Error(
      "Trajectory handoff requires fabric_exec to be the only top-level tool call in its assistant turn",
    );
  }
  return entry as NativeAssistantEntry;
};

export const snapshotHandoffSession = (
  source: HandoffSessionSource,
  currentModel: CurrentModel | undefined,
  outerToolResult: AgentToolResultMessage,
  outerToolCallId: string,
): AgentSessionSeed => {
  if (
    outerToolResult.toolCallId !== outerToolCallId ||
    outerToolResult.toolName !== "fabric_exec"
  ) {
    throw new Error("Trajectory handoff requires the finalized outer fabric_exec result");
  }
  const active = activeFabricTurn(source, outerToolCallId);
  const sourceSessionFile = source.getSessionFile();
  const branch = source.getBranch();
  let model = currentModel
    ? { provider: currentModel.provider, modelId: currentModel.id }
    : undefined;
  let thinkingLevel: string | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!thinkingLevel && entry?.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
    if (!model && entry?.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    }
    if (model && thinkingLevel) break;
  }
  return {
    sourceSessionId: source.getSessionId(),
    ...(sourceSessionFile ? { sourceSessionFile } : {}),
    sourceBranchLeafId: active.id,
    ...(!sourceSessionFile ? { sourceBranch: structuredClone(branch) } : {}),
    ...(model ? { sourceModel: model } : {}),
    ...(thinkingLevel ? { sourceThinkingLevel: thinkingLevel } : {}),
    outerToolResult: structuredClone(outerToolResult),
  };
};
