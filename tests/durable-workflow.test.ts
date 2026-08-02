import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DurableWorkflowStore } from "../src/workflows/durable.js";

const roots: string[] = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-workflow-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 100);
  const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
  let now = 100;
  let sequence = 0;
  const workflows = new DurableWorkflowStore(mesh, identity, {
    now: () => now,
    nextId: () => `lease-${++sequence}`,
  });
  return { workflows, setNow: (value: number) => { now = value; } };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DurableWorkflowStore", () => {
  it("unblocks a durable diamond without replaying completed phases", async () => {
    const { workflows } = setup();
    const created = await workflows.create({
      id: "release",
      name: "Release",
      leaseMs: 1_000,
      phases: [
        { id: "a" },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["a"] },
        { id: "d", deps: ["b", "c"] },
      ],
    });
    expect(created).toMatchObject({
      id: "release",
      status: "queued",
      phases: [
        { id: "a", status: "ready" },
        { id: "b", status: "pending" },
        { id: "c", status: "pending" },
        { id: "d", status: "pending" },
      ],
    });

    const a = await workflows.claim("release", {
      ownerRunId: "run-1",
      ownerTraceId: "trace-1",
      ownerSpanId: "span-1",
    });
    expect(a).toMatchObject({
      phase: {
        id: "a",
        status: "running",
        attempt: 1,
        ownerRunId: "run-1",
        ownerTraceId: "trace-1",
        ownerSpanId: "span-1",
      },
    });
    await workflows.complete("release", {
      phaseId: "a",
      leaseToken: a!.leaseToken,
      evidence: [{ kind: "command", ref: "test:a" }],
      output: { artifact: "a.json" },
    });
    expect(await workflows.status("release")).toMatchObject({
      phases: [
        { id: "a", status: "completed", outputDigest: expect.any(String) },
        { id: "b", status: "ready" },
        { id: "c", status: "ready" },
        { id: "d", status: "pending" },
      ],
    });

    const b = await workflows.claim("release", { ownerRunId: "run-1" });
    const c = await workflows.claim("release", { ownerRunId: "run-2" });
    expect([b?.phase.id, c?.phase.id]).toEqual(["b", "c"]);
    await workflows.complete("release", { phaseId: "b", leaseToken: b!.leaseToken });
    await workflows.complete("release", { phaseId: "c", leaseToken: c!.leaseToken });
    const d = await workflows.claim("release", { ownerRunId: "run-3" });
    await workflows.complete("release", { phaseId: "d", leaseToken: d!.leaseToken });

    expect(await workflows.status("release")).toMatchObject({
      status: "completed",
      phases: [
        { id: "a", status: "completed", attempt: 1 },
        { id: "b", status: "completed", attempt: 1 },
        { id: "c", status: "completed", attempt: 1 },
        { id: "d", status: "completed", attempt: 1 },
      ],
    });
    await expect(workflows.create({
      id: "release",
      name: "Release",
      leaseMs: 1_000,
      phases: [{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b", "c"] }],
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("reclaims expired leases and rejects stale owners", async () => {
    const { workflows, setNow } = setup();
    await workflows.create({
      id: "resume",
      name: "Resume",
      leaseMs: 1_000,
      phases: [{ id: "work", maxAttempts: 2 }],
    });
    const first = await workflows.claim("resume", { ownerRunId: "run-1" });
    setNow(1_200);
    const resume = (workflows as unknown as {
      resume(id: string): Promise<unknown>;
    }).resume.bind(workflows);
    await expect(resume("resume")).resolves.toMatchObject({
      status: "queued",
      phases: [{ id: "work", status: "ready", attempt: 1 }],
    });
    const second = await workflows.claim("resume", { ownerRunId: "run-2" });
    expect(second).toMatchObject({ phase: { id: "work", attempt: 2 } });
    await expect(workflows.complete("resume", {
      phaseId: "work",
      leaseToken: first!.leaseToken,
    })).rejects.toThrow("Stale durable workflow phase completion");
    await workflows.complete("resume", {
      phaseId: "work",
      leaseToken: second!.leaseToken,
    });
    expect(await workflows.status("resume")).toMatchObject({ status: "completed" });
  });

  it("reports partial failure and cancellation without replaying completed work", async () => {
    const { workflows } = setup();
    const api = workflows as unknown as {
      fail(id: string, input: {
        phaseId: string;
        leaseToken: string;
        error: string;
        retryable?: boolean;
      }): Promise<unknown>;
      cancel(id: string, reason?: string): Promise<unknown>;
    };
    await workflows.create({
      id: "partial",
      name: "Partial",
      phases: [{ id: "a" }, { id: "b", deps: ["a"] }],
    });
    const a = await workflows.claim("partial", { ownerRunId: "run-1" });
    await workflows.complete("partial", { phaseId: "a", leaseToken: a!.leaseToken });
    const b = await workflows.claim("partial", { ownerRunId: "run-1" });
    await api.fail("partial", {
      phaseId: "b",
      leaseToken: b!.leaseToken,
      error: "provider unavailable",
    });
    expect(await workflows.status("partial")).toMatchObject({
      status: "partial",
      phases: [
        { id: "a", status: "completed" },
        { id: "b", status: "failed", error: "provider unavailable" },
      ],
    });

    await workflows.create({
      id: "cancelled",
      name: "Cancelled",
      phases: [{ id: "a" }, { id: "b", deps: ["a"] }],
    });
    const running = await workflows.claim("cancelled", { ownerRunId: "run-2" });
    await api.cancel("cancelled", "user stopped");
    expect(await workflows.status("cancelled")).toMatchObject({
      status: "cancelled",
      cancelReason: "user stopped",
      phases: [
        { id: "a", status: "cancelled" },
        { id: "b", status: "cancelled" },
      ],
    });
    await expect(workflows.complete("cancelled", {
      phaseId: "a",
      leaseToken: running!.leaseToken,
    })).rejects.toThrow("Stale durable workflow phase completion");
  });
});
