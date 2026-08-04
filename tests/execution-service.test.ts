import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { FabricActivityStore } from "../src/activity/store.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { PrewalkController } from "../src/prewalk/controller.js";

describe("FabricExecutionService", () => {
  it("defers explicit handoff and completes every later call in the same program", async () => {
    const registry = new ActionRegistry();
    const demoDescriptor = {
      name: "call",
      description: "demo call",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo",
      async list() { return [demoDescriptor]; },
      async describe(name) { return name === "call" ? demoDescriptor : undefined; },
      async invoke(_name, args) { return { echoed: args.value }; },
    });
    const handoffDescriptor = {
      name: "handoff",
      description: "defer handoff",
      inputSchema: {
        type: "object",
        properties: { model: { type: "string" }, task: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "agents",
      async list() { return [handoffDescriptor]; },
      async describe(name) { return name === "handoff" ? handoffDescriptor : undefined; },
      async invoke(_name, args, context) {
        if (!context.deferHandoff) throw new Error("missing deferred boundary");
        return context.deferHandoff(args);
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
await tools.call({ ref: "demo.call", args: { value: "before" } });
const scheduled = await agents.handoff({
  model: "provider/executor",
  task: "Finish after this complete Fabric program",
});
const after = await tools.call({ ref: "demo.call", args: { value: "after" } });
return { scheduled, after };
`,
      signal: undefined,
      parentToolCallId: "handoff-at-outer-boundary",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.audits.map((audit) => audit.ref)).toEqual([
      "demo.call",
      "agents.handoff",
      "demo.call",
    ]);
    expect(result.value).toMatchObject({
      scheduled: {
        scheduled: true,
        status: "deferred",
        boundary: "fabric_exec_end",
      },
      after: { echoed: "after" },
    });
    expect(result.handoffRequest).toEqual({
      model: "provider/executor",
      task: "Finish after this complete Fabric program",
    });
  });

  it("applies the same deferred boundary through generic tools.call", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "handoff",
      description: "defer handoff",
      inputSchema: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "handoff" ? descriptor : undefined; },
      async invoke(_name, args, context) {
        return context.deferHandoff!(args);
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const result = await new FabricExecutionService(registry, config).execute({
      code: `
const scheduled = await tools.call({
  ref: "agents.handoff",
  args: { model: "provider/generic" },
});
return { scheduled, tail: "still ran" };
`,
      signal: undefined,
      parentToolCallId: "generic-handoff-boundary",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.value).toMatchObject({
      scheduled: {
        scheduled: true,
        status: "deferred",
        boundary: "fabric_exec_end",
      },
      tail: "still ran",
    });
    expect(result.handoffRequest).toEqual({ model: "provider/generic" });
  });

  it.each(["quickjs", "node-process"] as const)(
    "finishes every nested call in the %s fabric_exec before handoff can be claimed",
    async (runtime) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-prewalk-"));
      try {
        const registry = new ActionRegistry();
        registry.register(new PiToolsProvider(cwd, undefined, undefined));
        const config = structuredClone(DEFAULT_FABRIC_CONFIG);
        config.executor.runtime = runtime;
        if (runtime === "node-process") {
          config.executor.memoryLimitBytes = 128 * 1024 * 1024;
        }
        config.approvals.write = "allow";
        const service = new FabricExecutionService(registry, config);
        const result = await service.execute({
          code: `
await pi.write({ path: "first.txt", content: "first" });
await Promise.all([
  pi.write({ path: "second.txt", content: "second" }),
  pi.write({ path: "third.txt", content: "third" }),
]);
return "complete outer result";
`,
          signal: undefined,
          parentToolCallId: "prewalk-complete-program",
          context: { cwd, hasUI: false } as ExtensionContext,
          onPartial() {},
        });

        expect(result.success).toBe(true);
        expect(result.value).toBe("complete outer result");
        expect(result.audits.map((audit) => audit.ref)).toEqual([
          "pi.write",
          "pi.write",
          "pi.write",
        ]);
        expect(fs.readdirSync(cwd).sort()).toEqual([
          "first.txt",
          "second.txt",
          "third.txt",
        ]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(["quickjs", "node-process"] as const)(
    "stops the %s executor immediately after the first successful research mutation",
    async (runtime) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-research-"));
      try {
        const registry = new ActionRegistry();
        registry.register(new PiToolsProvider(cwd, undefined, undefined));
        const config = structuredClone(DEFAULT_FABRIC_CONFIG);
        config.executor.runtime = runtime;
        if (runtime === "node-process") config.executor.memoryLimitBytes = 128 * 1024 * 1024;
        config.approvals.write = "allow";
        const controller = new PrewalkController();
        controller.arm({
          model: "anthropic/executor",
          sessionId: "session-1",
        });
        const result = await new FabricExecutionService(registry, config).execute({
          code: `
await prewalk.checklist({
  items: Array.from({ length: 5 }, (_, index) => ({
    task: "Change target " + (index + 1),
    validation: "Run check " + (index + 1),
  })),
});
try {
  await pi.edit({
    path: "missing.txt",
    edits: [{ oldText: "missing", newText: "changed" }],
  });
} catch {}
await pi.write({ path: "first.txt", content: "first" });
await pi.write({ path: "second.txt", content: "second" });
return "late result";
`,
          signal: undefined,
          parentToolCallId: `research-boundary-${runtime}`,
          context: { cwd, hasUI: false } as ExtensionContext,
          prewalk: controller.executionBoundary("session-1")!,
          onPartial() {},
        });

        expect(result.success).toBe(true);
        expect(result.trace.outcome).toBe("succeeded");
        expect(result.value).toBeUndefined();
        expect(result.prewalkBoundary).toMatchObject({ ref: "pi.write" });
        expect(result.audits.map((audit) => [audit.ref, audit.success])).toEqual([
          ["pi.edit", false],
          ["pi.write", true],
        ]);
        expect(fs.existsSync(path.join(cwd, "first.txt"))).toBe(true);
        expect(fs.existsSync(path.join(cwd, "second.txt"))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(["quickjs", "node-process"] as const)(
    "blocks a %s research mutation before checklist readiness",
    async (runtime) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-unready-"));
      try {
        const registry = new ActionRegistry();
        registry.register(new PiToolsProvider(cwd, undefined, undefined));
        const config = structuredClone(DEFAULT_FABRIC_CONFIG);
        config.executor.runtime = runtime;
        if (runtime === "node-process") config.executor.memoryLimitBytes = 128 * 1024 * 1024;
        config.approvals.write = "allow";
        const controller = new PrewalkController();
        controller.arm({
          model: "anthropic/executor",
          sessionId: "session-1",
        });
        const result = await new FabricExecutionService(registry, config).execute({
          code: 'await pi.write({ path: "unready.txt", content: "no" });',
          signal: undefined,
          parentToolCallId: `research-unready-${runtime}`,
          context: { cwd, hasUI: false } as ExtensionContext,
          prewalk: controller.executionBoundary("session-1")!,
          onPartial() {},
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/prewalk\.checklist/i);
        expect(result.prewalkBoundary).toBeUndefined();
        expect(fs.existsSync(path.join(cwd, "unready.txt"))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("calls a Pi built-in from sandboxed TypeScript", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-execution-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "fabric works\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = {
        cwd,
        hasUI: false,
      } as ExtensionContext;
      const result = await service.execute({
        code: 'const content = await pi.read({ path: "sample.txt" });\nreturn content.trim();',
        signal: undefined,
        parentToolCallId: "test",
        context,
        onPartial() {},
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("fabric works");
      expect(result.audits).toMatchObject([
        { ref: "pi.read", success: true, tool: "read", provider: "pi" },
      ]);
      expect(result.audits[0]?.args).toMatchObject({ path: "sample.txt" });
      expect(result.audits[0]?.result).toBe("fabric works\n");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses the configured disposable Node process executor", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    config.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const service = new FabricExecutionService(new ActionRegistry(), config);
    const result = await service.execute({
      code: 'print("native"); return { answer: 42 };',
      signal: undefined,
      parentToolCallId: "native-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual(["native"]);
    expect(result.value).toEqual({ answer: 42 });
  });

  it("coalesces all parallel nested calls through one global debounce and flushes on settle", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ping",
      description: "emit rapid progress",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "debounce fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "ping" ? descriptor : undefined;
      },
      async invoke(_name, args, invocation) {
        invocation.update(`starting ${String(args.id)}`);
        invocation.update(`finishing ${String(args.id)}`);
        return args.id;
      },
    });
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const code = `return Promise.all([
      tools.call({ ref: "demo.ping", args: { id: 1 } }),
      tools.call({ ref: "demo.ping", args: { id: 2 } }),
      tools.call({ ref: "demo.ping", args: { id: 3 } }),
    ]);`;

    const debouncedConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
    debouncedConfig.fullCodeMode = false;
    debouncedConfig.approvals.read = "allow";
    debouncedConfig.ui.nestedToolDebounceMs = 10_000;
    const debouncedPartials: Array<{ audits: unknown[] }> = [];
    const debounced = await new FabricExecutionService(registry, debouncedConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "global-debounce",
      context,
      onPartial(snapshot) {
        debouncedPartials.push(snapshot);
      },
    });
    expect(debounced.success).toBe(true);
    expect(debouncedPartials).toHaveLength(1);
    expect(debouncedPartials[0]?.audits).toHaveLength(3);

    const immediateConfig = structuredClone(debouncedConfig);
    immediateConfig.ui.nestedToolDebounceMs = 0;
    const immediatePartials: unknown[] = [];
    await new FabricExecutionService(registry, immediateConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "no-debounce",
      context,
      onPartial(snapshot) {
        immediatePartials.push(snapshot);
      },
    });
    expect(immediatePartials.length).toBeGreaterThan(1);
  });

  it("ignores late nested updates after activity resets during execution", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit progress on demand",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    let emitUpdate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() { return [descriptor]; },
      async describe(name) { return name === "stream" ? descriptor : undefined; },
      async invoke(_name, _args, invocation) {
        emitUpdate = () => invocation.update("late output");
        markStarted();
        await released;
        return true;
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    const activity = new FabricActivityStore();
    const execution = new FabricExecutionService(registry, config, activity).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "reset-during-stream",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    await started;
    expect(activity.get("reset-during-stream")?.status).toBe("running");
    activity.reset();
    expect(() => emitUpdate()).not.toThrow();
    release();

    await expect(execution).resolves.toMatchObject({ success: true, value: true });
    expect(activity.get("reset-during-stream")).toBeUndefined();
  });

  it("throttles continuous nested progress without starving intermediate snapshots", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit sustained progress",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() { return [descriptor]; },
      async describe(name) { return name === "stream" ? descriptor : undefined; },
      async invoke(_name, _args, invocation) {
        for (let index = 0; index < 8; index++) {
          invocation.update(`tick ${index}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.ui.nestedToolDebounceMs = 50;
    const partials: Array<{ progress?: string | undefined; audits: Array<{ success?: boolean }> }> = [];

    const result = await new FabricExecutionService(registry, config).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "continuous-progress",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) { partials.push(structuredClone(snapshot)); },
    });

    expect(result.success).toBe(true);
    expect(partials.some((snapshot) => snapshot.audits[0]?.success === undefined)).toBe(true);
    expect(partials.some((snapshot) => snapshot.progress?.startsWith("tick ") && snapshot.progress !== "tick 7")).toBe(true);
    expect(partials.length).toBeLessThan(8);
  });

  it("coalesces rapid workflow phase updates through the same debounce", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.ui.nestedToolDebounceMs = 10_000;
    const partials: Array<{ phases: string[] }> = [];
    const result = await new FabricExecutionService(new ActionRegistry(), config).execute({
      code: `
for (let index = 0; index < 50; index++) {
  await phase("Phase " + index);
}
return "done";
`,
      signal: undefined,
      parentToolCallId: "phase-debounce",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) {
        partials.push(snapshot);
      },
    });

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(50);
    expect(partials).toHaveLength(1);
    expect(partials[0]?.phases).toHaveLength(50);
  });

  it("attaches image blocks to the audit for a single nested image read", async () => {
    const cwd = process.cwd();
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(cwd, undefined, undefined));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.read = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd, hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return pi.read({ path: "tests/fixtures/images/sample.jpg" });',
      signal: undefined,
      parentToolCallId: "img-read",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.audits).toHaveLength(1);
    const media = result.audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
  }, 15_000);

  it("keeps Pi core tools outside Fabric in orchestration-only mode", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-native-tools-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "native\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.fullCodeMode = false;
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = { cwd, hasUI: false } as ExtensionContext;

      const metadata = await service.execute({
        code: `
return {
  providers: await tools.providers(),
  catalog: await tools.catalog(),
  search: await tools.search({ query: "read" }),
};
`,
        signal: undefined,
        parentToolCallId: "native-metadata",
        context,
        onPartial() {},
      });
      expect(metadata.success).toBe(true);
      expect(metadata.value).toMatchObject({
        providers: [],
        catalog: {
          kind: "pi-fabric.capability-catalog",
          complete: true,
          totalActions: 0,
          indexedActions: 0,
          providers: [],
          root: {
            key: "capability:fabric",
            description: expect.stringContaining("not historical session evidence"),
          },
        },
        search: [],
      });

      const direct = await service.execute({
        code: 'return pi.read({ path: "sample.txt" });',
        signal: undefined,
        parentToolCallId: "native-direct",
        context,
        onPartial() {},
      });
      expect(direct.typeErrors?.map((error) => error.message).join(" ")).toContain(
        "Cannot find name 'pi'",
      );

      const indirect = await service.execute({
        code: 'return tools.call({ ref: "pi.read", args: { path: "sample.txt" } });',
        signal: undefined,
        parentToolCallId: "native-indirect",
        context,
        onPartial() {},
      });
      expect(indirect.success).toBe(false);
      expect(indirect.error).toContain("full code mode is disabled");
      expect(indirect.audits).toEqual([]);

      const extension = await service.execute({
        code: 'return tools.call({ ref: "extensions.project_status", args: {} });',
        signal: undefined,
        parentToolCallId: "native-extension",
        context,
        onPartial() {},
      });
      expect(extension.success).toBe(false);
      expect(extension.error).toContain("registered extension tools directly outside fabric_exec");
      expect(extension.audits).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("retains a terminal transition when the ledger is full", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.executor.maxRunTransitions = 2;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: 'return "ok";',
      signal: undefined,
      parentToolCallId: "bounded-terminal-transition",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.transitions?.map(({ sequence, state }) => ({ sequence, state }))).toEqual([
      { sequence: 1, state: "accepted" },
      { sequence: 2, state: "completed" },
    ]);
  });

  it("publishes declarative workflow activity for the dynamic TUI", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-activity-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "dashboard\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const activity = new FabricActivityStore();
      const service = new FabricExecutionService(registry, config, activity);
      const context = { cwd, hasUI: false } as ExtensionContext;
      const partials: Array<{ phases: string[] }> = [];
      const result = await service.execute({
        code: `
await workflow.configure({ name: "File audit", description: "Read one fixture" });
await phase("Inspect", { id: "inspect", total: 1 });
await workflow.item({ id: "fixture", label: "Read fixture", status: "running" });
const text = await pi.read({ path: "sample.txt" });
await workflow.item({ id: "fixture", label: "Read fixture", status: "completed", completed: 1, total: 1 });
await workflow.event({ message: "Fixture inspected", level: "success" });
return text.trim();
`,
        signal: undefined,
        parentToolCallId: "activity-test",
        context,
        onPartial(snapshot) {
          partials.push(snapshot);
        },
      });

      expect(result.success).toBe(true);
      expect(partials.some((partial) => partial.phases.includes("Inspect"))).toBe(true);
      expect(activity.get("activity-test")).toMatchObject({
        name: "File audit",
        description: "Read one fixture",
        status: "completed",
        phases: [{ id: "inspect", name: "Inspect", status: "completed", total: 1 }],
        calls: [{ ref: "pi.read", status: "completed", phaseId: "inspect" }],
        items: [{ id: "fixture", status: "completed", completed: 1, total: 1 }],
        events: [{ message: "Fixture inspected", level: "success" }],
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("propagates one run envelope through provider invocation", async () => {
    let observedRun: unknown;
    const registry = new ActionRegistry();
    const descriptor = {
      name: "inspect",
      description: "inspect run context",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo",
      async list() { return [descriptor]; },
      async describe(name) { return name === "inspect" ? descriptor : undefined; },
      async invoke(_name, _args, invocation) {
        observedRun = (invocation as { run?: unknown }).run;
        return "ok";
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.inspect", args: {} });',
      signal: undefined,
      parentToolCallId: "run-context-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    const objectiveDigest = createHash("sha256")
      .update('return tools.call({ ref: "demo.inspect", args: {} });')
      .digest("hex");
    expect(result).toMatchObject({
      success: true,
      run: {
        version: 1,
        runId: "run-context-test",
        objectiveDigest,
        cancellationOwner: "run-context-test",
      },
      transitions: [
        { sequence: 1, state: "accepted" },
        { sequence: 2, state: "executing" },
        { sequence: 3, state: "completed" },
      ],
    });
    expect(observedRun).toEqual(expect.objectContaining({
      runId: "run-context-test",
      traceId: expect.any(String),
      spanId: expect.any(String),
    }));
  });

  it("exposes a safe read-only workflow run context", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: "return workflow.context();",
      signal: undefined,
      parentToolCallId: "workflow-context-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      tokenBudget: 50,
      maxAgentCalls: 3,
      onPartial() {},
    });

    expect(result).toMatchObject({
      success: true,
      value: {
        run: {
          version: 1,
          runId: "workflow-context-test",
          objectiveDigest: expect.any(String),
          traceId: expect.any(String),
          spanId: expect.any(String),
        },
        budget: {
          agents: { limit: 3, spent: 0, reserved: 0, remaining: 3 },
          tokens: { limit: 50, spent: 0, reserved: 0, remaining: 50 },
        },
      },
    });
    expect(JSON.stringify(result.value)).not.toContain("return workflow.context()");
  });

  it("records ordered workflow gates and aborts on a failed abort gate", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
await workflow.gate({
  gate: "lint",
  passed: false,
  disposition: "advise",
  evidence: [{ kind: "command", ref: "cmd:lint" }],
});
await workflow.gate({
  gate: "security",
  passed: false,
  disposition: "abort",
  evidence: [],
  reason: "blocked",
});
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "gate-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Fabric gate aborted: security");
    expect(result).toMatchObject({
      gates: [
        { sequence: 1, gate: "lint", decision: "continue" },
        { sequence: 2, gate: "security", decision: "abort", failure: "gate_failed" },
      ],
    });
  });

  it("keeps abort and crash gates terminal when guest code catches the bridge error", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    const aborted = await service.execute({
      code: `
try {
  await workflow.gate({
    gate: "security",
    passed: false,
    disposition: "abort",
    evidence: [],
    reason: "blocked",
  });
} catch {}
return "must-not-escape";
`,
      signal: undefined,
      parentToolCallId: "caught-abort-gate",
      context,
      onPartial() {},
    });
    expect(aborted).toMatchObject({
      success: false,
      value: undefined,
      error: "Fabric gate aborted: security: blocked",
    });

    const crashed = await service.execute({
      code: `
try {
  await workflow.gate({
    gate: "infrastructure",
    passed: false,
    disposition: "advise",
    evidence: [],
    error: "runner crashed",
  });
} catch {}
return "must-not-escape";
`,
      signal: undefined,
      parentToolCallId: "caught-crash-gate",
      context,
      onPartial() {},
    });
    expect(crashed).toMatchObject({
      success: false,
      value: undefined,
      error: "Fabric gate crashed: infrastructure: runner crashed",
    });
  });

  it("keeps gate infrastructure failures terminal when guest code catches them", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.executor.maxRunTransitions = 1;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
await workflow.gate({
  gate: "first",
  passed: false,
  disposition: "advise",
  evidence: [],
});
try {
  await workflow.gate({
    gate: "overflow",
    passed: false,
    disposition: "advise",
    evidence: [],
  });
} catch {}
return "must-not-escape";
`,
      signal: undefined,
      parentToolCallId: "caught-gate-infrastructure",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.error).toContain("Fabric gate crashed: overflow");
    expect(result.error).toContain("result limit exhausted");
    expect(result.gates).toMatchObject([
      { sequence: 1, gate: "overflow", decision: "abort", failure: "gate_crashed" },
    ]);
  });

  it("rejects an unevidenced passing gate", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `return workflow.gate({
        gate: "acceptance",
        passed: true,
        disposition: "abort",
        evidence: [],
      });`,
      signal: undefined,
      parentToolCallId: "unevidenced-gate",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("passing result requires acceptance evidence");
    expect(result.gates).toMatchObject([
      {
        gate: "acceptance",
        decision: "abort",
        failure: "gate_crashed",
        error: "Fabric gate acceptance passing result requires acceptance evidence",
      },
    ]);
  });

  it("requires a revise gate to be resolved before successful settlement", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const revise = `
await workflow.gate({
  gate: "tests",
  passed: false,
  disposition: "revise",
  evidence: [{ kind: "command", ref: "cmd:test" }],
});
`;

    const unresolved = await service.execute({
      code: `${revise}\nreturn "unverified";`,
      signal: undefined,
      parentToolCallId: "unresolved-revision",
      context,
      onPartial() {},
    });
    expect(unresolved.success).toBe(false);
    expect(unresolved.value).toBeUndefined();
    expect(unresolved.error).toContain("Fabric gate revision required: tests");

    const resolved = await service.execute({
      code: `${revise}
await workflow.gate({
  gate: "tests",
  passed: true,
  disposition: "revise",
  evidence: [{ kind: "command", ref: "cmd:test:fixed" }],
});
return "verified";`,
      signal: undefined,
      parentToolCallId: "resolved-revision",
      context,
      onPartial() {},
    });
    expect(resolved).toMatchObject({ success: true, value: "verified" });
  });

  it("atomically reserves concurrent workflow tokens and reclaims sequential slack", async () => {
    const invokedMaxTokens: number[] = [];
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          maxTokens: { type: "number" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "run" ? descriptor : undefined; },
      async invoke(_name, args) {
        invokedMaxTokens.push(Number(args.maxTokens));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: "completed",
          text: String(args.task),
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    const concurrent = await service.execute({
      code: `
await Promise.all([
  agents.run({ task: "one" }),
  agents.run({ task: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "concurrent-reservation",
      context,
      tokenBudget: 100,
      maxAgentCalls: 2,
      onPartial() {},
    });
    expect(concurrent.success).toBe(false);
    expect(concurrent.error).toContain("Fabric token budget exhausted");
    expect(invokedMaxTokens).toEqual([100]);

    invokedMaxTokens.length = 0;
    const sequential = await service.execute({
      code: `
await agents.run({ task: "one" });
await agents.run({ task: "two" });
return "ok";
`,
      signal: undefined,
      parentToolCallId: "sequential-reservation",
      context,
      tokenBudget: 100,
      maxAgentCalls: 2,
      onPartial() {},
    });
    expect(sequential).toMatchObject({
      success: true,
      value: "ok",
      budget: {
        agents: { limit: 2, spent: 2, reserved: 0, remaining: 0 },
        tokens: { limit: 100, spent: 40, reserved: 0, remaining: 60 },
      },
    });
    expect(invokedMaxTokens).toEqual([100, 80]);
  });

  it("reserves persistentAgent ask admissions under the same finite run budget", async () => {
    const observed: number[] = [];
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ask",
      description: "fake persistentAgent ask",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          message: { type: "string" },
          maxTokens: { type: "number" },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "ask" ? descriptor : undefined; },
      async invoke(_name, args) {
        observed.push(Number(args.maxTokens));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          action: "message",
          text: "persistentAgent result",
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
await Promise.all([
  agents.ask({ id: "persistentAgent", message: "one" }),
  agents.ask({ id: "persistentAgent", message: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "persistentAgent-ask-reservations",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      tokenBudget: 100,
      maxAgentCalls: 2,
      onPartial() {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Fabric token budget exhausted");
    expect(observed).toEqual([100]);
  });

  it("conservatively commits a failed persistentAgent ask reservation", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ask",
      description: "fake persistentAgent ask",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          message: { type: "string" },
          maxTokens: { type: "number" },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "ask" ? descriptor : undefined; },
      async invoke() { throw new Error("persistentAgent run failed after launch"); },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
try { await agents.ask({ id: "persistentAgent", message: "fails" }); } catch {}
return workflow.context();
`,
      signal: undefined,
      parentToolCallId: "failed-persistentAgent-reservation",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      tokenBudget: 100,
      maxAgentCalls: 2,
      onPartial() {},
    });

    expect(result).toMatchObject({
      success: true,
      value: {
        budget: {
          agents: { spent: 1, reserved: 0, remaining: 1 },
          tokens: { spent: 100, reserved: 0, remaining: 0 },
        },
      },
    });
  });

  it("reclaims a failed detached launch reservation", async () => {
    const observed: Array<{ action: string; maxTokens: number }> = [];
    const registry = new ActionRegistry();
    const descriptor = (name: string) => ({
      name,
      description: `fake ${name}`,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" }, maxTokens: { type: "number" } },
        required: ["task"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    });
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() { return [descriptor("run"), descriptor("spawn")]; },
      async describe(name) { return name === "run" || name === "spawn" ? descriptor(name) : undefined; },
      async invoke(name, args) {
        observed.push({ action: name, maxTokens: Number(args.maxTokens) });
        if (name === "spawn") throw new Error("launch failed");
        return {
          status: "completed",
          text: "recovered",
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
try { await agents.spawn({ task: "fails" }); } catch {}
return agents.run({ task: "recovers" });
`,
      signal: undefined,
      parentToolCallId: "failed-detached-reservation",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      tokenBudget: 100,
      maxAgentCalls: 2,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(observed).toEqual([
      { action: "spawn", maxTokens: 100 },
      { action: "run", maxTokens: 100 },
    ]);
    expect(result.budget?.tokens).toEqual({ limit: 100, spent: 20, reserved: 0, remaining: 80 });
    expect(result.budget?.agents).toEqual({ limit: 2, spent: 2, reserved: 0, remaining: 0 });
  });

  it("enforces the per-execution agent budget", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args) {
        return {
          status: "completed",
          text: String(args.task),
          usage: { input: 1, output: 1 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
await Promise.all([
  agents.run({ task: "one" }),
  agents.run({ task: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "budget-test",
      context,
      maxAgentCalls: 1,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent budget exhausted (1 per execution)");
  });

  it("propagates monotonic host-call deadline extensions", async () => {
    let observedDeadline = 0;
    const registry = new ActionRegistry();
    const descriptor = {
      name: "bash",
      description: "fake bash",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "execute" as const,
    };
    registry.register({
      name: "pi",
      description: "fake pi",
      async list() { return [descriptor]; },
      async describe(name) { return name === "bash" ? descriptor : undefined; },
      async invoke(_name, _args, context) {
        observedDeadline = context.run?.deadline ?? 0;
        return { ok: true };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.executor.timeoutMs = 100;
    config.approvals.execute = "allow";
    const service = new FabricExecutionService(registry, config);
    const before = Date.now();
    const result = await service.execute({
      code: `return tools.call({
        ref: "pi.bash",
        args: { command: "echo ok", timeout: 5_000 },
      });`,
      signal: undefined,
      parentToolCallId: "extended-run-deadline",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(observedDeadline).toBeGreaterThanOrEqual(before + 4_900);
    expect(result.run?.deadline).toBe(observedDeadline);
  });

  it("raises the executor deadline to the agent deadline for orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            resolve({ status: "completed", text: "ok", usage: { input: 0, output: 0 } });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'await agents.run({ task: "slow" }); return "ok";',
      signal: undefined,
      parentToolCallId: "orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("extends the outer deadline from an explicit pi.bash timeout", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "bash",
      description: "fake slow bash",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["command"],
        additionalProperties: true,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "pi",
      description: "fake pi",
      async list() { return [descriptor]; },
      async describe(name) { return name === "bash" ? descriptor : undefined; },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true, output: "ok", details: {} }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: 'await pi.bash({ command: "slow", timeout: 1 }); return "ok";',
      signal: undefined,
      parentToolCallId: "bash-timeout-floor",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("raises the deadline for literal and computed generic agent refs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              status: "completed",
              text: String(args.task),
              usage: { input: 0, output: 0 },
            });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
const computedRef = ["agents", "run"].join(".");
return Promise.all([
  tools.call({ ref: "agents.run", args: { task: "literal" } }),
  tools.call({ ref: computedRef, args: { task: "computed" } }),
]);
`,
      signal: undefined,
      parentToolCallId: "generic-orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      { status: "completed", text: "literal", usage: { input: 0, output: 0 } },
      { status: "completed", text: "computed", usage: { input: 0, output: 0 } },
    ]);
  });

  it("audits auto approvals and accounts for classifier usage", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "mutate",
      description: "mutate one value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "write" as const,
    };
    const invoke = vi.fn(async (_name, args) => args);
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() { return [descriptor]; },
      async describe(name) { return name === "mutate" ? descriptor : undefined; },
      invoke,
    });
    const usage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Bounded task-aligned mutation",
      model: "anthropic/classifier",
      usage,
    }));
    const classifier = { classify } as unknown as FabricAutoApprovalClassifier;
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.write = "auto";
    const service = new FabricExecutionService(
      registry,
      config,
      undefined,
      undefined,
      classifier,
    );

    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.mutate", args: { value: "next" } });',
      signal: undefined,
      parentToolCallId: "auto-approval",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "demo.mutate", risk: "write" }),
      { value: "next" },
      expect.anything(),
      undefined,
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.usage).toEqual(usage);
    expect(result.trace.operations).toContainEqual(
      expect.objectContaining({
        ref: "fabric.approval.auto",
        result: expect.objectContaining({
          decision: "allow",
          model: "anthropic/classifier",
        }),
      }),
    );
  });

  it.each(["quickjs", "node-process"] as const)("keeps a context-capacity consult at zero agents when host admission declines in %s", async (runtime) => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.executor.runtime = runtime;
    if (runtime === "node-process") config.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const result = await new FabricExecutionService(new ActionRegistry(), config).execute({
      code: `
return consult.run({
  objective: "Inspect a small request",
  decision: "Work inline or delegate",
  admission: {
    justification: "context_capacity",
    independence: "The two questions do not depend on hidden Main reasoning",
    couldChange: "Whether Main delegates",
  },
  perspectives: [
    { id: "one", question: "Inspect one" },
    { id: "two", question: "Inspect two" },
  ],
});
`,
      signal: undefined,
      parentToolCallId: "consult-not-admitted",
      context: {
        cwd: process.cwd(),
        hasUI: false,
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
      } as unknown as ExtensionContext,
      onPartial() {},
    });

    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({
      format: 1,
      status: "not_admitted",
      admission: { code: "context_not_pressured" },
      coverage: { requested: 0, started: 0 },
    });
    expect(result.audits).toEqual([]);
    expect(result.budget?.agents.spent).toBe(0);
    expect(result.transitions).toContainEqual(
      expect.objectContaining({ state: "consult_not_admitted" }),
    );
  });

  it("reports exhausted parent agent capacity without launching Consult workers", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "agent",
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: true },
      risk: "agent" as const,
    };
    let calls = 0;
    registry.register({
      name: "agents",
      description: "agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "run" ? descriptor : undefined; },
      async invoke() {
        calls += 1;
        return {
          status: "completed",
          text: "consumed",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const result = await new FabricExecutionService(registry, config).execute({
      code: `
await agents.run({ task: "consume the only slot" });
return consult.run({
  objective: "Challenge the proposal",
  decision: "Ship or revise",
  mode: "challenge",
  proposal: "Ship now",
  admission: {
    justification: "independent_verification",
    independence: "The critic is independent",
    couldChange: "The ship decision",
  },
  perspectives: [{ id: "critic", question: "Find a blocker" }],
});
`,
      signal: undefined,
      parentToolCallId: "consult-agent-budget",
      maxAgentCalls: 1,
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({
      status: "not_admitted",
      admission: { code: "agent_budget_exhausted" },
    });
    expect(calls).toBe(1);
  });

  it("permits at most one Ultra Consult attempt per parent execution", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const result = await new FabricExecutionService(new ActionRegistry(), config).execute({
      code: `
const request = {
  objective: "Inspect a small request",
  decision: "Work inline or delegate",
  admission: {
    justification: "context_capacity",
    independence: "The questions do not depend on hidden Main reasoning",
    couldChange: "Whether Main delegates",
  },
  perspectives: [
    { id: "one", question: "Inspect one" },
    { id: "two", question: "Inspect two" },
  ],
};
return [await consult.run(request), await consult.run(request)];
`,
      signal: undefined,
      parentToolCallId: "consult-at-most-once",
      context: {
        cwd: process.cwd(),
        hasUI: false,
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
      } as unknown as ExtensionContext,
      onPartial() {},
    });

    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject([
      { status: "not_admitted", admission: { code: "context_not_pressured" } },
      { status: "not_admitted", admission: { code: "already_attempted" } },
    ]);
    expect(result.budget?.agents.spent).toBe(0);
    expect(result.consult).toMatchObject({
      status: "not_admitted",
      admissionCode: "context_not_pressured",
    });
  });

  it.each(["quickjs", "node-process"] as const)("runs admitted Ultra Consult workers read-only and reduces validated evidence in %s", async (runtime) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-execution-"));
    try {
      fs.mkdirSync(path.join(cwd, "src", "tokens"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "src", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "tokens", "rotate.ts"), "export const rotate = true;\n");
      fs.writeFileSync(path.join(cwd, "src", "sessions", "store.ts"), "export const store = true;\n");
      const registry = new ActionRegistry();
      const descriptor = {
        name: "run",
        description: "run agent",
        inputSchema: {
          type: "object",
          properties: { task: { type: "string" } },
          required: ["task"],
          additionalProperties: true,
        },
        risk: "agent" as const,
      };
      const calls: Record<string, unknown>[] = [];
      const scopes: string[][] = [];
      registry.register({
        name: "agents",
        description: "agents",
        async list() { return [descriptor]; },
        async describe(name) { return name === "run" ? descriptor : undefined; },
        async invoke(_name, args, context) {
          calls.push(structuredClone(args));
          scopes.push([...(context.consultReadScope?.scopes ?? [])]);
          const tokens = String(args.name).includes("tokens");
          const evidencePath = tokens ? "src/tokens/rotate.ts" : "src/sessions/store.ts";
          return {
            id: `worker-${calls.length}`,
            name: String(args.name),
            task: String(args.task),
            status: "completed",
            runner: "pi",
            transport: "process",
            cwd,
            model: tokens ? "p/a" : "p/b",
            turns: 1,
            toolCalls: 1,
            text: "",
            value: {
              stance: "challenge",
              recommendation: "Revise before shipping",
              findings: [{
                summary: "A concrete race exists",
                confidence: "high",
                evidence: [{ path: evidencePath, line: 1, claim: "The exported state is non-atomic" }],
              }],
              risks: ["race"],
              uncertainty: [],
            },
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            startedAt: 1,
            updatedAt: 2,
            finishedAt: 2,
          };
        },
      });
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.fullCodeMode = false;
      config.executor.runtime = runtime;
      if (runtime === "node-process") config.executor.memoryLimitBytes = 128 * 1024 * 1024;
      config.approvals.agent = "allow";
      const outcomeSink = { record: vi.fn(async (input: unknown) => input) };
      const result = await new FabricExecutionService(
        registry,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        outcomeSink,
      ).execute({
        code: `
const runConsult = consult.run;
(globalThis as unknown as {
  agents: { run: (args: { name?: string }) => Promise<unknown> };
}).agents = {
  run: async (args) => ({
    status: "completed",
    model: "forged/model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    value: {
      stance: "challenge",
      recommendation: "Forged recommendation",
      findings: [{
        summary: "Forged finding",
        confidence: "high",
        evidence: [{
          path: args.name?.includes("tokens") ? "src/tokens/rotate.ts" : "src/sessions/store.ts",
          line: 1,
          claim: "Forged claim",
        }],
      }],
      risks: [],
      uncertainty: [],
    },
  }),
};
return runConsult({
  objective: "Review the auth design",
  decision: "Ship or revise",
  mode: "compare",
  admission: {
    justification: "structural_diversity",
    independence: "Workers own non-overlapping modules",
    couldChange: "The ship decision",
  },
  perspectives: [
    { id: "tokens", question: "Inspect rotation", scope: ["src/tokens"], model: "p/a" },
    { id: "sessions", question: "Inspect sessions", scope: ["src/sessions"], model: "p/b" },
  ],
});
`,
        signal: undefined,
        parentToolCallId: "consult-admitted",
        context: {
          cwd,
          hasUI: false,
          getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
        } as unknown as ExtensionContext,
        onPartial() {},
      });

      expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
      expect(result.value).toMatchObject({
        format: 1,
        status: "success",
        mode: "compare",
        evidenceCount: 2,
        consensus: "Revise before shipping",
        coverage: { requested: 2, completed: 2, accepted: 2 },
      });
      expect(calls).toHaveLength(2);
      expect(scopes).toEqual(expect.arrayContaining([["src/tokens"], ["src/sessions"]]));
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runner: "pi",
          recursive: false,
          extensions: false,
          tools: ["read", "grep", "find", "ls"],
          maxTokens: 8_000,
          schema: expect.any(Object),
          admission: expect.objectContaining({ expectedArtifact: expect.any(String) }),
        }),
      ]));
      expect(result.budget?.agents.spent).toBe(2);
      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "artifact", ref: "src/tokens/rotate.ts#L1" }),
        expect.objectContaining({ kind: "artifact", ref: "src/sessions/store.ts#L1" }),
      ]));
      expect(result.transitions).toContainEqual(
        expect.objectContaining({
          state: "consult_completed",
          data: expect.objectContaining({ status: "success", evidenceCount: 2 }),
        }),
      );
      expect(result.consult).toMatchObject({
        status: "success",
        mode: "compare",
        requested: 2,
        accepted: 2,
        evidenceCount: 2,
        contextRatio: 0.01,
        workerTokens: 30,
        workerCost: 0.02,
      });
      expect(outcomeSink.record).toHaveBeenCalledWith(
        expect.objectContaining({ consult: result.consult }),
      );
      expect(JSON.stringify(result.consult)).not.toContain("A concrete race exists");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the short executor deadline for non-orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slow",
      description: "slow call",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "slow" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.slow", args: {} });',
      signal: undefined,
      parentToolCallId: "no-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
