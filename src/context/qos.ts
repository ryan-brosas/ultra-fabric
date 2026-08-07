export interface ContextQosReport {
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
}

const RETIRABLE = new Set(["read", "grep", "find", "ls"]);
// Oversized retirement covers the measured context drivers (delegated
// fabric_exec output, graph exploration) plus the retirable readers. Mutation
// results, errors, non-text content, and evidence-bearing results stay exact.
const OVERSIZED_RETIRABLE = new Set([
  "read", "grep", "find", "ls", "fabric_exec", "codemap",
]);
export const MARKER_KIND = "pi-fabric.context-qos";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
  );
};

const shortName = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  return normalized.slice(normalized.lastIndexOf(".") + 1);
};

const identities = (messages: readonly MessageShape[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const part = value as Record<string, unknown>;
      const name = shortName(part.name);
      if (part.type === "toolCall" && typeof part.id === "string" && name) {
        result.set(part.id, `${name}:${JSON.stringify(canonical(part.arguments ?? {}))}`);
      }
    }
  }
  return result;
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

const protectedBoundary = (messages: readonly MessageShape[], turnWindow: number): number => {
  let remaining = Math.max(1, Math.floor(turnWindow));
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") continue;
    remaining--;
    if (remaining === 0) return index;
  }
  return 0;
};

const resultIdentity = (
  message: MessageShape,
  calls: ReadonlyMap<string, string>,
): { id: string; identity: string; name: string } | undefined => {
  if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return undefined;
  const identity = calls.get(message.toolCallId);
  const name = shortName(message.toolName);
  return identity && name ? { id: message.toolCallId, identity, name } : undefined;
};

export const applyContextQos = <Message extends MessageShape>(
  messages: Message[],
  options: { turnWindow: number; minResultChars: number; maxResultChars?: number },
): { messages: Message[]; changed: boolean; report: ContextQosReport } => {
  const calls = identities(messages);
  const boundary = protectedBoundary(messages, options.turnWindow);
  const minimum = Math.max(1, Math.floor(options.minResultChars));
  const latest = new Map<string, { index: number; id: string }>();
  const candidates = new Map<number, { id: string; identity: string; name: string; body: string }>();
  let protectedResults = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const result = resultIdentity(message, calls);
    const body = textBody(message.content);
    if (!result || body === undefined || body.length < minimum) continue;
    const protectedResult =
      !RETIRABLE.has(result.name) ||
      message.isError === true ||
      evidenceBearing(message.details) ||
      index >= boundary;
    if (protectedResult) protectedResults++;
    if (!RETIRABLE.has(result.name) || message.isError === true || evidenceBearing(message.details)) {
      continue;
    }
    candidates.set(index, { ...result, body });
    latest.set(result.identity, { index, id: result.id });
  }

  const output = [...messages];
  let retiredResults = 0;
  let retiredChars = 0;
  for (const [index, candidate] of candidates) {
    const replacement = latest.get(candidate.identity);
    if (!replacement || replacement.index === index || index >= boundary) continue;
    const original = messages[index]!;
    output[index] = {
      ...original,
      content: [{
        type: "text",
        text: `[context-qos retired superseded ${candidate.name} result; newer equivalent result is ${replacement.id}]`,
      }],
      details: {
        kind: MARKER_KIND,
        version: 1,
        reason: "superseded_success",
        supersededBy: replacement.id,
        originalChars: candidate.body.length,
      },
    };
    retiredResults++;
    retiredChars += candidate.body.length;
  }

  // Oversized retirement: a single huge unique result (the measured surge
  // driver: delegated fabric_exec output, graph exploration) inflates context
  // until compaction because no newer equivalent result ever supersedes it.
  // Retire old successful bodies above the ceiling with a typed marker; the
  // recent window, errors, mutations, evidence, and non-text content stay exact.
  const ceiling =
    options.maxResultChars === undefined ? Infinity : Math.max(1, Math.floor(options.maxResultChars));
  if (ceiling !== Infinity) {
    for (let index = 0; index < output.length; index++) {
      const message = output[index]!;
      const result = resultIdentity(message, calls);
      const body = textBody(message.content);
      if (!result || body === undefined || body.length <= ceiling) continue;
      if (index >= boundary || message.isError === true || evidenceBearing(message.details)) {
        protectedResults++;
        continue;
      }
      if (!OVERSIZED_RETIRABLE.has(result.name)) continue;
      const original = messages[index]!;
      output[index] = {
        ...original,
        content: [{
          type: "text",
          text: `[context-qos retired oversized ${result.name} result; original ${body.length} chars]`,
        }],
        details: {
          kind: MARKER_KIND,
          version: 1,
          reason: "oversized_result",
          originalChars: body.length,
        },
      };
      retiredResults++;
      retiredChars += body.length;
    }
  }

  return {
    messages: output,
    changed: retiredResults > 0,
    report: { retiredResults, retiredChars, protectedResults },
  };
};
