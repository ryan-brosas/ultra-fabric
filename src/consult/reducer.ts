import {
  consultPerspectivesOverlap,
  type ConsultAdmissionDecision,
  type ConsultContextSnapshot,
  type ConsultPerspective,
  type ResolvedConsultMode,
} from "./policy.js";

export interface ConsultEvidenceCandidate {
  path: string;
  line?: number;
  endLine?: number;
  claim: string;
}

interface ValidatedConsultEvidence extends ConsultEvidenceCandidate {
  ref: string;
}

export type ConsultEvidenceResolution =
  | { kind: "resolved"; evidence: ValidatedConsultEvidence }
  | { kind: "rejected"; reason: string };

export type ConsultEvidenceResolver = (
  evidence: ConsultEvidenceCandidate,
  perspective: ConsultPerspective,
) => Promise<ConsultEvidenceResolution> | ConsultEvidenceResolution;

type ConsultWorkerStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "budget_exhausted"
  | "not_started";

export interface ConsultWorkerInput {
  perspectiveId: string;
  status: ConsultWorkerStatus;
  value?: unknown;
  error?: string;
  model?: string;
  usage?: { tokens: number; cost: number };
}

export interface ConsultReductionLimits {
  maxFindingsPerWorker: number;
  maxEvidencePerFinding: number;
}

interface ConsultFinding {
  perspectiveId: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  evidence: ValidatedConsultEvidence[];
}

interface ConsultRecommendation {
  perspectiveId: string;
  recommendation: string;
}

interface ConsultCoverage {
  requested: number;
  started: number;
  completed: number;
  accepted: number;
  failed: number;
  rejected: number;
  missing: string[];
}

interface ConsultPerspectiveResult {
  perspectiveId: string;
  status: ConsultWorkerStatus | "accepted" | "silent" | "rejected";
  stance?: "support" | "challenge" | "mixed" | "silent";
  acceptedFindings: number;
  rejectedEvidence: number;
  model?: string;
  error?: string;
  usage?: { tokens: number; cost: number };
}

export interface ConsultResult {
  format: 1;
  status:
    | "success"
    | "partial"
    | "inconclusive"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "not_admitted";
  mode?: ResolvedConsultMode;
  decision?: string;
  couldChange?: string;
  context: ConsultContextSnapshot;
  admission?: { code: string; message: string };
  coverage: ConsultCoverage;
  evidenceCount: number;
  findings: ConsultFinding[];
  recommendations: ConsultRecommendation[];
  consensus?: string;
  disagreements: ConsultRecommendation[];
  risks: string[];
  uncertainty: string[];
  silent?: boolean;
  perspectives: ConsultPerspectiveResult[];
  usage: { tokens: number; cost: number };
}

type ConsultStance = "support" | "challenge" | "mixed" | "silent";

interface ParsedFinding {
  summary: string;
  confidence: "low" | "medium" | "high";
  evidence: ConsultEvidenceCandidate[];
}

interface ParsedWorkerValue {
  stance: ConsultStance;
  recommendation?: string;
  findings: ParsedFinding[];
  risks: string[];
  uncertainty: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const boundedText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

const boundedStrings = (value: unknown, maxItems: number, maxLength: number): string[] | undefined => {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const output: string[] = [];
  for (const candidate of value) {
    const normalized = boundedText(candidate, maxLength);
    if (!normalized) return undefined;
    if (!output.includes(normalized)) output.push(normalized);
  }
  return output;
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const parseEvidence = (value: unknown): ConsultEvidenceCandidate | undefined => {
  const input = record(value);
  const path = boundedText(input?.path, 1_024);
  const claim = boundedText(input?.claim, 2_048);
  const line = input?.line === undefined ? undefined : positiveInteger(input.line);
  const endLine = input?.endLine === undefined ? undefined : positiveInteger(input.endLine);
  if (!path || !claim || (input?.line !== undefined && line === undefined) ||
    (input?.endLine !== undefined && endLine === undefined) ||
    (endLine !== undefined && line === undefined) ||
    (line !== undefined && endLine !== undefined && endLine < line)) return undefined;
  return { path, claim, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
};

const parseWorkerValue = (
  value: unknown,
  limits: ConsultReductionLimits,
): ParsedWorkerValue | undefined => {
  const input = record(value);
  if (!input) return undefined;
  const stance = input.stance;
  if (stance !== "support" && stance !== "challenge" && stance !== "mixed" &&
    stance !== "silent") return undefined;
  const recommendation = input.recommendation === undefined
    ? undefined
    : boundedText(input.recommendation, 2_048);
  if (input.recommendation !== undefined && !recommendation) return undefined;
  const risks = boundedStrings(input.risks, 16, 1_024);
  const uncertainty = boundedStrings(input.uncertainty, 16, 1_024);
  const maximumFindings = Math.max(1, Math.floor(limits.maxFindingsPerWorker));
  const maximumEvidence = Math.max(1, Math.floor(limits.maxEvidencePerFinding));
  if (!risks || !uncertainty || !Array.isArray(input.findings) ||
    input.findings.length > maximumFindings) return undefined;
  const findings: ParsedFinding[] = [];
  for (const candidate of input.findings) {
    const finding = record(candidate);
    const summary = boundedText(finding?.summary, 2_048);
    const confidence = finding?.confidence === "low" || finding?.confidence === "medium" ||
      finding?.confidence === "high" ? finding.confidence : undefined;
    if (!summary || !confidence || !Array.isArray(finding?.evidence) ||
      finding.evidence.length > maximumEvidence) return undefined;
    const evidence: ConsultEvidenceCandidate[] = [];
    for (const item of finding.evidence) {
      const parsed = parseEvidence(item);
      if (!parsed) return undefined;
      evidence.push(parsed);
    }
    findings.push({ summary, confidence, evidence });
  }
  if (
    stance === "silent" &&
    (findings.length > 0 || recommendation !== undefined || risks.length > 0 || uncertainty.length > 0)
  ) return undefined;
  if (stance !== "silent" && findings.length === 0) return undefined;
  return { stance, ...(recommendation ? { recommendation } : {}), findings, risks, uncertainty };
};

const emptyCoverage = (requested: number): ConsultCoverage => ({
  requested,
  started: 0,
  completed: 0,
  accepted: 0,
  failed: 0,
  rejected: 0,
  missing: [],
});

const aggregateStatus = (
  coverage: ConsultCoverage,
  workers: ConsultPerspectiveResult[],
): ConsultResult["status"] => {
  if (coverage.accepted === coverage.requested && coverage.failed === 0 && coverage.rejected === 0) {
    return "success";
  }
  if (coverage.accepted > 0) return "partial";
  if (coverage.completed > 0) return "inconclusive";
  const statuses = workers.map((worker) => worker.status);
  if (statuses.length > 0 && statuses.every((status) => status === "stopped")) return "cancelled";
  if (statuses.length > 0 && statuses.every((status) => status === "timed_out")) return "timed_out";
  if (statuses.length > 0 && statuses.every((status) => status === "budget_exhausted")) {
    return "budget_exhausted";
  }
  return "failed";
};

const normalizeRecommendation = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export const reduceConsult = async (
  admission: ConsultAdmissionDecision,
  workers: ConsultWorkerInput[],
  limits: ConsultReductionLimits,
  resolveEvidence: ConsultEvidenceResolver,
): Promise<ConsultResult> => {
  if (admission.kind === "not_admitted") {
    return {
      format: 1,
      status: "not_admitted",
      context: admission.context,
      admission: { code: admission.code, message: admission.message },
      coverage: emptyCoverage(0),
      evidenceCount: 0,
      findings: [],
      recommendations: [],
      disagreements: [],
      risks: [],
      uncertainty: [],
      perspectives: [],
      usage: { tokens: 0, cost: 0 },
    };
  }

  const coverage = emptyCoverage(admission.request.perspectives.length);
  const findings: ConsultFinding[] = [];
  const recommendations: ConsultRecommendation[] = [];
  const risks: string[] = [];
  const uncertainty: string[] = [];
  const perspectiveResults: ConsultPerspectiveResult[] = [];
  const usage = { tokens: 0, cost: 0 };
  let silent = false;
  const collapsedCompareIds = new Set<string>();
  if (admission.mode === "compare") {
    for (let leftIndex = 0; leftIndex < admission.request.perspectives.length; leftIndex++) {
      const left = admission.request.perspectives[leftIndex]!;
      for (const right of admission.request.perspectives.slice(leftIndex + 1)) {
        if (!consultPerspectivesOverlap(left, right)) continue;
        const leftMatches = workers.filter((worker) => worker.perspectiveId === left.id);
        const rightMatches = workers.filter((worker) => worker.perspectiveId === right.id);
        const leftWorker = leftMatches.length === 1 ? leftMatches[0] : undefined;
        const rightWorker = rightMatches.length === 1 ? rightMatches[0] : undefined;
        if (leftWorker?.status !== "completed" || rightWorker?.status !== "completed") continue;
        if (!leftWorker.model || !rightWorker.model || leftWorker.model === rightWorker.model) {
          collapsedCompareIds.add(left.id);
          collapsedCompareIds.add(right.id);
        }
      }
    }
  }

  for (const perspective of admission.request.perspectives) {
    const matching = workers.filter((worker) => worker.perspectiveId === perspective.id);
    const worker = matching.length === 1 ? matching[0] : undefined;
    if (!worker) {
      coverage.missing.push(perspective.id);
      coverage.failed++;
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: "not_started",
        acceptedFindings: 0,
        rejectedEvidence: 0,
        error: matching.length > 1 ? "duplicate worker result" : "missing worker result",
      });
      continue;
    }
    if (worker.status !== "not_started") coverage.started++;
    if (worker.usage) {
      usage.tokens += Number.isFinite(worker.usage.tokens) ? Math.max(0, worker.usage.tokens) : 0;
      usage.cost += Number.isFinite(worker.usage.cost) ? Math.max(0, worker.usage.cost) : 0;
    }
    if (worker.status === "completed" && collapsedCompareIds.has(perspective.id)) {
      coverage.completed++;
      coverage.rejected++;
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: "rejected",
        acceptedFindings: 0,
        rejectedEvidence: 0,
        ...(worker.model ? { model: worker.model } : {}),
        error: "resolved Compare model diversity collapsed",
        ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      });
      continue;
    }
    if (worker.status !== "completed") {
      coverage.failed++;
      coverage.missing.push(perspective.id);
      const error = boundedText(worker.error, 2_048);
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: worker.status,
        acceptedFindings: 0,
        rejectedEvidence: 0,
        ...(worker.model ? { model: worker.model } : {}),
        ...(error ? { error } : {}),
        ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      });
      continue;
    }

    coverage.completed++;
    const parsed = parseWorkerValue(worker.value, limits);
    if (!parsed || (parsed.stance === "silent" && admission.mode !== "challenge")) {
      coverage.rejected++;
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: "rejected",
        acceptedFindings: 0,
        rejectedEvidence: 0,
        ...(worker.model ? { model: worker.model } : {}),
        error: "malformed or mode-incompatible worker result",
        ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      });
      continue;
    }
    if (parsed.stance === "silent") {
      coverage.accepted++;
      silent = true;
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: "silent",
        stance: parsed.stance,
        acceptedFindings: 0,
        rejectedEvidence: 0,
        ...(worker.model ? { model: worker.model } : {}),
        ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      });
      continue;
    }

    const acceptedFindings: ConsultFinding[] = [];
    let rejectedEvidence = 0;
    for (const finding of parsed.findings) {
      const acceptedEvidence: ValidatedConsultEvidence[] = [];
      for (const candidate of finding.evidence) {
        let resolution: ConsultEvidenceResolution;
        try {
          resolution = await resolveEvidence(candidate, perspective);
        } catch {
          resolution = { kind: "rejected", reason: "resolver_failed" };
        }
        if (resolution.kind === "rejected") {
          rejectedEvidence++;
          continue;
        }
        if (!acceptedEvidence.some((evidence) => evidence.ref === resolution.evidence.ref)) {
          acceptedEvidence.push(resolution.evidence);
        }
      }
      if (acceptedEvidence.length === 0) continue;
      acceptedFindings.push({
        perspectiveId: perspective.id,
        summary: finding.summary,
        confidence: finding.confidence,
        evidence: acceptedEvidence,
      });
    }
    if (acceptedFindings.length === 0) {
      coverage.rejected++;
      perspectiveResults.push({
        perspectiveId: perspective.id,
        status: "rejected",
        stance: parsed.stance,
        acceptedFindings: 0,
        rejectedEvidence,
        ...(worker.model ? { model: worker.model } : {}),
        error: "no finding resolved to host evidence",
        ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      });
      continue;
    }

    coverage.accepted++;
    findings.push(...acceptedFindings);
    if (parsed.recommendation) {
      recommendations.push({ perspectiveId: perspective.id, recommendation: parsed.recommendation });
    }
    for (const risk of parsed.risks) if (!risks.includes(risk)) risks.push(risk);
    for (const item of parsed.uncertainty) if (!uncertainty.includes(item)) uncertainty.push(item);
    perspectiveResults.push({
      perspectiveId: perspective.id,
      status: "accepted",
      stance: parsed.stance,
      acceptedFindings: acceptedFindings.length,
      rejectedEvidence,
      ...(worker.model ? { model: worker.model } : {}),
      ...(worker.usage ? { usage: { ...worker.usage } } : {}),
    });
  }

  const normalized = recommendations.map((item) => normalizeRecommendation(item.recommendation));
  const consensus = coverage.accepted === coverage.requested &&
    recommendations.length === coverage.requested &&
    normalized.every((value) => value === normalized[0])
    ? recommendations[0]!.recommendation
    : undefined;
  const disagreements = new Set(normalized).size > 1 ? recommendations : [];
  const evidenceCount = new Set(
    findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.ref)),
  ).size;
  return {
    format: 1,
    status: aggregateStatus(coverage, perspectiveResults),
    mode: admission.mode,
    decision: admission.request.decision,
    couldChange: admission.request.admission.couldChange,
    context: admission.context,
    coverage,
    evidenceCount,
    findings,
    recommendations,
    ...(consensus ? { consensus } : {}),
    disagreements,
    risks,
    uncertainty,
    ...(silent ? { silent: true } : {}),
    perspectives: perspectiveResults,
    usage,
  };
};
