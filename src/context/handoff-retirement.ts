import { PREWALK_CONTINUE_MESSAGE_TYPE } from "../prewalk/continuation.js";
import { MARKER_KIND } from "./qos.js";

export interface HandoffRetirementReport {
  retiredResults: number;
  retiredChars: number;
  protectedResults: number;
}

interface MessageShape {
  role: string;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
  customType?: unknown;
}

const RETIRABLE = new Set(["read", "grep", "find", "ls"]);

const shortName = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  return normalized.slice(normalized.lastIndexOf(".") + 1);
};

const textBody = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const values: string[] = [];
  for (const value of content) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const part = value as { type?: unknown; text?: unknown };
    if (part.type !== "text" || typeof part.text !== "string") return undefined;
    values.push(part.text);
  }
  return values.join("\n");
};

const evidenceBearing = (details: unknown): boolean => {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return false;
  const value = details as Record<string, unknown>;
  return (
    value.kind === MARKER_KIND ||
    Array.isArray(value.gates) ||
    Array.isArray(value.evidence) ||
    (typeof value.trace === "object" && value.trace !== null)
  );
};

// The handoff boundary is the identity-owned continuation message. Everything
// before it is Main's planning phase; everything at or after it belongs to the
// executor. Absent a matching continuation the pass is a no-op, so a stale or
// foreign continuation can never anchor retirement.
const continuationBoundary = (
  messages: readonly MessageShape[],
  continuationId: string,
): number => {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "custom") continue;
    const custom = message as MessageShape & { details?: unknown };
    if (custom.customType !== PREWALK_CONTINUE_MESSAGE_TYPE) continue;
    const details = custom.details;
    if (
      typeof details === "object" &&
      details !== null &&
      !Array.isArray(details) &&
      (details as { continuationId?: unknown }).continuationId === continuationId
    ) {
      return index;
    }
  }
  return -1;
};

// Retire Main's planning-phase read/grep/find/ls results once the executor
// continuation is live. The accepted checklist already carries the plan, so the
// executor re-reads only what it actually touches instead of replaying every
// exploration result as input on each turn. Errors and evidence-bearing results
// survive; markers reuse the QoS marker kind so later passes protect them and
// the pass is idempotent.
export const applyHandoffRetirement = <Message extends MessageShape>(
  messages: Message[],
  options: { continuationId: string; enabled: boolean },
): { messages: Message[]; changed: boolean; report: HandoffRetirementReport } => {
  if (!options.enabled) {
    return {
      messages,
      changed: false,
      report: { retiredResults: 0, retiredChars: 0, protectedResults: 0 },
    };
  }
  const boundary = continuationBoundary(messages, options.continuationId);
  if (boundary < 0) {
    return {
      messages,
      changed: false,
      report: { retiredResults: 0, retiredChars: 0, protectedResults: 0 },
    };
  }
  const output = [...messages];
  let retiredResults = 0;
  let retiredChars = 0;
  let protectedResults = 0;
  for (let index = 0; index < boundary; index++) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const name = shortName(message.toolName);
    const body = textBody(message.content);
    if (!name || !RETIRABLE.has(name) || body === undefined) continue;
    if (message.isError === true || evidenceBearing(message.details)) {
      protectedResults++;
      continue;
    }
    output[index] = {
      ...message,
      content: [
        {
          type: "text",
          text: `[context-qos retired pre-handoff ${name} result; checklist carries the plan]`,
        },
      ],
      details: {
        kind: MARKER_KIND,
        version: 1,
        reason: "pre_handoff_retirement",
        originalChars: body.length,
      },
    };
    retiredResults++;
    retiredChars += body.length;
  }
  return {
    messages: output,
    changed: retiredResults > 0,
    report: { retiredResults, retiredChars, protectedResults },
  };
};
