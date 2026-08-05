import { describe, expect, it } from "vitest";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 128 * 1024 * 1024,
};

describe("NodeProcessRuntime", () => {
  it("runs guest code in a disposable process and bridges host calls", async () => {
    const result = await new NodeProcessRuntime().execute(
      `
const models = await tools.models();
print("models", models.length);
return { models, process: typeof process, require: typeof require };
`,
      async (ref) => ref === "fabric.$models" ? [{ id: "large-model" }] : undefined,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["models 1"]);
    expect(result.value).toEqual({
      models: [{ id: "large-model" }],
      process: "undefined",
      require: "undefined",
    });
  });

  it("extends the active deadline for a long host call", async () => {
    const result = await new NodeProcessRuntime().execute(
      'await tools.call({ ref: "pi.bash", args: { timeout: 1 } }); return "ok";',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        return { output: "ok" };
      },
      {
        ...options,
        timeoutMs: 1_000,
        minimumTimeoutMsForHostCall(ref) {
          return ref === "fabric.$call" ? 3_000 : undefined;
        },
      },
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("ok");
  });

  it("preserves named string payloads", async () => {
    const content = [
      "multiline",
      "` ${value} { braces }",
      "quotes: \" '",
      "nul:" + String.fromCharCode(0) + " end",
    ].join("\n");
    const result = await new NodeProcessRuntime().execute(
      "return π.content;",
      async () => undefined,
      { ...options, strings: { content } },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toBe(content);
  });

  it("accepts a heap limit above the QuickJS WASM32 ceiling", async () => {
    const result = await new NodeProcessRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, memoryLimitBytes: 5 * 1024 ** 3 },
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe(1);
  });

  it("waits for issued host calls before completing", async () => {
    let settled = false;
    const result = await new NodeProcessRuntime().execute(
      'void tools.call({ ref: "demo.background" }); return "done";',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        settled = true;
      },
      options,
    );

    expect(result.value).toBe("done");
    expect(settled).toBe(true);
  });

  it("does not wait for a non-cooperative sibling host call after guest failure", async () => {
    const startedAt = Date.now();
    const result = await new NodeProcessRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.never" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("branch failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds non-cooperative fire-and-forget host calls", async () => {
    const startedAt = Date.now();
    const result = await new NodeProcessRuntime().execute(
      'void tools.call({ ref: "demo.never" }); return "done";',
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("done");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("forcibly terminates synchronous infinite loops", async () => {
    const result = await new NodeProcessRuntime().execute(
      "while (true) {}",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );

    expect(result.terminationReason).toBe("timed_out");
    expect(result.error).toContain("timed out after 50ms");
  });

  it("surfaces unbounded recursion as a runtime error", async () => {
    const result = await new NodeProcessRuntime().execute(
      "function f() { return f() + 1; } f();",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("Maximum call stack size exceeded");
  });

  it("terminates the child process when externally aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 25);
    const result = await new NodeProcessRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, signal: controller.signal },
    );

    expect(result.terminationReason).toBe("aborted");
    expect(result.error).toBe("Execution cancelled");
  });
});
