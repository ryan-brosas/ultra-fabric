import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActionRegistry } from "../src/core/action-registry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { WorkflowsProvider } from "../src/providers/workflows-provider.js";
import { DurableWorkflowStore } from "../src/workflows/durable.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-workflow-exec-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 100);
  const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
  const registry = new ActionRegistry();
  registry.register(new WorkflowsProvider(new DurableWorkflowStore(mesh, identity)));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.write = "allow";
  return new FabricExecutionService(registry, config);
};

const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

describe("durable workflow guest adapter", () => {
  it("runs and reopens a durable guest workflow without replaying completion", async () => {
    const service = setup();
    const first = await service.execute({
      code: `return workflow.durable.run({
        id: "guest-release",
        name: "Guest release",
        phases: [
          { id: "a", run: async () => ({ artifact: "a.json" }) },
          { id: "b", deps: ["a"], run: async ({ phase }) => phase.id },
        ],
      });`,
      signal: undefined,
      parentToolCallId: "durable-first",
      context,
      onPartial() {},
    });
    expect({ error: first.error, typeErrors: first.typeErrors }).toEqual({
      error: undefined,
      typeErrors: undefined,
    });
    expect(first).toMatchObject({
      success: true,
      value: {
        workflow: { id: "guest-release", status: "completed" },
        results: { a: { artifact: "a.json" }, b: "b" },
      },
    });

    const replay = await service.execute({
      code: `return workflow.durable.run({
        id: "guest-release",
        name: "Guest release",
        phases: [
          { id: "a", run: async () => { throw new Error("replayed a"); } },
          { id: "b", deps: ["a"], run: async () => { throw new Error("replayed b"); } },
        ],
      });`,
      signal: undefined,
      parentToolCallId: "durable-replay",
      context,
      onPartial() {},
    });
    expect(replay).toMatchObject({
      success: true,
      value: {
        workflow: { id: "guest-release", status: "completed" },
        results: {},
      },
    });
  });

  it("retries within phase bounds and returns explicit partial coverage", async () => {
    const service = setup();
    const result = await service.execute({
      code: `
let attempts = 0;
return workflow.durable.run({
  id: "guest-partial",
  name: "Guest partial",
  phases: [
    { id: "a", run: async () => "a" },
    {
      id: "b",
      deps: ["a"],
      maxAttempts: 2,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return "b";
      },
    },
    {
      id: "c",
      deps: ["b"],
      retryable: false,
      run: async () => { throw new Error("permanent"); },
    },
  ],
});`,
      signal: undefined,
      parentToolCallId: "durable-partial",
      context,
      onPartial() {},
    });

    expect(result).toMatchObject({
      success: true,
      value: {
        workflow: {
          status: "partial",
          phases: [
            { id: "a", status: "completed", attempt: 1 },
            { id: "b", status: "completed", attempt: 2 },
            { id: "c", status: "failed", attempt: 1, error: "permanent" },
          ],
        },
        results: { a: "a", b: "b" },
      },
    });
  });
});
