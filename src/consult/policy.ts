type ConsultMode = "auto" | "partition" | "challenge" | "compare";
export type ResolvedConsultMode = Exclude<ConsultMode, "auto">;
type ConsultJustification =
  | "context_capacity"
  | "independent_verification"
  | "structural_diversity";

export interface ConsultPerspective {
  id: string;
  question: string;
  scope: string[];
  model?: string;
}

interface ConsultRequest {
  objective: string;
  decision: string;
  mode: ConsultMode;
  proposal?: string;
  admission: {
    justification: ConsultJustification;
    independence: string;
    couldChange: string;
  };
  perspectives: ConsultPerspective[];
}

export interface ConsultContextSnapshot {
  tokens: number | null;
  contextWindow: number;
  ratio: number | null;
}

export interface ConsultPolicyLimits {
  enabled: boolean;
  maxWorkers: number;
  contextPressureThreshold: number;
}

type ConsultAdmissionCode =
  | "disabled"
  | "already_attempted"
  | "agent_budget_exhausted"
  | "invalid_request"
  | "worker_limit"
  | "insufficient_perspectives"
  | "challenge_requires_proposal"
  | "overlapping_scope"
  | "insufficient_diversity"
  | "context_not_pressured";

export type ConsultAdmissionDecision =
  | {
      kind: "admitted";
      mode: ResolvedConsultMode;
      request: ConsultRequest;
      context: ConsultContextSnapshot;
    }
  | {
      kind: "not_admitted";
      code: ConsultAdmissionCode;
      message: string;
      context: ConsultContextSnapshot;
    };

const text = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const normalizeConsultPath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 1_024 || value.includes("\0")) {
    return undefined;
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/g, "");
  const parts = normalized.split("/");
  if (
    !normalized || normalized === "." || normalized.startsWith("/") ||
    normalized.startsWith("~") || /^[A-Za-z]:\//.test(normalized) ||
    parts.includes("..") || parts.includes(".") || parts.includes("")
  ) return undefined;
  return normalized;
};

const normalizeScope = (value: unknown): string[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const paths: string[] = [];
  for (const candidate of value) {
    const path = normalizeConsultPath(candidate);
    if (!path) return undefined;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
};

const normalizedContext = (value: ConsultContextSnapshot): ConsultContextSnapshot => {
  const contextWindow = Number.isFinite(value.contextWindow)
    ? Math.max(0, Math.floor(value.contextWindow))
    : 0;
  const tokens = value.tokens !== null && Number.isFinite(value.tokens)
    ? Math.max(0, Math.floor(value.tokens))
    : null;
  const suppliedRatio = value.ratio !== null && Number.isFinite(value.ratio)
    ? value.ratio
    : null;
  const ratio = suppliedRatio === null && tokens !== null && contextWindow > 0
    ? tokens / contextWindow
    : suppliedRatio;
  return {
    tokens,
    contextWindow,
    ratio: ratio === null ? null : Math.max(0, Math.min(1, ratio)),
  };
};

const notAdmitted = (
  code: ConsultAdmissionCode,
  message: string,
  context: ConsultContextSnapshot,
): ConsultAdmissionDecision => ({ kind: "not_admitted", code, message, context });

const parseRequest = (value: unknown): ConsultRequest | undefined => {
  const input = record(value);
  if (!input) return undefined;
  const objective = text(input.objective, 8_192);
  const decision = text(input.decision, 2_048);
  const mode = input.mode === undefined
    ? "auto"
    : input.mode === "auto" || input.mode === "partition" ||
        input.mode === "challenge" || input.mode === "compare"
      ? input.mode
      : undefined;
  const admissionInput = record(input.admission);
  const justification = admissionInput?.justification;
  const independence = text(admissionInput?.independence, 2_048);
  const couldChange = text(admissionInput?.couldChange, 2_048);
  if (
    !objective || !decision || !mode || !admissionInput || !independence || !couldChange ||
    (justification !== "context_capacity" &&
      justification !== "independent_verification" &&
      justification !== "structural_diversity") ||
    !Array.isArray(input.perspectives)
  ) return undefined;

  const perspectives: ConsultPerspective[] = [];
  for (const candidate of input.perspectives) {
    const perspective = record(candidate);
    const id = text(perspective?.id, 64);
    const question = text(perspective?.question, 4_096);
    const scope = normalizeScope(perspective?.scope);
    const model = perspective?.model === undefined ? undefined : text(perspective.model, 256);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || !question || !scope ||
      (perspective?.model !== undefined && (!model || !/^[^/\s]+\/\S+$/.test(model)))) {
      return undefined;
    }
    if (perspectives.some((entry) => entry.id === id)) return undefined;
    perspectives.push({ id, question, scope, ...(model ? { model } : {}) });
  }

  const proposal = input.proposal === undefined ? undefined : text(input.proposal, 8_192);
  if (input.proposal !== undefined && !proposal) return undefined;
  return {
    objective,
    decision,
    mode,
    ...(proposal ? { proposal } : {}),
    admission: { justification, independence, couldChange },
    perspectives,
  };
};

const pathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const declaredScopesOverlap = (left: ConsultPerspective, right: ConsultPerspective): boolean =>
  left.scope.some((leftPath) => right.scope.some((rightPath) =>
    pathsOverlap(leftPath, rightPath)
  ));

export const consultPerspectivesOverlap = (left: ConsultPerspective, right: ConsultPerspective): boolean =>
  left.scope.length === 0 || right.scope.length === 0 || declaredScopesOverlap(left, right);

const hasOverlappingPerspectives = (perspectives: ConsultPerspective[]): boolean => {
  for (let left = 0; left < perspectives.length; left++) {
    for (let right = left + 1; right < perspectives.length; right++) {
      if (declaredScopesOverlap(perspectives[left]!, perspectives[right]!)) return true;
    }
  }
  return false;
};

const resolveMode = (request: ConsultRequest): ResolvedConsultMode => {
  if (request.mode !== "auto") return request.mode;
  if (request.admission.justification === "independent_verification") return "challenge";
  if (request.admission.justification === "structural_diversity") return "compare";
  return "partition";
};

export const admitConsult = (
  input: unknown,
  contextInput: ConsultContextSnapshot,
  limits: ConsultPolicyLimits,
): ConsultAdmissionDecision => {
  const context = normalizedContext(contextInput);
  if (!limits.enabled) return notAdmitted("disabled", "Ultra Consult is disabled by host policy", context);
  const request = parseRequest(input);
  if (!request) return notAdmitted("invalid_request", "Ultra Consult requires a bounded objective, decision, admission intent, and perspectives", context);
  const maxWorkers = Math.max(1, Math.floor(limits.maxWorkers));
  if (request.perspectives.length > maxWorkers) {
    return notAdmitted("worker_limit", `Ultra Consult allows at most ${maxWorkers} workers`, context);
  }

  const mode = resolveMode(request);
  const minimum = mode === "challenge" ? 1 : 2;
  const maximum = mode === "challenge" ? 1 : maxWorkers;
  if (request.perspectives.length < minimum || request.perspectives.length > maximum) {
    return notAdmitted(
      "insufficient_perspectives",
      mode === "challenge"
        ? "Challenge mode requires exactly one independent perspective"
        : `${mode} mode requires at least two independent perspectives`,
      context,
    );
  }
  if (mode === "challenge" && !request.proposal) {
    return notAdmitted("challenge_requires_proposal", "Challenge mode requires the proposal being challenged", context);
  }

  const overlap = hasOverlappingPerspectives(request.perspectives);
  const mixedScopedPartition = mode === "partition" &&
    request.perspectives.some((perspective) => perspective.scope.length === 0) &&
    request.perspectives.some((perspective) => perspective.scope.length > 0);
  if (mode === "partition" && (overlap || mixedScopedPartition)) {
    return notAdmitted("overlapping_scope", "Partition workers must use all-unscoped questions or non-overlapping path scopes", context);
  }
  if (mode === "compare") {
    const pairwiseDistinct = request.perspectives.every((left, index) =>
      request.perspectives.slice(index + 1).every((right) =>
        !consultPerspectivesOverlap(left, right) ||
        Boolean(left.model && right.model && left.model !== right.model)
      )
    );
    if (!pairwiseDistinct) {
      return notAdmitted(
        "insufficient_diversity",
        "Every Compare pair requires non-overlapping evidence scopes or distinct model requests",
        context,
      );
    }
  }
  if (request.admission.justification === "context_capacity") {
    const threshold = Math.max(0, Math.min(1, limits.contextPressureThreshold));
    const structurallyPartitioned = mode === "partition" &&
      request.perspectives.every((perspective) => perspective.scope.length > 0) && !overlap;
    if ((context.ratio ?? 0) < threshold && !structurallyPartitioned) {
      return notAdmitted(
        "context_not_pressured",
        "Context-capacity delegation needs host-observed pressure or explicit non-overlapping scopes",
        context,
      );
    }
  }
  return { kind: "admitted", mode, request, context };
};
