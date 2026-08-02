import type { ConsultAdmissionDecision, ConsultPerspective } from "./policy.js";
import type { ConsultWorkerInput } from "./reducer.js";

interface ConsultWorkerLimits {
  maxTokensPerWorker: number;
  maxFindingsPerWorker: number;
  maxEvidencePerFinding: number;
}

const workerSchema = (limits: ConsultWorkerLimits): Record<string, unknown> => ({
  type: "object",
  properties: {
    stance: { type: "string", enum: ["support", "challenge", "mixed", "silent"] },
    recommendation: { type: "string", maxLength: 2_048 },
    findings: {
      type: "array",
      maxItems: limits.maxFindingsPerWorker,
      items: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 2_048 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          evidence: {
            type: "array",
            maxItems: limits.maxEvidencePerFinding,
            items: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 1_024 },
                line: { type: "number", minimum: 1 },
                endLine: { type: "number", minimum: 1 },
                claim: { type: "string", minLength: 1, maxLength: 2_048 },
              },
              required: ["path", "claim"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "confidence", "evidence"],
        additionalProperties: false,
      },
    },
    risks: { type: "array", maxItems: 16, items: { type: "string", maxLength: 1_024 } },
    uncertainty: { type: "array", maxItems: 16, items: { type: "string", maxLength: 1_024 } },
  },
  required: ["stance", "findings", "risks", "uncertainty"],
  additionalProperties: false,
});

const workerTask = (
  admission: Extract<ConsultAdmissionDecision, { kind: "admitted" }>,
  perspective: ConsultPerspective,
): string => [
  "You are one fresh, read-only Ultra Consult worker.",
  `Mode: ${admission.mode}`,
  `Objective: ${admission.request.objective}`,
  `Decision this may change: ${admission.request.decision}`,
  admission.request.proposal ? `Proposal under challenge: ${admission.request.proposal}` : "",
  `Perspective ${perspective.id}: ${perspective.question}`,
  perspective.scope.length > 0
    ? `Allowed evidence scope: ${perspective.scope.join(", ")}`
    : "Allowed evidence scope: project root",
  "Use only read, grep, find, and ls. Do not edit, write, run shell commands, use the network, delegate, or recurse.",
  "Every non-silent finding needs an existing project-relative file path and optional exact line range.",
  admission.mode === "challenge"
    ? "If there is no material evidence-backed objection, return stance silent with empty findings, risks, uncertainty, and no recommendation."
    : "Return only findings that can change the named decision; do not manufacture agreement.",
].filter(Boolean).join("\n");

export const createConsultWorkerRequest = (
  admission: Extract<ConsultAdmissionDecision, { kind: "admitted" }>,
  perspective: ConsultPerspective,
  limits: ConsultWorkerLimits,
): Record<string, unknown> => {
  const admissionReason = admission.mode === "challenge"
    ? "independent_verification"
    : admission.mode === "partition"
      ? "separable_parallel"
      : "independent_context";
  return {
    task: workerTask(admission, perspective),
    name: `consult-${perspective.id}`,
    runner: "pi",
    ...(perspective.model ? { model: perspective.model } : {}),
    tools: ["read", "grep", "find", "ls"],
    recursive: false,
    extensions: false,
    maxTokens: limits.maxTokensPerWorker,
    schema: workerSchema(limits),
    admission: {
      reason: admissionReason,
      expectedArtifact: `Compact structured findings with host-resolvable file evidence for ${perspective.id}`,
    },
  };
};

export const consultWorkerFailureStatus = (error: unknown): ConsultWorkerInput["status"] => {
  const message = error instanceof Error ? error.message : String(error);
  if (/token budget|budget exhausted/i.test(message)) return "budget_exhausted";
  if (/timed?[_ -]?out|deadline/i.test(message)) return "timed_out";
  if (/abort|cancel|stopp?ed/i.test(message)) return "stopped";
  return "failed";
};

export const projectConsultWorkerResult = (
  perspectiveId: string,
  value: unknown,
): ConsultWorkerInput => {
  const result = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = result.status === "completed" || result.status === "failed" ||
    result.status === "stopped" || result.status === "timed_out" ||
    result.status === "budget_exhausted"
    ? result.status
    : "failed";
  const usage = typeof result.usage === "object" && result.usage !== null && !Array.isArray(result.usage)
    ? result.usage as Record<string, unknown>
    : undefined;
  const tokenPart = (part: unknown): number =>
    typeof part === "number" && Number.isFinite(part) ? Math.max(0, part) : 0;
  const tokens = usage
    ? tokenPart(usage.input) + tokenPart(usage.output) +
      tokenPart(usage.cacheRead) + tokenPart(usage.cacheWrite)
    : 0;
  const cost = usage && typeof usage.cost === "number" && Number.isFinite(usage.cost)
    ? Math.max(0, usage.cost)
    : 0;
  return {
    perspectiveId,
    status,
    ...(Object.prototype.hasOwnProperty.call(result, "value") ? { value: result.value } : {}),
    ...(typeof result.error === "string" ? { error: result.error.slice(0, 2_048) } : {}),
    ...(typeof result.model === "string" ? { model: result.model.slice(0, 256) } : {}),
    ...(usage ? { usage: { tokens, cost } } : {}),
  };
};
