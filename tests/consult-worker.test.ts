import { describe, expect, it } from "vitest";
import { admitConsult } from "../src/consult/policy.js";
import {
  consultWorkerFailureStatus,
  createConsultWorkerRequest,
  projectConsultWorkerResult,
} from "../src/consult/worker.js";

const admission = admitConsult({
  objective: "Challenge a release",
  decision: "Ship or revise",
  mode: "challenge",
  proposal: "Ship now",
  admission: {
    justification: "independent_verification",
    independence: "The critic has fresh context",
    couldChange: "The ship decision",
  },
  perspectives: [{ id: "critic", question: "Find a blocker", scope: ["src/auth"], model: "p/reviewer" }],
}, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
  enabled: true,
  maxWorkers: 3,
  contextPressureThreshold: 0.6,
});

if (admission.kind !== "admitted") throw new Error("fixture was not admitted");

describe("Ultra Consult worker boundary", () => {
  it("builds a fixed read-only depth-one request", () => {
    expect(createConsultWorkerRequest(admission, admission.request.perspectives[0]!, {
      maxTokensPerWorker: 4_000,
      maxFindingsPerWorker: 4,
      maxEvidencePerFinding: 2,
    })).toMatchObject({
      name: "consult-critic",
      runner: "pi",
      model: "p/reviewer",
      tools: ["read", "grep", "find", "ls"],
      recursive: false,
      extensions: false,
      maxTokens: 4_000,
      admission: { reason: "independent_verification" },
      schema: { properties: { findings: { maxItems: 4 } } },
    });
  });

  it("projects only actual worker identity and bounded usage", () => {
    const projected = projectConsultWorkerResult("critic", {
      status: "completed",
      value: { stance: "silent" },
      usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
    });
    expect(projected).toEqual({
      perspectiveId: "critic",
      status: "completed",
      value: { stance: "silent" },
      usage: { tokens: 6, cost: 0.01 },
    });
    expect(projected).not.toHaveProperty("model");
  });

  it("preserves controlled budget, timeout, and cancellation failures", () => {
    expect(consultWorkerFailureStatus(new Error("Fabric token budget exhausted")))
      .toBe("budget_exhausted");
    expect(consultWorkerFailureStatus(new Error("worker timed out"))).toBe("timed_out");
    expect(consultWorkerFailureStatus(new Error("request aborted"))).toBe("stopped");
    expect(consultWorkerFailureStatus(new Error("provider failed"))).toBe("failed");
  });
});
