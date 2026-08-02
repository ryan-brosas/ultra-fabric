import { createHash } from "node:crypto";
import type { MeshIdentity, MeshStateEntry, MeshStore } from "../mesh/store.js";

type FabricOutcomeVerdict = "none" | "passed" | "revise" | "abort" | "crashed";
interface FabricOutcomeRoute {
  requestedModel: string;
  selectedModel: string;
  reason: string;
  quality: "preserved" | "downgraded";
}
export interface FabricConsultOutcome {
  status: "success" | "partial" | "inconclusive" | "failed" | "cancelled" | "timed_out" | "budget_exhausted" | "not_admitted";
  mode?: "partition" | "challenge" | "compare";
  admissionCode?: string;
  requested: number;
  started: number;
  completed: number;
  accepted: number;
  failed: number;
  rejected: number;
  evidenceCount: number;
  contextRatio: number | null;
  workerTokens: number;
  workerCost: number;
}
export interface FabricOutcomeInput {
  runId: string;
  traceId: string;
  objectiveDigest: string;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tokens: number;
  cost: number;
  gateVerdict: FabricOutcomeVerdict;
  evidenceCount: number;
  routes: FabricOutcomeRoute[];
  admissionReasons?: string[];
  consult?: FabricConsultOutcome;
}
export interface FabricOutcomeEvaluation {
  kind: "deterministic" | "model_judge";
  scorer: string;
  evaluator?: string;
  score: number;
  passed: boolean;
  evaluatedAt?: number;
}
export interface FabricOutcomeRecord extends FabricOutcomeInput {
  format: 1;
  id: string;
  verified: boolean;
  downgraded: boolean;
  admissionReasons: string[];
  evaluations: FabricOutcomeEvaluation[];
  recordedAt: number;
}

const finite = (value: number, min = 0): number =>
  Number.isFinite(value) ? Math.max(min, value) : min;
const bounded = (value: string, limit = 256): string => value.trim().slice(0, limit);
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
};
const outcomeId = (runId: string): string =>
  createHash("sha256").update(runId).digest("hex").slice(0, 32);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const outcomeValues = new Set(["succeeded", "failed", "aborted", "timed_out"]);
const verdictValues = new Set(["none", "passed", "revise", "abort", "crashed"]);
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isRoute = (value: unknown): value is FabricOutcomeRoute => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return hasOnlyKeys(route, ["requestedModel", "selectedModel", "reason", "quality"]) &&
    typeof route.requestedModel === "string" && typeof route.selectedModel === "string" &&
    typeof route.reason === "string" &&
    (route.quality === "preserved" || route.quality === "downgraded");
};
const consultStatusValues = new Set([
  "success", "partial", "inconclusive", "failed", "cancelled", "timed_out",
  "budget_exhausted", "not_admitted",
]);
const consultModeValues = new Set(["partition", "challenge", "compare"]);
const isConsultOutcome = (value: unknown): value is FabricConsultOutcome => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const consult = value as Record<string, unknown>;
  return hasOnlyKeys(consult, [
    "status", "mode", "admissionCode", "requested", "started", "completed",
    "accepted", "failed", "rejected", "evidenceCount", "contextRatio",
    "workerTokens", "workerCost",
  ]) && consultStatusValues.has(consult.status as string) &&
    (consult.mode === undefined || consultModeValues.has(consult.mode as string)) &&
    (consult.admissionCode === undefined ||
      (typeof consult.admissionCode === "string" && consult.admissionCode.length <= 256)) &&
    finiteNonnegative(consult.requested) && finiteNonnegative(consult.started) &&
    finiteNonnegative(consult.completed) && finiteNonnegative(consult.accepted) &&
    finiteNonnegative(consult.failed) && finiteNonnegative(consult.rejected) &&
    finiteNonnegative(consult.evidenceCount) &&
    (consult.contextRatio === null ||
      (finiteNonnegative(consult.contextRatio) && consult.contextRatio <= 1)) &&
    finiteNonnegative(consult.workerTokens) && finiteNonnegative(consult.workerCost);
};
const isEvaluation = (value: unknown): value is FabricOutcomeEvaluation => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const evaluation = value as Record<string, unknown>;
  return hasOnlyKeys(evaluation, ["kind", "scorer", "evaluator", "score", "passed", "evaluatedAt"]) &&
    (evaluation.kind === "deterministic" || evaluation.kind === "model_judge") &&
    typeof evaluation.scorer === "string" &&
    (evaluation.evaluator === undefined || typeof evaluation.evaluator === "string") &&
    finiteNonnegative(evaluation.score) && evaluation.score <= 1 &&
    typeof evaluation.passed === "boolean" &&
    (evaluation.evaluatedAt === undefined || finiteNonnegative(evaluation.evaluatedAt));
};
const isRecord = (value: unknown): value is FabricOutcomeRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, [
    "format", "id", "runId", "traceId", "objectiveDigest", "outcome", "startedAt",
    "finishedAt", "durationMs", "tokens", "cost", "gateVerdict", "evidenceCount",
    "routes", "verified", "downgraded", "admissionReasons", "consult", "evaluations", "recordedAt",
  ]) && record.format === 1 &&
    typeof record.id === "string" && Boolean(record.id) &&
    typeof record.runId === "string" && Boolean(record.runId) &&
    typeof record.traceId === "string" && typeof record.objectiveDigest === "string" &&
    outcomeValues.has(record.outcome as string) &&
    finiteNonnegative(record.startedAt) && finiteNonnegative(record.finishedAt) &&
    finiteNonnegative(record.durationMs) && finiteNonnegative(record.tokens) &&
    finiteNonnegative(record.cost) && verdictValues.has(record.gateVerdict as string) &&
    finiteNonnegative(record.evidenceCount) &&
    Array.isArray(record.routes) && record.routes.length <= 32 && record.routes.every(isRoute) &&
    typeof record.verified === "boolean" && typeof record.downgraded === "boolean" &&
    Array.isArray(record.admissionReasons) && record.admissionReasons.length <= 16 &&
    record.admissionReasons.every((reason) => typeof reason === "string") &&
    (record.consult === undefined || isConsultOutcome(record.consult)) &&
    Array.isArray(record.evaluations) && record.evaluations.length <= 32 &&
    record.evaluations.every(isEvaluation) && finiteNonnegative(record.recordedAt);
};
const casError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Mesh compare-and-swap failed");

export const evaluateDeterministic = (input: {
  scorer: "exact" | "contains" | "numeric";
  actual: unknown;
  expected: unknown;
  tolerance?: number;
}): { kind: "deterministic"; scorer: string; score: number; passed: boolean } => {
  let passed = false;
  if (input.scorer === "exact") {
    passed = JSON.stringify(canonical(input.actual)) === JSON.stringify(canonical(input.expected));
  } else if (input.scorer === "contains") {
    passed = typeof input.actual === "string" && typeof input.expected === "string" &&
      input.actual.includes(input.expected);
  } else {
    const tolerance = finite(input.tolerance ?? 0);
    passed = typeof input.actual === "number" && Number.isFinite(input.actual) &&
      typeof input.expected === "number" && Number.isFinite(input.expected) &&
      Math.abs(input.actual - input.expected) <= tolerance;
  }
  return { kind: "deterministic", scorer: input.scorer, score: passed ? 1 : 0, passed };
};

interface FabricOutcomeConfidence {
  low: number;
  high: number;
}

interface FabricOutcomeCandidate {
  model: string;
  samples: number;
  successRate: number;
  successConfidence: FabricOutcomeConfidence;
  verifiedRate: number;
  verifiedConfidence: FabricOutcomeConfidence;
  averageDurationMs: number;
  averageTokens: number;
  averageCost: number;
  downgradeRate: number;
  admissionReasons: Record<string, number>;
  averageScore?: number;
}

export interface FabricOutcomeReport {
  status: "insufficient_samples" | "recommended";
  minimumSamples: number;
  recommendedModel?: string;
  candidates: FabricOutcomeCandidate[];
  excluded: Array<{ model: string; samples: number; reason: "insufficient_samples" }>;
}

export class FabricOutcomeStore {
  readonly #maxRecords: number;
  readonly #minimum: number;
  readonly #now: () => number;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    options: { maxRecords?: number; minRecommendationSamples?: number; now?: () => number } = {},
  ) {
    this.#maxRecords = Math.max(1, Math.min(10_000, Math.floor(options.maxRecords ?? 1_000)));
    this.#minimum = Math.max(2, Math.min(1_000, Math.floor(options.minRecommendationSamples ?? 5)));
    this.#now = options.now ?? Date.now;
  }

  #key(id: string): string {
    return `outcomes/${id}`;
  }

  #from(entry: MeshStateEntry | undefined, id: string): FabricOutcomeRecord {
    if (!entry || !isRecord(entry.value) || entry.value.id !== id) {
      throw new Error(`Unknown Fabric outcome: ${id}`);
    }
    return structuredClone(entry.value);
  }

  async record(input: FabricOutcomeInput): Promise<FabricOutcomeRecord> {
    const runId = bounded(input.runId);
    if (!runId) throw new Error("Fabric outcome requires runId");
    const id = outcomeId(runId);
    const existing = this.mesh.get(this.#key(id));
    if (existing) {
      const record = this.#from(existing, id);
      if (record.runId !== runId) throw new Error(`Fabric outcome id collision: ${id}`);
      return record;
    }
    if (this.mesh.listAll("outcomes/").length >= this.#maxRecords) {
      throw new Error(`Fabric outcome ledger capacity reached (${this.#maxRecords})`);
    }
    const routes = input.routes.slice(0, 32).map((route) => ({
      requestedModel: bounded(route.requestedModel),
      selectedModel: bounded(route.selectedModel),
      reason: bounded(route.reason),
      quality: route.quality === "downgraded" ? "downgraded" as const : "preserved" as const,
    }));
    const consult = input.consult
      ? {
          status: input.consult.status,
          ...(input.consult.mode ? { mode: input.consult.mode } : {}),
          ...(input.consult.admissionCode
            ? { admissionCode: bounded(input.consult.admissionCode) }
            : {}),
          requested: Math.floor(finite(input.consult.requested)),
          started: Math.floor(finite(input.consult.started)),
          completed: Math.floor(finite(input.consult.completed)),
          accepted: Math.floor(finite(input.consult.accepted)),
          failed: Math.floor(finite(input.consult.failed)),
          rejected: Math.floor(finite(input.consult.rejected)),
          evidenceCount: Math.floor(finite(input.consult.evidenceCount)),
          contextRatio: input.consult.contextRatio === null
            ? null
            : Math.max(0, Math.min(1, finite(input.consult.contextRatio))),
          workerTokens: Math.floor(finite(input.consult.workerTokens)),
          workerCost: finite(input.consult.workerCost),
        } satisfies FabricConsultOutcome
      : undefined;
    const record: FabricOutcomeRecord = {
      format: 1,
      id,
      runId,
      traceId: bounded(input.traceId),
      objectiveDigest: bounded(input.objectiveDigest),
      outcome: input.outcome,
      startedAt: finite(input.startedAt),
      finishedAt: finite(input.finishedAt),
      durationMs: finite(input.durationMs),
      tokens: Math.floor(finite(input.tokens)),
      cost: finite(input.cost),
      gateVerdict: input.gateVerdict,
      evidenceCount: Math.floor(finite(input.evidenceCount)),
      routes,
      admissionReasons: [...new Set((input.admissionReasons ?? [])
        .map((reason) => bounded(reason))
        .filter(Boolean))].slice(0, 16),
      ...(consult ? { consult } : {}),
      verified: input.gateVerdict === "passed",
      downgraded: routes.some((route) => route.quality === "downgraded"),
      evaluations: [],
      recordedAt: this.#now(),
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const stored = await this.mesh.put({
          key: this.#key(id), value: record, identity: this.identity, ifVersion: 0,
        });
        const persisted = this.#from(stored, id);
        await this.mesh.publish({
          id: `outcome:${id}:recorded`,
          topic: "fabric.outcome",
          kind: "recorded",
          from: this.identity,
          data: {
            id,
            outcome: persisted.outcome,
            verified: persisted.verified,
            downgraded: persisted.downgraded,
            durationMs: persisted.durationMs,
            tokens: persisted.tokens,
            cost: persisted.cost,
          },
        }).catch(() => undefined);
        return persisted;
      } catch (error) {
        if (!casError(error)) throw error;
        const raced = this.mesh.get(this.#key(id));
        if (raced) return this.#from(raced, id);
      }
    }
    throw new Error(`Fabric outcome record contention: ${id}`);
  }

  summary(): {
    records: number;
    succeeded: number;
    verified: number;
    downgraded: number;
    evaluated: number;
  } {
    const records = this.mesh.listAll("outcomes/")
      .flatMap((entry) => isRecord(entry.value) ? [entry.value] : []);
    return {
      records: records.length,
      succeeded: records.filter((record) => record.outcome === "succeeded").length,
      verified: records.filter((record) => record.verified).length,
      downgraded: records.filter((record) => record.downgraded).length,
      evaluated: records.filter((record) => record.evaluations.length > 0).length,
    };
  }

  async list(limit = this.#maxRecords): Promise<FabricOutcomeRecord[]> {
    return this.mesh.listAll("outcomes/")
      .flatMap((entry) => isRecord(entry.value) ? [structuredClone(entry.value)] : [])
      .sort((left, right) => right.recordedAt - left.recordedAt || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(this.#maxRecords, Math.floor(limit))));
  }

  async status(idOrRunId: string): Promise<FabricOutcomeRecord> {
    const direct = this.mesh.get(this.#key(idOrRunId));
    if (direct) return this.#from(direct, idOrRunId);
    const id = outcomeId(idOrRunId);
    return this.#from(this.mesh.get(this.#key(id)), id);
  }

  async evaluate(idOrRunId: string, input: FabricOutcomeEvaluation): Promise<FabricOutcomeRecord> {
    const current = await this.status(idOrRunId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = this.mesh.get(this.#key(current.id));
      const record = this.#from(entry, current.id);
      if (record.evaluations.length >= 32) throw new Error("Fabric outcome evaluation limit reached (32)");
      const score = Math.max(0, Math.min(1, finite(input.score)));
      const evaluation: FabricOutcomeEvaluation = {
        kind: input.kind,
        scorer: bounded(input.scorer),
        ...(input.kind === "model_judge" && input.evaluator
          ? { evaluator: bounded(input.evaluator) }
          : {}),
        score,
        passed: input.passed,
        evaluatedAt: this.#now(),
      };
      record.evaluations.push(evaluation);
      try {
        const stored = await this.mesh.put({
          key: this.#key(record.id), value: record, identity: this.identity,
          ifVersion: entry!.version,
        });
        return this.#from(stored, record.id);
      } catch (error) {
        if (!casError(error) || attempt === 7) throw error;
      }
    }
    throw new Error(`Fabric outcome evaluation contention: ${current.id}`);
  }

  async recommend(): Promise<FabricOutcomeReport> {
    const groups = new Map<string, FabricOutcomeRecord[]>();
    for (const outcome of await this.list()) {
      const model = outcome.routes.at(-1)?.selectedModel;
      if (!model) continue;
      const group = groups.get(model) ?? [];
      group.push(outcome);
      groups.set(model, group);
    }
    const excluded: Array<{ model: string; samples: number; reason: "insufficient_samples" }> = [];
    const candidates = [...groups.entries()].flatMap(([model, outcomes]) => {
      if (outcomes.length < this.#minimum) {
        excluded.push({ model, samples: outcomes.length, reason: "insufficient_samples" });
        return [];
      }
      const average = (values: number[]): number =>
        values.reduce((total, value) => total + value, 0) / values.length;
      const scores = outcomes.flatMap((outcome) =>
        outcome.evaluations.length > 0
          ? [outcome.evaluations.reduce((total, item) => total + item.score, 0) /
              outcome.evaluations.length]
          : []
      );
      const confidence = (successes: number): { low: number; high: number } => {
        const count = outcomes.length;
        const proportion = successes / count;
        const z = 1.96;
        const zSquared = z * z;
        const denominator = 1 + zSquared / count;
        const center = (proportion + zSquared / (2 * count)) / denominator;
        const margin = z * Math.sqrt(
          (proportion * (1 - proportion) + zSquared / (4 * count)) / count,
        ) / denominator;
        return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
      };
      const successes = outcomes.filter((outcome) => outcome.outcome === "succeeded").length;
      const verified = outcomes.filter((outcome) => outcome.verified).length;
      return [{
        model,
        samples: outcomes.length,
        successRate: successes / outcomes.length,
        successConfidence: confidence(successes),
        verifiedRate: verified / outcomes.length,
        verifiedConfidence: confidence(verified),
        averageDurationMs: average(outcomes.map((outcome) => outcome.durationMs)),
        averageTokens: average(outcomes.map((outcome) => outcome.tokens)),
        averageCost: average(outcomes.map((outcome) => outcome.cost)),
        downgradeRate: outcomes.filter((outcome) => outcome.downgraded).length / outcomes.length,
        admissionReasons: Object.fromEntries(
          [...new Set(outcomes.flatMap((outcome) => outcome.admissionReasons))]
            .sort()
            .map((reason) => [
              reason,
              outcomes.filter((outcome) => outcome.admissionReasons.includes(reason)).length,
            ]),
        ),
        ...(scores.length > 0 ? { averageScore: average(scores) } : {}),
      }];
    }).sort((left, right) =>
      right.verifiedConfidence.low - left.verifiedConfidence.low ||
      right.successConfidence.low - left.successConfidence.low ||
      (right.averageScore ?? -1) - (left.averageScore ?? -1) ||
      left.averageCost - right.averageCost ||
      left.averageDurationMs - right.averageDurationMs ||
      left.model.localeCompare(right.model)
    );
    excluded.sort((left, right) => left.model.localeCompare(right.model));
    if (candidates.length === 0) {
      return { status: "insufficient_samples", minimumSamples: this.#minimum, candidates: [], excluded };
    }
    return {
      status: "recommended",
      minimumSamples: this.#minimum,
      recommendedModel: candidates[0]!.model,
      candidates,
      excluded,
    };
  }
}
