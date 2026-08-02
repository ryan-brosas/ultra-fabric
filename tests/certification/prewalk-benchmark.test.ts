import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error Benchmark helpers are dependency-free JavaScript used directly by Node.
import { parsePrewalkBenchmarkRun, summarizePrewalkBenchmark } from "../../scripts/certification/prewalk-benchmark-lib.mjs";

const run = (
  taskId: string,
  variant: "in-place" | "research",
  overrides: Record<string, unknown> = {},
) => ({
  taskId,
  repeat: 1,
  variant,
  acceptance: { completed: variant === "research" ? 3 : 2, total: 3 },
  unsupportedClaims: variant === "research" ? 0 : 1,
  missedConstraints: variant === "research" ? 0 : 1,
  contextTokensBeforeRequests: variant === "research" ? [90, 70] : [100, 95],
  parentContextTokens: variant === "research" ? 90 : 100,
  executorContextTokens: variant === "research" ? 70 : 95,
  inputTokens: variant === "research" ? 130 : 150,
  outputTokens: 20,
  cacheReadTokens: variant === "research" ? 30 : 25,
  cacheWriteTokens: 0,
  requestCount: 2,
  wallMs: variant === "research" ? 8 : 10,
  totalTokens: variant === "research" ? 80 : 100,
  costUsd: variant === "research" ? 0.08 : 0.1,
  ...(variant === "research"
    ? {
        protocol: {
          checklistItems: 5,
          firstMutationBoundary: true,
          planningInstructionPruned: true,
          executorVerified: true,
          planQualityScore: 0.8,
          planEvaluator: "rubric-v1",
        },
      }
    : {}),
  ...overrides,
});

const pairedRuns = (tasks: number) =>
  Array.from({ length: tasks }, (_, index) => {
    const taskId = `task-${String(index + 1).padStart(2, "0")}`;
    return [run(taskId, "in-place"), run(taskId, "research")];
  }).flat();

describe("Prewalk benchmark evidence contract", () => {
  it("rejects raw fields and invalid research protocol evidence", () => {
    expect(() => parsePrewalkBenchmarkRun({
      ...run("task-01", "research"),
      prompt: "must not persist",
    })).toThrow(/unknown field.*prompt/i);
    expect(() => parsePrewalkBenchmarkRun(run("task-01", "research", {
      protocol: {
        checklistItems: 4,
        firstMutationBoundary: true,
        planningInstructionPruned: true,
        executorVerified: true,
        planQualityScore: 0.8,
        planEvaluator: "rubric-v1",
      },
    }))).toThrow(/checklistItems/i);
    expect(() => parsePrewalkBenchmarkRun(run("task-01", "in-place", {
      protocol: { checklistItems: 5 },
    }))).toThrow(/in-place.*protocol/i);
    expect(() => summarizePrewalkBenchmark(
      Array.from({ length: 10_001 }, () => run("task-01", "in-place")),
    )).toThrow(/run limit.*10,000/i);
  });

  it("summarizes 20 representative paired tasks without declaring superiority", () => {
    const report = summarizePrewalkBenchmark(pairedRuns(20), {
      minimumTasks: 20,
      representativeTaskSet: true,
    });

    expect(report.status).toBe("comparison_ready");
    expect(report.coverage).toMatchObject({
      requiredTasks: 20,
      uniqueTasks: 20,
      completePairs: 20,
      missingPairs: [],
    });
    expect(report.variants.research).toMatchObject({
      fullAcceptanceRate: 1,
      unsupportedClaims: 0,
      missedConstraints: 0,
      averageRequestContextTokens: 80,
      averageRunContextTokens: 160,
      averagePeakRequestContextTokens: 90,
      averageParentContextTokens: 90,
      averageExecutorContextTokens: 70,
      averageInputTokens: 130,
      averageOutputTokens: 20,
      averageCacheReadTokens: 30,
      averageCacheWriteTokens: 0,
      averagePlanQualityScore: 0.8,
    });
    expect(report.protocol).toMatchObject({
      mechanicallyCompatible: true,
      firstMutationBoundaryRate: 1,
      planningInstructionPrunedRate: 1,
      executorVerifiedRate: 1,
    });
    expect(report.paired.fullAcceptance).toEqual({
      researchWins: 20,
      inPlaceWins: 0,
      ties: 0,
    });
    expect(report.limitations).toContain(
      "A comparison-ready report does not establish general superiority.",
    );
    expect(JSON.stringify(report)).not.toContain("prompt");
  });

  it("weights request context per run instead of by request count", () => {
    const report = summarizePrewalkBenchmark([
      run("task-a", "in-place", {
        contextTokensBeforeRequests: [10],
        parentContextTokens: 10,
        executorContextTokens: 0,
        requestCount: 1,
      }),
      run("task-b", "in-place", {
        contextTokensBeforeRequests: [100, 100, 100],
        parentContextTokens: 100,
        executorContextTokens: 200,
        requestCount: 3,
      }),
    ]);

    expect(report.variants["in-place"]).toMatchObject({
      averageRequestContextTokens: 55,
      averageRunContextTokens: 155,
      averagePeakRequestContextTokens: 55,
    });
  });

  it("withholds readiness for insufficient, incomplete, or unattested task sets", () => {
    expect(summarizePrewalkBenchmark(pairedRuns(19), {
      minimumTasks: 20,
      representativeTaskSet: true,
    }).status).toBe("insufficient_coverage");

    const incomplete = pairedRuns(20).filter(
      (item) => !(item.taskId === "task-20" && item.variant === "research"),
    );
    const incompleteReport = summarizePrewalkBenchmark(incomplete, {
      minimumTasks: 20,
      representativeTaskSet: true,
    });
    expect(incompleteReport.status).toBe("insufficient_coverage");
    expect(incompleteReport.coverage.missingPairs).toEqual([
      { taskId: "task-20", repeat: 1, missing: ["research"] },
    ]);

    expect(summarizePrewalkBenchmark(pairedRuns(20), {
      minimumTasks: 20,
      representativeTaskSet: false,
    }).status).toBe("unrepresentative_tasks");

    const mismatched = pairedRuns(20);
    const research = mismatched.find(
      (item) => item.taskId === "task-20" && item.variant === "research",
    )!;
    research.protocol!.firstMutationBoundary = false;
    const mismatchReport = summarizePrewalkBenchmark(mismatched, {
      minimumTasks: 20,
      representativeTaskSet: true,
    });
    expect(mismatchReport.status).toBe("protocol_mismatch");
    expect(mismatchReport.protocol.mechanicallyCompatible).toBe(false);
  });

  it("makes the benchmark command a safe default skip", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(manifest.scripts["benchmark:prewalk"]).toBe(
      "node scripts/benchmark-prewalk.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/benchmark-prewalk.mjs")],
      { encoding: "utf8", env: {}, timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Prewalk benchmark: SKIP");
    expect(result.stdout).toContain('"skipped": true');
  });

  it("analyzes a bounded result file and fails closed on invalid evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-benchmark-"));
    try {
      const valid = path.join(root, "valid.json");
      fs.writeFileSync(valid, JSON.stringify({
        representativeTaskSet: true,
        provenance: {
          collector: "ultra-prewalk-real-v1",
          manifestDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          frontier: { provider: "anthropic", model: "frontier-model" },
          executor: { provider: "anthropic", model: "executor-model" },
          piVersion: "0.83.0",
          fabricVersion: "0.31.1-ultra.0",
          seed: "seed",
          repeats: 1,
          observedCostUsd: 1.25,
          observedTokens: 3_600,
          generatedAt: "2026-08-01T00:00:00.000Z",
        },
        runs: pairedRuns(20),
      }), "utf8");
      const accepted = spawnSync(
        process.execPath,
        [path.resolve("scripts/benchmark-prewalk.mjs"), "--", valid],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain("comparison_ready");
      expect(accepted.stdout).toContain('"collector": "ultra-prewalk-real-v1"');
      expect(accepted.stdout).toContain('"model": "frontier-model"');

      const insufficient = path.join(root, "insufficient.json");
      fs.writeFileSync(insufficient, JSON.stringify({
        representativeTaskSet: true,
        runs: pairedRuns(19),
      }), "utf8");
      const notReady = spawnSync(
        process.execPath,
        [path.resolve("scripts/benchmark-prewalk.mjs"), insufficient],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(notReady.status).toBe(1);
      expect(notReady.stdout).toContain("insufficient_coverage");

      const oversized = path.join(root, "oversized.json");
      fs.closeSync(fs.openSync(oversized, "w"));
      fs.truncateSync(oversized, 8 * 1024 * 1024 + 1);
      const tooLarge = spawnSync(
        process.execPath,
        [path.resolve("scripts/benchmark-prewalk.mjs"), oversized],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(tooLarge.status).toBe(1);
      expect(tooLarge.stderr).toMatch(/exceeds.*8,388,608 bytes/i);

      const invalid = path.join(root, "invalid.json");
      fs.writeFileSync(invalid, JSON.stringify({
        representativeTaskSet: true,
        runs: [{ ...run("task-01", "research"), output: "raw model output" }],
      }), "utf8");
      const rejected = spawnSync(
        process.execPath,
        [path.resolve("scripts/benchmark-prewalk.mjs"), invalid],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toMatch(/unknown field.*output/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
