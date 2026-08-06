import { describe, expect, it } from "vitest";
import { applyHandoffRetirement } from "../src/context/handoff-retirement.js";
import { PREWALK_CONTINUE_MESSAGE_TYPE } from "../src/prewalk/continuation.js";

type Message = Record<string, unknown> & { role: string };
const user = (text: string): Message => ({ role: "user", content: text });
const call = (id: string, name: string, args: Record<string, unknown>): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (
  id: string,
  name: string,
  text: string,
  options: { isError?: boolean; details?: unknown } = {},
): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError: options.isError === true,
  ...(options.details === undefined ? {} : { details: options.details }),
});
const continuation = (handoffId: string): Message => ({
  role: "custom",
  customType: PREWALK_CONTINUE_MESSAGE_TYPE,
  content: "Continue the task under the executor model.",
  details: { continuationId: handoffId },
});

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content.map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      ).join("")
    : String(message.content ?? "");

describe("applyHandoffRetirement", () => {
  it("retires pre-boundary retirable results only when enabled with a live continuation", () => {
    const messages = [
      user("plan"),
      call("r1", "read", { path: "src/a.ts" }),
      result("r1", "read", "old source ".repeat(400)),
      call("g1", "grep", { pattern: "foo" }),
      result("g1", "grep", "match".repeat(300)),
      call("f1", "find", { glob: "**/*.ts" }),
      result("f1", "find", "files".repeat(200)),
      call("l1", "ls", { path: "src" }),
      result("l1", "ls", "entries".repeat(150)),
      call("e1", "edit", { path: "src/a.ts" }),
      result("e1", "edit", "changed".repeat(500)),
      call("re", "read", { path: "src/missing.ts" }),
      result("re", "read", "ENOENT".repeat(500), { isError: true }),
      call("ev", "read", { path: "src/b.ts" }),
      result("ev", "read", "evidence".repeat(500), {
        details: { gates: [{ gate: "acceptance", passed: true }] },
      }),
      continuation("handoff-1"),
      user("executor continues"),
      call("r2", "read", { path: "src/c.ts" }),
      result("r2", "read", "post".repeat(300)),
    ];

    const compacted = applyHandoffRetirement(messages, {
      continuationId: "handoff-1",
      enabled: true,
    });

    expect(compacted.changed).toBe(true);
    expect(compacted.messages).toHaveLength(messages.length);
    expect(compacted.messages.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    // Pre-boundary read/grep/find/ls results are retired to markers.
    expect(textOf(compacted.messages[2]!)).toContain(
      "[context-qos retired pre-handoff read result",
    );
    expect(textOf(compacted.messages[4]!)).toContain(
      "[context-qos retired pre-handoff grep result",
    );
    expect(textOf(compacted.messages[6]!)).toContain(
      "[context-qos retired pre-handoff find result",
    );
    expect(textOf(compacted.messages[8]!)).toContain(
      "[context-qos retired pre-handoff ls result",
    );
    // Non-retirable tool result survives.
    expect(textOf(compacted.messages[10]!)).toBe("changed".repeat(500));
    // Error result survives.
    expect(textOf(compacted.messages[12]!)).toBe("ENOENT".repeat(500));
    // Evidence-bearing result survives.
    expect(textOf(compacted.messages[14]!)).toBe("evidence".repeat(500));
    // Post-boundary result survives.
    expect(textOf(compacted.messages[18]!)).toBe("post".repeat(300));
    expect(compacted.report).toMatchObject({ retiredResults: 4 });
  });

  it("changes nothing when disabled", () => {
    const messages = [
      user("plan"),
      call("r1", "read", { path: "a" }),
      result("r1", "read", "x".repeat(100)),
      continuation("h1"),
    ];
    const out = applyHandoffRetirement(messages, { continuationId: "h1", enabled: false });
    expect(out.changed).toBe(false);
    expect(out.messages).toEqual(messages);
    expect(out.report.retiredResults).toBe(0);
  });

  it("changes nothing without a matching continuation message", () => {
    const messages = [
      user("plan"),
      call("r1", "read", { path: "a" }),
      result("r1", "read", "x".repeat(100)),
    ];
    const out = applyHandoffRetirement(messages, { continuationId: "h1", enabled: true });
    expect(out.changed).toBe(false);
    expect(out.messages).toEqual(messages);
  });

  it("is idempotent", () => {
    const messages = [
      user("plan"),
      call("r1", "read", { path: "a" }),
      result("r1", "read", "x".repeat(200)),
      continuation("h1"),
    ];
    const once = applyHandoffRetirement(messages, { continuationId: "h1", enabled: true });
    const twice = applyHandoffRetirement(once.messages, { continuationId: "h1", enabled: true });
    expect(twice.messages).toEqual(once.messages);
  });
});
