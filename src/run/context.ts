import { createHash, randomUUID } from "node:crypto";

export type FabricRunOutcome = "succeeded" | "failed" | "aborted" | "timed_out";
type FabricGateDisposition = "advise" | "revise" | "abort";
type FabricGateDecision = "continue" | "revise" | "abort";
type FabricEvidenceKind = "command" | "artifact" | "trace" | "custom";

export interface FabricRunEnvelopeV1 {
  version: 1;
  runId: string;
  traceId: string;
  spanId: string;
  parentRunId?: string;
  parentSpanId?: string;
  objectiveDigest: string;
  startedAt: number;
  deadline: number;
  cancellationOwner: string;
}

export const isFabricRunEnvelopeV1 = (value: unknown): value is FabricRunEnvelopeV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<FabricRunEnvelopeV1>;
  return (
    record.version === 1 &&
    typeof record.runId === "string" &&
    Boolean(record.runId) &&
    typeof record.traceId === "string" &&
    Boolean(record.traceId) &&
    typeof record.spanId === "string" &&
    Boolean(record.spanId) &&
    (record.parentRunId === undefined || typeof record.parentRunId === "string") &&
    (record.parentSpanId === undefined || typeof record.parentSpanId === "string") &&
    typeof record.objectiveDigest === "string" &&
    Boolean(record.objectiveDigest) &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt) &&
    typeof record.deadline === "number" &&
    Number.isFinite(record.deadline) &&
    typeof record.cancellationOwner === "string" &&
    Boolean(record.cancellationOwner)
  );
};

export interface FabricEvidenceRef {
  kind: FabricEvidenceKind;
  ref: string;
  digest?: string;
}

interface FabricRecordedEvidence extends FabricEvidenceRef {
  sequence: number;
  recordedAt: number;
}

export interface FabricRunTransition {
  sequence: number;
  state: string;
  occurredAt: number;
  data?: unknown;
}

export interface FabricGateInput {
  gate: string;
  passed: boolean;
  disposition: FabricGateDisposition;
  evidence: FabricEvidenceRef[];
  reason?: string;
  error?: string;
}

export interface FabricGateResult extends FabricGateInput {
  sequence: number;
  recordedAt: number;
  decision: FabricGateDecision;
  revision: number;
  failure?: "gate_failed" | "gate_crashed" | "revision_limit";
}

export interface FabricRunBudgetSnapshot {
  agents: { limit: number; spent: number; reserved: number; remaining: number };
  tokens: { limit: number; spent: number; reserved: number; remaining: number };
}

interface FabricAgentReservation {
  id: string;
  tokens: number;
}

class FabricEvidenceLedger {
  readonly #entries: FabricRecordedEvidence[] = [];

  constructor(readonly limit: number) {}

  record(
    evidence: FabricEvidenceRef,
    recordedAt = Date.now(),
  ):
    | { ok: true; evidence: FabricRecordedEvidence }
    | { ok: false; reason: "evidence_limit"; limit: number } {
    if (this.#entries.length >= this.limit) {
      return { ok: false, reason: "evidence_limit", limit: this.limit };
    }
    const recorded: FabricRecordedEvidence = {
      ...structuredClone(evidence),
      sequence: this.#entries.length + 1,
      recordedAt,
    };
    this.#entries.push(recorded);
    return { ok: true, evidence: structuredClone(recorded) };
  }

  list(): FabricRecordedEvidence[] {
    return structuredClone(this.#entries);
  }
}

class FabricTransitionLedger {
  readonly #entries: FabricRunTransition[] = [];

  constructor(readonly limit: number) {}

  record(
    state: string,
    occurredAt = Date.now(),
    data?: unknown,
  ):
    | { ok: true; transition: FabricRunTransition }
    | { ok: false; reason: "transition_limit"; limit: number } {
    if (this.#entries.length >= this.limit) {
      return { ok: false, reason: "transition_limit", limit: this.limit };
    }
    const transition: FabricRunTransition = {
      sequence: this.#entries.length + 1,
      state,
      occurredAt,
      ...(data === undefined ? {} : { data: structuredClone(data) }),
    };
    this.#entries.push(transition);
    return { ok: true, transition: structuredClone(transition) };
  }

  recordTerminal(
    state: string,
    occurredAt = Date.now(),
    data?: unknown,
  ): { ok: true; transition: FabricRunTransition; replaced: boolean } {
    const replaced = this.#entries.length >= this.limit;
    const sequence = replaced
      ? (this.#entries.pop()?.sequence ?? this.limit)
      : this.#entries.length + 1;
    const transition: FabricRunTransition = {
      sequence,
      state,
      occurredAt,
      ...(data === undefined ? {} : { data: structuredClone(data) }),
    };
    this.#entries.push(transition);
    return { ok: true, transition: structuredClone(transition), replaced };
  }

  list(): FabricRunTransition[] {
    return structuredClone(this.#entries);
  }
}

class FabricGateChain {
  readonly #results: FabricGateResult[] = [];
  readonly #pendingRevisions = new Set<string>();
  #terminal: FabricGateResult | undefined;
  #revisions = 0;

  constructor(
    readonly maxRevisions: number,
    readonly maxResults: number,
  ) {}

  record(input: FabricGateInput, recordedAt = Date.now()): FabricGateResult {
    if (this.#results.length >= this.maxResults) {
      throw new Error(`Fabric gate result limit exhausted (${this.maxResults})`);
    }
    let decision: FabricGateDecision = "continue";
    let failure: FabricGateResult["failure"];
    if (input.error) {
      decision = "abort";
      failure = "gate_crashed";
    } else if (!input.passed && input.disposition === "abort") {
      decision = "abort";
      failure = "gate_failed";
    } else if (!input.passed && input.disposition === "revise") {
      if (this.#revisions >= this.maxRevisions) {
        decision = "abort";
        failure = "revision_limit";
      } else {
        this.#revisions++;
        decision = "revise";
        this.#pendingRevisions.add(input.gate);
      }
    } else if (input.passed) {
      this.#pendingRevisions.delete(input.gate);
    }
    const result: FabricGateResult = {
      ...structuredClone(input),
      sequence: this.#results.length + 1,
      recordedAt,
      decision,
      revision: this.#revisions,
      ...(failure ? { failure } : {}),
    };
    this.#results.push(result);
    if (result.decision === "abort") this.#terminal = result;
    return structuredClone(result);
  }

  list(): FabricGateResult[] {
    return structuredClone(this.#results);
  }

  pending(): string[] {
    return [...this.#pendingRevisions].sort();
  }

  crash(
    gate: string,
    error: string,
    recordedAt = Date.now(),
  ): FabricGateResult {
    if (this.#terminal) return structuredClone(this.#terminal);
    const sequence = this.#results.length >= this.maxResults
      ? (this.#results.pop()?.sequence ?? this.maxResults)
      : this.#results.length + 1;
    const result: FabricGateResult = {
      gate,
      passed: false,
      disposition: "abort",
      evidence: [],
      error,
      sequence,
      recordedAt,
      decision: "abort",
      revision: this.#revisions,
      failure: "gate_crashed",
    };
    this.#results.push(result);
    this.#terminal = result;
    return structuredClone(result);
  }

  terminal(): FabricGateResult | undefined {
    return this.#terminal ? structuredClone(this.#terminal) : undefined;
  }
}

class FabricRunBudget {
  readonly #reservations = new Map<string, FabricAgentReservation>();
  #spentAgents = 0;
  #spentTokens = 0;

  constructor(
    readonly maxAgents: number,
    readonly maxTokens: number,
    readonly nextId: () => string,
  ) {}

  reserveAgent(input: { tokens: number }):
    | { ok: true; reservation: FabricAgentReservation }
    | { ok: false; reason: "agent_limit" | "token_limit"; limit: number } {
    if (this.#spentAgents + this.#reservations.size >= this.maxAgents) {
      return { ok: false, reason: "agent_limit", limit: this.maxAgents };
    }
    const tokens = Math.max(0, Math.floor(input.tokens));
    const reservedTokens = [...this.#reservations.values()]
      .reduce((total, reservation) => total + reservation.tokens, 0);
    if (this.#spentTokens + reservedTokens + tokens > this.maxTokens) {
      return { ok: false, reason: "token_limit", limit: this.maxTokens };
    }
    const reservation = { id: this.nextId(), tokens };
    this.#reservations.set(reservation.id, reservation);
    return { ok: true, reservation: structuredClone(reservation) };
  }

  settle(reservationId: string, input: { actualTokens: number }):
    | { ok: true; actualTokens: number; releasedTokens: number; overrunTokens: number }
    | { ok: false; reason: "unknown_reservation"; reservationId: string } {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      return { ok: false, reason: "unknown_reservation", reservationId };
    }
    this.#reservations.delete(reservationId);
    const actualTokens = Math.max(0, Math.floor(input.actualTokens));
    this.#spentAgents++;
    this.#spentTokens += actualTokens;
    return {
      ok: true,
      actualTokens,
      releasedTokens: Math.max(0, reservation.tokens - actualTokens),
      overrunTokens: Math.max(0, actualTokens - reservation.tokens),
    };
  }

  release(reservationId: string):
    | { ok: true; releasedTokens: number }
    | { ok: false; reason: "unknown_reservation"; reservationId: string } {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      return { ok: false, reason: "unknown_reservation", reservationId };
    }
    this.#reservations.delete(reservationId);
    return { ok: true, releasedTokens: reservation.tokens };
  }

  snapshot(): FabricRunBudgetSnapshot {
    const reservedTokens = [...this.#reservations.values()]
      .reduce((total, reservation) => total + reservation.tokens, 0);
    return {
      agents: {
        limit: this.maxAgents,
        spent: this.#spentAgents,
        reserved: this.#reservations.size,
        remaining: Math.max(0, this.maxAgents - this.#spentAgents - this.#reservations.size),
      },
      tokens: {
        limit: this.maxTokens,
        spent: this.#spentTokens,
        reserved: reservedTokens,
        remaining: Math.max(0, this.maxTokens - this.#spentTokens - reservedTokens),
      },
    };
  }
}

export interface CreateFabricRunContextOptions {
  runId: string;
  traceId?: string;
  spanId?: string;
  parentRunId?: string;
  parentSpanId?: string;
  objective: string;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
  nextId?: () => string;
  maxAgents: number;
  maxTokens: number;
  maxEvidence?: number;
  maxTransitions?: number;
  maxGateRevisions?: number;
}

export class FabricRunContext {
  readonly evidence: FabricEvidenceLedger;
  readonly transitions: FabricTransitionLedger;
  readonly gates: FabricGateChain;
  readonly budget: FabricRunBudget;
  #envelope: FabricRunEnvelopeV1;
  #settlement: { outcome: FabricRunOutcome; settledAt: number } | undefined;

  constructor(
    envelope: FabricRunEnvelopeV1,
    readonly signal: AbortSignal | undefined,
    options: {
      maxEvidence: number;
      maxTransitions: number;
      maxGateRevisions: number;
      maxAgents: number;
      maxTokens: number;
      nextId: () => string;
    },
  ) {
    this.#envelope = envelope;
    this.evidence = new FabricEvidenceLedger(options.maxEvidence);
    this.transitions = new FabricTransitionLedger(options.maxTransitions);
    this.gates = new FabricGateChain(options.maxGateRevisions, options.maxTransitions);
    this.budget = new FabricRunBudget(options.maxAgents, options.maxTokens, options.nextId);
  }

  get envelope(): FabricRunEnvelopeV1 {
    return this.#envelope;
  }

  extendDeadline(deadline: number): boolean {
    if (!Number.isFinite(deadline) || deadline <= this.#envelope.deadline) return false;
    this.#envelope = Object.freeze({
      ...this.#envelope,
      deadline: Math.floor(deadline),
    });
    return true;
  }

  settle(outcome: FabricRunOutcome, settledAt = Date.now()):
    | { ok: true; settlement: { outcome: FabricRunOutcome; settledAt: number } }
    | {
        ok: false;
        reason: "already_settled";
        settlement: { outcome: FabricRunOutcome; settledAt: number };
      } {
    if (this.#settlement) {
      return { ok: false, reason: "already_settled", settlement: { ...this.#settlement } };
    }
    this.#settlement = { outcome, settledAt };
    return { ok: true, settlement: { ...this.#settlement } };
  }
}

export const createFabricRunContext = (
  options: CreateFabricRunContextOptions,
): FabricRunContext => {
  const now = options.now?.() ?? Date.now();
  const envelope: FabricRunEnvelopeV1 = Object.freeze({
    version: 1,
    runId: options.runId,
    traceId: options.traceId ?? randomUUID(),
    spanId: options.spanId ?? randomUUID(),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    objectiveDigest: createHash("sha256").update(options.objective).digest("hex"),
    startedAt: now,
    deadline: now + Math.max(0, Math.floor(options.timeoutMs)),
    cancellationOwner: options.runId,
  });
  return new FabricRunContext(envelope, options.signal, {
    maxEvidence: Math.max(1, Math.floor(options.maxEvidence ?? 256)),
    maxTransitions: Math.max(1, Math.floor(options.maxTransitions ?? 512)),
    maxGateRevisions: Math.max(0, Math.floor(options.maxGateRevisions ?? 2)),
    maxAgents: Math.max(0, Math.floor(options.maxAgents)),
    maxTokens: Math.max(0, Math.floor(options.maxTokens)),
    nextId: options.nextId ?? (() => randomUUID()),
  });
};
