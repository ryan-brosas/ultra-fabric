export interface ModelRouteCandidate {
  key: string;
  available: boolean;
  authenticated: boolean;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  inputCost: number;
  outputCost: number;
}

export interface ModelRouteRequirements {
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  minContextWindow?: number;
  minOutputTokens?: number;
  maxInputCost?: number;
  maxOutputCost?: number;
}

interface ModelRouteConsideration {
  model: string;
  eligible: boolean;
  selected?: boolean;
  reasons: string[];
}

export interface ModelRouteDecision {
  version: 1;
  requestedModel: string;
  selectedModel: string;
  kind: "primary" | "fallback";
  reason: "primary" | "primary_unavailable" | "primary_unauthenticated" | "capability_mismatch";
  quality: "preserved" | "downgraded";
  downgradeReasons: string[];
  requirements: ModelRouteRequirements;
  considered: ModelRouteConsideration[];
}

export interface ModelRouteInput {
  requestedModel: string;
  fallbackModels: string[];
  requirements?: ModelRouteRequirements;
  candidates: ModelRouteCandidate[];
  allowQualityDowngrade: boolean;
}

const hardReasons = (
  candidate: ModelRouteCandidate,
  requirements: ModelRouteRequirements,
): string[] => {
  const reasons: string[] = [];
  if (!candidate.available) reasons.push("unavailable");
  else if (!candidate.authenticated) reasons.push("unauthenticated");
  for (const input of requirements.input ?? []) {
    if (!candidate.input.includes(input)) reasons.push(`missing_input:${input}`);
  }
  if (requirements.reasoning === true && !candidate.reasoning) reasons.push("reasoning_required");
  if (
    requirements.minContextWindow !== undefined &&
    candidate.contextWindow < requirements.minContextWindow
  ) {
    reasons.push(`context_below:${requirements.minContextWindow}`);
  }
  if (
    requirements.minOutputTokens !== undefined &&
    candidate.maxTokens < requirements.minOutputTokens
  ) {
    reasons.push(`output_below:${requirements.minOutputTokens}`);
  }
  if (
    requirements.maxInputCost !== undefined &&
    candidate.inputCost > requirements.maxInputCost
  ) {
    reasons.push(`input_cost_above:${requirements.maxInputCost}`);
  }
  if (
    requirements.maxOutputCost !== undefined &&
    candidate.outputCost > requirements.maxOutputCost
  ) {
    reasons.push(`output_cost_above:${requirements.maxOutputCost}`);
  }
  return reasons;
};

const qualityReasons = (
  primary: ModelRouteCandidate,
  fallback: ModelRouteCandidate,
): string[] => {
  const reasons: string[] = [];
  if (fallback.contextWindow < primary.contextWindow) reasons.push("smaller_context");
  if (fallback.maxTokens < primary.maxTokens) reasons.push("smaller_output");
  if (primary.reasoning && !fallback.reasoning) reasons.push("reasoning_lost");
  for (const input of primary.input) {
    if (!fallback.input.includes(input)) reasons.push(`input_lost:${input}`);
  }
  return reasons;
};

const fallbackReason = (
  primary: ModelRouteCandidate,
  reasons: readonly string[],
): ModelRouteDecision["reason"] => {
  if (!primary.available || reasons.includes("unavailable")) return "primary_unavailable";
  if (!primary.authenticated || reasons.includes("unauthenticated")) {
    return "primary_unauthenticated";
  }
  return "capability_mismatch";
};

export const routeModel = (input: ModelRouteInput): ModelRouteDecision => {
  const requestedModel = input.requestedModel.trim();
  const byKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate]));
  const primary = byKey.get(requestedModel) ?? {
    key: requestedModel,
    available: false,
    authenticated: false,
    input: [],
    reasoning: false,
    contextWindow: 0,
    maxTokens: 0,
    inputCost: 0,
    outputCost: 0,
  } satisfies ModelRouteCandidate;
  const requirements = structuredClone(input.requirements ?? {});
  const ordered = [...new Set([requestedModel, ...input.fallbackModels])].slice(0, 9);
  const considered: ModelRouteConsideration[] = [];
  const primaryReasons = hardReasons(primary, requirements);

  for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index]!;
    const candidate = byKey.get(key) ?? {
      key,
      available: false,
      authenticated: false,
      input: [],
      reasoning: false,
      contextWindow: 0,
      maxTokens: 0,
      inputCost: 0,
      outputCost: 0,
    } satisfies ModelRouteCandidate;
    const reasons = hardReasons(candidate, requirements);
    let downgradeReasons: string[] = [];
    if (index > 0 && primary.available) {
      downgradeReasons = qualityReasons(primary, candidate);
      if (reasons.length === 0 && downgradeReasons.length > 0 && !input.allowQualityDowngrade) {
        reasons.push(`quality_downgrade_blocked:${downgradeReasons.join(",")}`);
      }
    }
    if (reasons.length > 0) {
      considered.push({ model: key, eligible: false, reasons });
      continue;
    }
    considered.push({ model: key, eligible: true, selected: true, reasons: [] });
    return {
      version: 1,
      requestedModel,
      selectedModel: key,
      kind: index === 0 ? "primary" : "fallback",
      reason: index === 0 ? "primary" : fallbackReason(primary, primaryReasons),
      quality: downgradeReasons.length > 0 ? "downgraded" : "preserved",
      downgradeReasons,
      requirements,
      considered,
    };
  }

  const detail = considered
    .map((candidate) => `${candidate.model}(${candidate.reasons.join(",") || "ineligible"})`)
    .join("; ");
  throw new Error(`No eligible model route for ${requestedModel}: ${detail}`);
};
