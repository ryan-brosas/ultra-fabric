import { describe, expect, it } from "vitest";
import { admitConsult, type ConsultContextSnapshot, type ConsultPolicyLimits } from "../src/consult/policy.js";

const limits: ConsultPolicyLimits = {
  enabled: true,
  maxWorkers: 3,
  contextPressureThreshold: 0.6,
};
const lowContext: ConsultContextSnapshot = {
  tokens: 20_000,
  contextWindow: 200_000,
  ratio: 0.1,
};
const highContext: ConsultContextSnapshot = {
  tokens: 150_000,
  contextWindow: 200_000,
  ratio: 0.75,
};
const base = {
  objective: "Review the authentication boundary",
  decision: "Whether the refresh-token design is safe to ship",
  admission: {
    justification: "context_capacity",
    independence: "Each worker owns a separate module and needs no hidden Main reasoning",
    couldChange: "The selected implementation boundary",
  },
};

describe("Ultra Consult admission", () => {
  it("admits low-pressure context-capacity work when bounded scopes are independently partitioned", () => {
    const decision = admitConsult({
      ...base,
      mode: "auto",
      perspectives: [
        { id: "tokens", question: "Inspect token rotation", scope: ["src/auth/tokens"] },
        { id: "sessions", question: "Inspect session invalidation", scope: ["src/auth/sessions"] },
      ],
    }, lowContext, limits);

    expect(decision).toMatchObject({
      kind: "admitted",
      mode: "partition",
      request: {
        perspectives: [
          { id: "tokens", scope: ["src/auth/tokens"] },
          { id: "sessions", scope: ["src/auth/sessions"] },
        ],
      },
    });
  });

  it("admits an unscoped context-capacity partition only when host context is pressured", () => {
    const request = {
      ...base,
      perspectives: [
        { id: "one", question: "Inspect one half" },
        { id: "two", question: "Inspect the other half" },
      ],
    };
    expect(admitConsult(request, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "context_not_pressured",
    });
    expect(admitConsult(request, highContext, limits)).toMatchObject({
      kind: "admitted",
      mode: "partition",
    });
  });

  it("rejects missing admission intent without launching workers", () => {
    expect(admitConsult({
      objective: base.objective,
      decision: base.decision,
      perspectives: [{ id: "one", question: "Inspect" }],
    }, highContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "invalid_request",
    });
  });

  it("rejects overlapping partition ownership", () => {
    expect(admitConsult({
      ...base,
      perspectives: [
        { id: "auth", question: "Inspect auth", scope: ["src/auth"] },
        { id: "tokens", question: "Inspect tokens", scope: ["src/auth/tokens.ts"] },
      ],
    }, highContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "overlapping_scope",
    });
  });

  it("requires challenge mode to have one perspective and a concrete proposal", () => {
    const challenge = {
      ...base,
      mode: "challenge",
      admission: {
        ...base.admission,
        justification: "independent_verification",
      },
      perspectives: [{ id: "skeptic", question: "Find a material flaw", scope: ["src/auth"] }],
    };
    expect(admitConsult(challenge, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "challenge_requires_proposal",
    });
    expect(admitConsult({ ...challenge, proposal: "Ship the token rotation design" }, lowContext, limits))
      .toMatchObject({ kind: "admitted", mode: "challenge" });
  });

  it("requires compare mode to have structural diversity rather than role labels", () => {
    const compare = {
      ...base,
      mode: "compare",
      admission: {
        ...base.admission,
        justification: "structural_diversity",
      },
      perspectives: [
        { id: "a", question: "Review the decision", scope: ["src/auth"] },
        { id: "b", question: "Review the decision", scope: ["src/auth"] },
      ],
    };
    expect(admitConsult(compare, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "insufficient_diversity",
    });
    expect(admitConsult({
      ...compare,
      perspectives: [
        { id: "unscoped-a", question: "Review everything" },
        { id: "unscoped-b", question: "Review everything again" },
      ],
    }, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "insufficient_diversity",
    });
    expect(admitConsult({
      ...compare,
      perspectives: [
        { ...compare.perspectives[0], model: "security" },
        { ...compare.perspectives[1], model: "correctness" },
      ],
    }, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "invalid_request",
    });
    expect(admitConsult({
      ...compare,
      perspectives: [
        { ...compare.perspectives[0], model: "provider/model-a" },
        { ...compare.perspectives[1], model: "provider/model-b" },
      ],
    }, lowContext, limits)).toMatchObject({ kind: "admitted", mode: "compare" });
    expect(admitConsult({
      ...compare,
      perspectives: [
        { id: "first", question: "Inspect one", scope: ["src"], model: "provider/model-a" },
        { id: "second", question: "Inspect two", scope: ["src"], model: "provider/model-a" },
        { id: "third", question: "Inspect three", scope: ["src"], model: "provider/model-b" },
      ],
    }, lowContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "insufficient_diversity",
    });
  });

  it("enforces the host worker ceiling", () => {
    expect(admitConsult({
      ...base,
      perspectives: [
        { id: "a", question: "A", scope: ["a"] },
        { id: "b", question: "B", scope: ["b"] },
        { id: "c", question: "C", scope: ["c"] },
        { id: "d", question: "D", scope: ["d"] },
      ],
    }, highContext, limits)).toMatchObject({
      kind: "not_admitted",
      code: "worker_limit",
    });
  });
});
