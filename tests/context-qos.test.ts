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

describe("applyContextQos oversized-result retirement", () => {
  const options = { turnWindow: 1, minResultChars: 1_000, maxResultChars: 1_000 };

  it("retires an oversized unique fabric_exec result beyond the recent window", () => {
    const bigBody = "huge delegated output ".repeat(400);
    const messages = [
      user("delegate"),
      call("fe-1", "fabric_exec", { task: "scout" }),
      result("fe-1", "fabric_exec", bigBody),
      user("current request"),
    ];

    const compacted = applyContextQos(messages, options);

    expect(compacted.changed).toBe(true);
    expect(compacted.messages).toHaveLength(messages.length);
    expect(compacted.messages.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    expect(textOf(compacted.messages[2]!)).toContain(
      "[context-qos retired oversized fabric_exec result",
    );
    expect(compacted.report).toMatchObject({ retiredResults: 1 });
    expect(compacted.report.retiredChars).toBeGreaterThan(1_000);

    const repeated = applyContextQos(compacted.messages, options);
    expect(repeated.messages).toEqual(compacted.messages);
  });

  it("retires an oversized unique codemap result with no equivalent newer call", () => {
    const messages = [
      user("map"),
      call("cm-1", "codemap", { operation: "explore" }),
      result("cm-1", "codemap", "graph output ".repeat(500)),
      user("current"),
    ];
    const compacted = applyContextQos(messages, options);
    expect(textOf(compacted.messages[2]!)).toContain(
      "[context-qos retired oversized codemap result",
    );
    expect(compacted.report.retiredResults).toBe(1);
  });

  it("protects oversized results inside the recent-turn window", () => {
    const messages = [
      user("old turn"),
      call("old-fe", "fabric_exec", { task: "x" }),
      result("old-fe", "fabric_exec", "old ".repeat(500)),
      user("current"),
      call("fe-now", "fabric_exec", { task: "y" }),
      result("fe-now", "fabric_exec", "fresh huge ".repeat(500)),
      user("still current"),
    ];
    // turnWindow 2 keeps the last two user turns (and everything after the
    // second-to-last) exact, so the fresh result is protected while the old one
    // is still retired.
    const compacted = applyContextQos(messages, { ...options, turnWindow: 2 });
    expect(textOf(compacted.messages[2]!)).toContain(
      "[context-qos retired oversized fabric_exec result",
    );
    expect(textOf(compacted.messages[5]!)).toBe("fresh huge ".repeat(500));
  });

  it("protects oversized error and evidence-bearing results", () => {
    const messages = [
      user("bad"),
      call("err-1", "fabric_exec", { task: "boom" }),
      result("err-1", "fabric_exec", "traceback ".repeat(500), { isError: true }),
      call("ev-1", "fabric_exec", { task: "verify" }),
      result("ev-1", "fabric_exec", "evidence ".repeat(500), {
        details: { evidence: [{ ref: "tests/x.test.ts", ok: true }] },
      }),
      user("current"),
    ];
    const compacted = applyContextQos(messages, options);
    expect(textOf(compacted.messages[2]!)).toBe("traceback ".repeat(500));
    expect(textOf(compacted.messages[4]!)).toBe("evidence ".repeat(500));
    expect(compacted.report.retiredResults).toBe(0);
    expect(compacted.report.protectedResults).toBeGreaterThan(0);
  });

  it("protects mutation results even when oversized", () => {
    const messages = [
      user("write"),
      call("edit-1", "edit", { path: "src/a.ts" }),
      result("edit-1", "edit", "applied".repeat(500)),
      user("current"),
    ];
    const compacted = applyContextQos(messages, options);
    expect(textOf(compacted.messages[2]!)).toBe("applied".repeat(500));
    expect(compacted.changed).toBe(false);
  });

  it("is a no-op below the configured maxResultChars", () => {
    const messages = [
      user("small"),
      call("fe-1", "fabric_exec", { task: "quick" }),
      result("fe-1", "fabric_exec", "small result"),
      user("current"),
    ];
    const compacted = applyContextQos(messages, {
      turnWindow: 1,
      minResultChars: 1_000,
      maxResultChars: 100_000,
    });
    expect(compacted.changed).toBe(false);
    expect(textOf(compacted.messages[2]!)).toBe("small result");
  });

  it("preserves marker details and leaves non-text content untouched", () => {
    const messages: Message[] = [
      user("mixed"),
      call("fe-1", "fabric_exec", { task: "huge" }),
      result("fe-1", "fabric_exec", "big ".repeat(500)),
      {
        role: "toolResult",
        toolCallId: "img-1",
        toolName: "screenshot",
        content: [{ type: "image", data: "base64..." }],
      },
      user("current"),
    ];
    const compacted = applyContextQos(messages, options);
    const marker = compacted.messages[2] as { details?: Record<string, unknown> };
    expect(marker.details).toMatchObject({ kind: "pi-fabric.context-qos", reason: "oversized_result" });
    expect(marker.details?.originalChars).toBe("big ".repeat(500).length);
    expect(compacted.messages[3]).toEqual(messages[3]);
  });
});