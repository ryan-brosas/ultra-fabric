import { describe, expect, it } from "vitest";
import { admitConsult } from "../src/consult/policy.js";
import {
  reduceConsult,
  type ConsultEvidenceResolver,
  type ConsultWorkerInput,
} from "../src/consult/reducer.js";

const admission = admitConsult({
  objective: "Decide whether the auth design is safe",
  decision: "Ship or revise",
  mode: "compare",
  admission: {
    justification: "structural_diversity",
    independence: "Workers inspect separate modules",
    couldChange: "The ship decision",
  },
  perspectives: [
    { id: "tokens", question: "Inspect token rotation", scope: ["src/tokens"], model: "p/a" },
    { id: "sessions", question: "Inspect sessions", scope: ["src/sessions"], model: "p/b" },
  ],
}, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
  enabled: true,
  maxWorkers: 3,
  contextPressureThreshold: 0.6,
});

const limits = { maxFindingsPerWorker: 4, maxEvidencePerFinding: 4 };
const resolver: ConsultEvidenceResolver = (candidate, perspective) =>
  candidate.path.startsWith(perspective.scope[0] ?? "missing")
    ? { kind: "resolved", evidence: { ...candidate, ref: candidate.path + "#L" + (candidate.line ?? 1) } }
    : { kind: "rejected", reason: "outside_scope" };
const completed = (
  perspectiveId: string,
  recommendation: string,
  path: string,
  summary = "Concrete finding",
): ConsultWorkerInput => ({
  perspectiveId,
  status: "completed",
  value: {
    stance: "challenge",
    recommendation,
    findings: [{
      summary,
      confidence: "high",
      evidence: [{ path, line: 7, claim: summary }],
    }],
    risks: ["rotation race"],
    uncertainty: [],
  },
  usage: { tokens: 100, cost: 0.01 },
});

describe("Ultra Consult reduction", () => {
  it("returns only host-resolved evidence and exact consensus", async () => {
    const result = await reduceConsult(admission, [
      completed("tokens", "Revise before shipping", "src/tokens/rotate.ts"),
      completed("sessions", "Revise before shipping", "src/sessions/store.ts"),
    ], limits, resolver);

    expect(result).toMatchObject({
      format: 1,
      status: "success",
      mode: "compare",
      coverage: { requested: 2, started: 2, completed: 2, accepted: 2, failed: 0, rejected: 0 },
      evidenceCount: 2,
      consensus: "Revise before shipping",
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings?.[0]?.evidence[0]?.ref).toContain("#L7");
  });

  it("rejects unsupported findings instead of accepting citation-shaped prose", async () => {
    const result = await reduceConsult(admission, [
      completed("tokens", "Ship", "README.md", "Unsupported claim"),
      completed("sessions", "Ship", "docs/design.md", "Also unsupported"),
    ], limits, resolver);

    expect(result).toMatchObject({
      status: "inconclusive",
      coverage: { completed: 2, accepted: 0, rejected: 2 },
      evidenceCount: 0,
    });
    expect(result.findings).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it("preserves successful evidence and names missing coverage on partial failure", async () => {
    const result = await reduceConsult(admission, [
      completed("tokens", "Revise", "src/tokens/rotate.ts"),
      { perspectiveId: "sessions", status: "timed_out", error: "deadline" },
    ], limits, resolver);

    expect(result).toMatchObject({
      status: "partial",
      coverage: {
        requested: 2,
        started: 2,
        completed: 1,
        accepted: 1,
        failed: 1,
        missing: ["sessions"],
      },
      evidenceCount: 1,
    });
  });

  it("preserves compare disagreement without synthesizing a winner", async () => {
    const result = await reduceConsult(admission, [
      completed("tokens", "Revise", "src/tokens/rotate.ts"),
      completed("sessions", "Ship", "src/sessions/store.ts"),
    ], limits, resolver);

    expect(result).toMatchObject({ status: "success" });
    expect(result.consensus).toBeUndefined();
    expect(result.disagreements).toEqual([
      { perspectiveId: "tokens", recommendation: "Revise" },
      { perspectiveId: "sessions", recommendation: "Ship" },
    ]);
  });

  it("rejects overlapping perspectives when resolved Compare models collapse", async () => {
    const overlapping = admitConsult({
      objective: "Compare one module through two models",
      decision: "Ship or revise",
      mode: "compare",
      admission: {
        justification: "structural_diversity",
        independence: "Each model reviews independently",
        couldChange: "The ship decision",
      },
      perspectives: [
        { id: "one", question: "Inspect", scope: ["src"], model: "p/a" },
        { id: "two", question: "Inspect", scope: ["src"], model: "p/b" },
      ],
    }, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
      enabled: true,
      maxWorkers: 3,
      contextPressureThreshold: 0.6,
    });
    const result = await reduceConsult(overlapping, [
      { ...completed("one", "Ship", "src/a.ts"), model: "p/same" },
      { ...completed("two", "Ship", "src/b.ts"), model: "p/same" },
    ], limits, resolver);

    expect(result).toMatchObject({
      status: "inconclusive",
      coverage: { accepted: 0, rejected: 2 },
    });
    expect(result.consensus).toBeUndefined();
  });

  it("does not claim consensus from partial coverage", async () => {
    const three = admitConsult({
      objective: "Compare three modules",
      decision: "Ship or revise",
      mode: "compare",
      admission: {
        justification: "structural_diversity",
        independence: "Each module is independently reviewable",
        couldChange: "The ship decision",
      },
      perspectives: [
        { id: "one", question: "Inspect one", scope: ["src/one"] },
        { id: "two", question: "Inspect two", scope: ["src/two"] },
        { id: "three", question: "Inspect three", scope: ["src/three"] },
      ],
    }, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
      enabled: true,
      maxWorkers: 3,
      contextPressureThreshold: 0.6,
    });
    expect(three.kind).toBe("admitted");
    const result = await reduceConsult(three, [
      completed("one", "Revise", "src/one/a.ts"),
      completed("two", "Revise", "src/two/b.ts"),
      { perspectiveId: "three", status: "timed_out", error: "deadline" },
    ], limits, resolver);

    expect(result.status).toBe("partial");
    expect(result.consensus).toBeUndefined();
  });

  it("rejects a silent Challenge payload that still asserts risks", async () => {
    const challenge = admitConsult({
      objective: "Challenge a proposal",
      decision: "Ship or revise",
      mode: "challenge",
      proposal: "Ship now",
      admission: {
        justification: "independent_verification",
        independence: "The review is independent",
        couldChange: "The ship decision",
      },
      perspectives: [{ id: "critic", question: "Find blockers" }],
    }, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
      enabled: true,
      maxWorkers: 3,
      contextPressureThreshold: 0.6,
    });
    const result = await reduceConsult(challenge, [{
      perspectiveId: "critic",
      status: "completed",
      value: {
        stance: "silent",
        findings: [],
        risks: ["Unqualified risk"],
        uncertainty: [],
      },
    }], limits, resolver);

    expect(result).toMatchObject({ status: "inconclusive", coverage: { accepted: 0, rejected: 1 } });
  });

  it("treats a silent challenge as a successful no-issue result", async () => {
    const challenge = admitConsult({
      objective: "Challenge a migration",
      decision: "Proceed or stop",
      mode: "challenge",
      proposal: "Proceed with the migration",
      admission: {
        justification: "independent_verification",
        independence: "The skeptic uses only repository evidence",
        couldChange: "Whether migration proceeds",
      },
      perspectives: [{ id: "skeptic", question: "Find a material blocker", scope: ["src"] }],
    }, { tokens: 1, contextWindow: 100, ratio: 0.01 }, {
      enabled: true,
      maxWorkers: 3,
      contextPressureThreshold: 0.6,
    });
    const result = await reduceConsult(challenge, [{
      perspectiveId: "skeptic",
      status: "completed",
      value: { stance: "silent", findings: [], risks: [], uncertainty: [] },
    }], limits, resolver);

    expect(result).toMatchObject({
      status: "success",
      mode: "challenge",
      silent: true,
      coverage: { accepted: 1 },
    });
  });

  it("returns the original zero-agent admission decision without invoking evidence resolution", async () => {
    let calls = 0;
    const result = await reduceConsult({
      kind: "not_admitted",
      code: "disabled",
      message: "disabled",
      context: { tokens: 1, contextWindow: 100, ratio: 0.01 },
    }, [], limits, () => {
      calls++;
      return { kind: "rejected", reason: "unexpected" };
    });
    expect(result).toMatchObject({ status: "not_admitted", admission: { code: "disabled" } });
    expect(calls).toBe(0);
  });
});
