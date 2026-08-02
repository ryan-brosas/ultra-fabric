import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActionRegistry } from "../src/core/action-registry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { FabricOutcomeStore } from "../src/outcomes/store.js";
import { OutcomesProvider } from "../src/providers/outcomes-provider.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../src/protocol.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const action: FabricActionDescriptor = {
  name: "run",
  description: "fixture routed run",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "agent",
};
class RoutedProvider implements FabricProvider {
  name = "fixture";
  description = "fixture";
  async list(_request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> { return [action]; }
  async describe(name: string): Promise<FabricActionDescriptor | undefined> {
    return name === "run" ? action : undefined;
  }
  async invoke(_name: string, _args: Record<string, unknown>, _context: FabricInvocationContext) {
    return {
      status: "completed",
      route: {
        version: 1,
        requestedModel: "p/frontier",
        selectedModel: "p/fallback",
        reason: "primary_unauthenticated",
        quality: "downgraded",
        downgradeReasons: ["smaller_context"],
        requirements: {},
        considered: [],
      },
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0.25 },
    };
  }
}

describe("execution outcome integration", () => {
  it("persists terminal metrics, route downgrade, and verification verdict", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-outcome-exec-"));
    roots.push(root);
    const mesh = new MeshStore(root, 64 * 1024, 100);
    const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
    const outcomes = new FabricOutcomeStore(mesh, identity);
    const registry = new ActionRegistry();
    registry.register(new RoutedProvider());
    registry.register(new OutcomesProvider(outcomes));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(
      registry,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      outcomes,
    );
    const result = await service.execute({
      code: `
await tools.call({ ref: "fixture.run", args: {} });
await tools.call({ ref: "fixture.run", args: {} });
await workflow.gate({
  gate: "acceptance",
  passed: true,
  disposition: "abort",
  evidence: [{ kind: "command", ref: "pnpm test" }],
});
return "done";`,
      signal: undefined,
      parentToolCallId: "outcome-run",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    await expect(outcomes.list()).resolves.toMatchObject([{
      runId: "outcome-run",
      outcome: "succeeded",
      gateVerdict: "passed",
      verified: true,
      evidenceCount: 1,
      tokens: 34,
      cost: 0.5,
      downgraded: true,
      routes: [{ selectedModel: "p/fallback", quality: "downgraded" }],
    }]);

    const queried = await service.execute({
      code: `return outcomes.list({ limit: 1 });`,
      signal: undefined,
      parentToolCallId: "outcome-query",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    expect(queried).toMatchObject({
      success: true,
      value: [{ runId: "outcome-run", verified: true }],
    });
  });
});
