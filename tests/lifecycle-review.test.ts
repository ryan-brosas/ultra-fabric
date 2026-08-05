import { describe, expect, it } from "vitest";
import { isReviewOutput, reviewGateDecision, type ReviewFinding, type ReviewOutput } from "../src/lifecycle/review.js";

describe("isReviewOutput", () => {
  it("accepts a well-formed review output and rejects malformed", () => {
    const valid: ReviewOutput = { verdict: "pass", findings: [] };
    expect(isReviewOutput(valid)).toBe(true);
    expect(isReviewOutput({ verdict: "bad" })).toBe(false);
    const finding: ReviewFinding = { severity: "high", claim: "issue" };
    expect(isReviewOutput({ verdict: "pass", findings: [finding] })).toBe(true);
  });
});

describe("reviewGateDecision", () => {
  const cases: Array<{ name: string; input: unknown; passed: boolean }> = [
    { name: "pass verdict with no blockers", input: { verdict: "pass", findings: [] }, passed: true },
    { name: "pass verdict with low finding", input: { verdict: "pass", findings: [{ severity: "low", claim: "style" }] }, passed: true },
    { name: "revise verdict", input: { verdict: "revise", findings: [{ severity: "high", claim: "missing guard" }] }, passed: false },
    { name: "abort verdict", input: { verdict: "abort", findings: [] }, passed: false },
    { name: "pass verdict but blocker finding", input: { verdict: "pass", findings: [{ severity: "blocker", claim: "null deref" }] }, passed: false },
    { name: "undefined input", input: undefined, passed: false },
    { name: "malformed object", input: { wrong: true }, passed: false },
    { name: "findings not array", input: { verdict: "pass", findings: "not array" }, passed: false },
  ];

  for (const { name, input, passed } of cases) {
    it(`fails closed for ${name}`, () => {
      expect(reviewGateDecision(input).passed).toBe(passed);
    });
  }
});