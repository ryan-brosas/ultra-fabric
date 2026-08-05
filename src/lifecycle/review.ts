export interface ReviewFinding {
  severity: "blocker" | "high" | "medium" | "low";
  path?: string;
  line?: number;
  claim: string;
}

export interface ReviewOutput {
  verdict: "pass" | "revise" | "abort";
  summary?: string;
  findings: ReviewFinding[];
}

export const isReviewOutput = (value: unknown): value is ReviewOutput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.verdict !== "pass" && record.verdict !== "revise" && record.verdict !== "abort") {
    return false;
  }
  if (!Array.isArray(record.findings)) return false;
  return record.findings.every((finding: unknown) => {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return false;
    const f = finding as Record<string, unknown>;
    return (
      (f.severity === "blocker" || f.severity === "high" ||
        f.severity === "medium" || f.severity === "low") &&
      typeof f.claim === "string" && Boolean(f.claim)
    );
  });
};

export type ReviewGateDecision =
  | { passed: true; summary?: string }
  | { passed: false; reason: string; summary?: string; findings: ReviewFinding[] };

export const reviewGateDecision = (value: unknown): ReviewGateDecision => {
  if (!isReviewOutput(value)) {
    return { passed: false, reason: "Reviewer returned malformed or missing output", findings: [] };
  }
  const summary = value.summary;
  if (value.verdict === "abort") {
    return { passed: false, reason: "Reviewer verdict: abort", ...(summary ? { summary } : {}), findings: value.findings };
  }
  if (value.verdict === "revise") {
    return { passed: false, reason: "Reviewer verdict: revise", ...(summary ? { summary } : {}), findings: value.findings };
  }
  if (value.findings.some((finding) => finding.severity === "blocker")) {
    return { passed: false, reason: "Reviewer found a blocker", ...(summary ? { summary } : {}), findings: value.findings };
  }
  return { passed: true, ...(summary ? { summary } : {}) };
};