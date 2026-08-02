import { describe, expect, it } from "vitest";
import { applyContextQos } from "../src/context/qos.js";

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

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content.map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      ).join("")
    : String(message.content ?? "");

describe("applyContextQos", () => {
  it("retires only old superseded read results while preserving structural pairs", () => {
    const oldBody = "old source ".repeat(400);
    const latestBody = "latest source ".repeat(400);
    const messages = [
      user("inspect"),
      call("read-1", "read", { path: "src/a.ts" }),
      result("read-1", "read", oldBody),
      call("edit-1", "edit", { path: "src/a.ts" }),
      result("edit-1", "edit", "changed".repeat(500)),
      call("read-error", "read", { path: "src/missing.ts" }),
      result("read-error", "read", "ENOENT".repeat(500), { isError: true }),
      user("inspect again"),
      call("read-2", "read", { path: "src/a.ts" }),
      result("read-2", "read", latestBody),
      user("current request"),
    ];

    const compacted = applyContextQos(messages, {
      turnWindow: 1,
      minResultChars: 1_000,
    });

    expect(compacted.changed).toBe(true);
    expect(compacted.messages).toHaveLength(messages.length);
    expect(compacted.messages.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    expect(textOf(compacted.messages[2]!)).toContain(
      "[context-qos retired superseded read result",
    );
    expect(textOf(compacted.messages[4]!)).toBe("changed".repeat(500));
    expect(textOf(compacted.messages[6]!)).toBe("ENOENT".repeat(500));
    expect(textOf(compacted.messages[9]!)).toBe(latestBody);
    expect(compacted.report).toMatchObject({ retiredResults: 1 });
    expect(compacted.report.retiredChars).toBeGreaterThan(1_000);

    const repeated = applyContextQos(compacted.messages, {
      turnWindow: 1,
      minResultChars: 1_000,
    });
    expect(repeated.messages).toEqual(compacted.messages);
  });

  it("protects Fabric evidence-bearing results even when a later read matches", () => {
    const messages = [
      user("verify"),
      call("read-1", "read", { path: "src/a.ts" }),
      result("read-1", "read", "evidence".repeat(500), {
        details: { gates: [{ gate: "acceptance", passed: true }] },
      }),
      user("again"),
      call("read-2", "read", { path: "src/a.ts" }),
      result("read-2", "read", "latest".repeat(500)),
      user("current"),
    ];
    const compacted = applyContextQos(messages, { turnWindow: 1, minResultChars: 100 });
    expect(textOf(compacted.messages[2]!)).toBe("evidence".repeat(500));
    expect(compacted.report.protectedResults).toBeGreaterThan(0);
  });
});
