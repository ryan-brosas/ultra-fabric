import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { FabricOutcomeStore, evaluateDeterministic } from "../src/outcomes/store.js";

const roots: string[] = [];
const setup = (minimum = 3) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-outcomes-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 100);
  const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
  let now = 1_000;
  const store = new FabricOutcomeStore(mesh, identity, {
    maxRecords: 20,
    minRecommendationSamples: minimum,
    now: () => now,
  } as never);
  return { store, mesh, setNow: (value: number) => { now = value; } };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FabricOutcomeStore", () => {
  it("records bounded run metrics idempotently without raw output", async () => {
    const { store, mesh } = setup();
    const input = {
      runId: "run-1",
      traceId: "trace-1",
      objectiveDigest: "digest",
      outcome: "succeeded" as const,
      startedAt: 100,
      finishedAt: 250,
      durationMs: 150,
      tokens: 42,
      cost: 0.12,
      gateVerdict: "passed" as const,
      evidenceCount: 2,
      routes: [{
        requestedModel: "p/frontier",
        selectedModel: "p/fallback",
        reason: "primary_unauthenticated",
        quality: "downgraded" as const,
      }],
      consult: {
        status: "success" as const,
        mode: "compare" as const,
        requested: 2,
        started: 2,
        completed: 2,
        accepted: 2,
        failed: 0,
        rejected: 0,
        evidenceCount: 2,
        contextRatio: 0.5,
        workerTokens: 1_200,
        workerCost: 0.04,
      },
    };
    const first = await store.record(input);
    const repeated = await store.record(input);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      format: 1,
      runId: "run-1",
      durationMs: 150,
      tokens: 42,
      cost: 0.12,
      verified: true,
      downgraded: true,
      consult: {
        status: "success",
        mode: "compare",
        requested: 2,
        accepted: 2,
        evidenceCount: 2,
        contextRatio: 0.5,
        workerTokens: 1_200,
        workerCost: 0.04,
      },
    });
    expect(JSON.stringify(first)).not.toContain("raw output");
    await expect(store.list()).resolves.toHaveLength(1);
    expect(mesh.read({ topic: "fabric.outcome" })).toMatchObject([
      { kind: "recorded", data: { id: first.id, outcome: "succeeded", verified: true } },
    ]);
  });

  it("rejects malformed shared outcome records", async () => {
    const { store, mesh } = setup();
    const outcome = await store.record({
      runId: "malformed-run", traceId: "trace", objectiveDigest: "digest",
      outcome: "succeeded", startedAt: 1, finishedAt: 2, durationMs: 1,
      tokens: 1, cost: 0, gateVerdict: "none", evidenceCount: 0, routes: [],
    });
    const entry = mesh.get(`outcomes/${outcome.id}`)!;
    await mesh.put({
      key: entry.key,
      value: { format: 1, id: outcome.id, runId: outcome.runId },
      identity: { id: "other", name: "Other", kind: "main" },
      ifVersion: entry.version,
    });

    await expect(store.status(outcome.id)).rejects.toThrow("Unknown Fabric outcome");
  });

  it("withholds route recommendations until the minimum sample count", async () => {
    const { store, setNow } = setup(3);
    const record = async (
      runId: string,
      model: string,
      success: boolean,
      durationMs: number,
      cost: number,
    ) => store.record({
      runId,
      traceId: `trace-${runId}`,
      objectiveDigest: `digest-${runId}`,
      outcome: success ? "succeeded" : "failed",
      startedAt: 1,
      finishedAt: 1 + durationMs,
      durationMs,
      tokens: 100,
      cost,
      gateVerdict: success ? "passed" : "abort",
      evidenceCount: success ? 1 : 0,
      routes: [{
        requestedModel: model,
        selectedModel: model,
        reason: "primary",
        quality: "preserved",
      }],
    });
    await record("a1", "p/a", true, 100, 0.1);
    await record("a2", "p/a", true, 120, 0.1);
    expect(await store.recommend()).toMatchObject({
      status: "insufficient_samples",
      minimumSamples: 3,
    });
    setNow(2_000);
    await record("a3", "p/a", true, 110, 0.1);
    await record("b1", "p/b", false, 50, 0.01);
    await record("b2", "p/b", true, 60, 0.01);
    expect(await store.recommend()).toMatchObject({
      status: "recommended",
      recommendedModel: "p/a",
      candidates: [{
        model: "p/a",
        samples: 3,
        successRate: 1,
        verifiedRate: 1,
        averageDurationMs: 110,
        averageCost: expect.closeTo(0.1),
      }],
      excluded: [{ model: "p/b", samples: 2, reason: "insufficient_samples" }],
    });
  });

  it("scores deterministic fixtures and appends optional model-judge verdicts", async () => {
    expect(evaluateDeterministic({ scorer: "exact", actual: { b: 2, a: 1 }, expected: { a: 1, b: 2 } }))
      .toMatchObject({ score: 1, passed: true });
    expect(evaluateDeterministic({ scorer: "contains", actual: "all tests passed", expected: "tests passed" }))
      .toMatchObject({ score: 1, passed: true });
    expect(evaluateDeterministic({ scorer: "numeric", actual: 10.2, expected: 10, tolerance: 0.25 }))
      .toMatchObject({ score: 1, passed: true });

    const { store } = setup();
    const outcome = await store.record({
      runId: "eval-run", traceId: "trace", objectiveDigest: "digest",
      outcome: "succeeded", startedAt: 1, finishedAt: 2, durationMs: 1,
      tokens: 1, cost: 0, gateVerdict: "none", evidenceCount: 0, routes: [],
    });
    await store.evaluate(outcome.id, {
      kind: "deterministic",
      scorer: "exact",
      score: 1,
      passed: true,
    });
    await store.evaluate(outcome.id, {
      kind: "model_judge",
      scorer: "quality",
      evaluator: "p/judge",
      score: 0.8,
      passed: true,
    });
    expect(await store.status(outcome.id)).toMatchObject({
      evaluations: [
        { kind: "deterministic", scorer: "exact", score: 1, passed: true },
        { kind: "model_judge", scorer: "quality", evaluator: "p/judge", score: 0.8, passed: true },
      ],
    });
  });
});
