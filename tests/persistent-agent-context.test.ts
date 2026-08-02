import { describe, expect, it } from "vitest";
import { buildPersistentAgentContext } from "../src/agents/persistent/context.js";

const branch = (messages: unknown[]) => messages.map((message) => ({ type: "message", message }));

describe("buildPersistentAgentContext", () => {
  it("builds a digest with touched files, open errors, and the last user request", () => {
    const ctx = buildPersistentAgentContext(
      branch([
        { role: "user", content: "Fix the login bug" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file." },
            { type: "toolCall", name: "read", arguments: { file: "src/auth.ts" } },
          ],
        },
        { role: "toolResult", toolName: "read", content: "export function login() {}", isError: false },
        { role: "bashExecution", command: "pnpm test", output: "1 failed", exitCode: 1 },
      ]),
      14,
      40_000,
    );
    expect(ctx.digest.filesTouched).toContain("src/auth.ts");
    expect(ctx.digest.openErrors).toBe(1);
    expect(ctx.digest.lastError).toContain("1 failed");
    expect(ctx.digest.lastUserRequest).toBe("Fix the login bug");
  });

  it("compacts the transcript to one-liners in oldest-first order", () => {
    const ctx = buildPersistentAgentContext(
      branch([
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "read", arguments: { file: "a.ts" } },
          ],
        },
        { role: "toolResult", toolName: "read", content: "x", isError: false },
        { role: "user", content: "second" },
      ]),
      14,
      40_000,
    );
    const joined = ctx.transcript.join("\n");
    expect(joined).toContain("user: first");
    expect(joined).toContain("asst: ok");
    expect(joined).toContain("call: read a.ts");
    expect(joined).toContain("result read: x");
    expect(joined).toContain("user: second");
    expect(ctx.transcript.indexOf("user: first")).toBeLessThan(ctx.transcript.indexOf("user: second"));
  });

  it("caps the transcript to the tail count of messages", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
    const ctx = buildPersistentAgentContext(branch(msgs), 5, 40_000);
    expect(ctx.transcript).toHaveLength(5);
    expect(ctx.transcript[0]).toContain("turn 15");
    expect(ctx.transcript[4]).toContain("turn 19");
  });

  it("truncates long content and bounds total transcript chars", () => {
    const long = "x".repeat(5000);
    const ctx = buildPersistentAgentContext(
      branch([
        { role: "user", content: long },
        { role: "user", content: long },
        { role: "user", content: long },
      ]),
      14,
      500,
    );
    expect(ctx.transcript.every((l) => l.length < 220)).toBe(true);
    expect(ctx.transcript.join("\n").length).toBeLessThanOrEqual(500);
  });

  it("skips thinking blocks and renders bashExecution compactly", () => {
    const ctx = buildPersistentAgentContext(
      branch([
        { role: "assistant", content: [{ type: "thinking", thinking: "internal", redacted: false }] },
        { role: "bashExecution", command: "rg foo", output: "", exitCode: 0 },
      ]),
      14,
      40_000,
    );
    expect(ctx.transcript.find((l) => l.startsWith("think"))).toBeUndefined();
    expect(ctx.transcript.find((l) => l.startsWith("bash:"))).toContain("-> 0");
  });

  it("produces a byte-stable digest for identical input (cache-friendly)", () => {
    const b = branch([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "b.ts", edits: [] } }] },
    ]);
    const a = JSON.stringify(buildPersistentAgentContext(b, 14, 40_000).digest);
    const c = JSON.stringify(buildPersistentAgentContext(structuredClone(b), 14, 40_000).digest);
    expect(a).toEqual(c);
  });
});
