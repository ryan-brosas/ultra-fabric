import { createHash, randomUUID } from "node:crypto";
import type { MeshIdentity, MeshStateEntry, MeshStore } from "../mesh/store.js";

type DurableWorkflowStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
type DurableWorkflowPhaseStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DurableWorkflowEvidenceRef {
  kind: "command" | "artifact" | "trace" | "custom";
  ref: string;
  digest?: string;
}

interface DurableWorkflowPhaseDefinition {
  id: string;
  deps?: string[];
  objective?: string;
  maxAttempts?: number;
}

export interface DurableWorkflowDefinition {
  id: string;
  name: string;
  phases: DurableWorkflowPhaseDefinition[];
  leaseMs?: number;
}

interface DurableWorkflowPhase {
  id: string;
  deps: string[];
  objectiveDigest?: string;
  maxAttempts: number;
  status: DurableWorkflowPhaseStatus;
  attempt: number;
  ownerRunId?: string;
  ownerTraceId?: string;
  ownerSpanId?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  evidence?: DurableWorkflowEvidenceRef[];
  outputDigest?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface DurableWorkflowRecord {
  format: 1;
  id: string;
  name: string;
  definitionDigest: string;
  status: DurableWorkflowStatus;
  leaseMs: number;
  phases: DurableWorkflowPhase[];
  createdAt: number;
  updatedAt: number;
  cancelledAt?: number;
  cancelReason?: string;
}

export interface DurableWorkflowClaim {
  workflowId: string;
  leaseToken: string;
  leaseExpiresAt: number;
  phase: DurableWorkflowPhase;
}

interface Mutation<Result> {
  record: DurableWorkflowRecord;
  result: Result;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CAS_ATTEMPTS = 8;

const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const compareAndSwapError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Mesh compare-and-swap failed");

const phaseDefinition = (
  input: DurableWorkflowPhaseDefinition,
  ids: ReadonlySet<string>,
): DurableWorkflowPhase => {
  const id = input.id.trim();
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid durable workflow phase id: ${input.id}`);
  const deps = [...new Set(input.deps ?? [])];
  for (const dep of deps) {
    if (!ids.has(dep) || dep === id) {
      throw new Error(`Invalid durable workflow dependency ${dep} for phase ${id}`);
    }
  }
  const objective = input.objective?.trim();
  return {
    id,
    deps,
    ...(objective ? { objectiveDigest: digest(objective) } : {}),
    maxAttempts:
      typeof input.maxAttempts === "number" && Number.isFinite(input.maxAttempts)
        ? Math.max(1, Math.min(20, Math.floor(input.maxAttempts)))
        : 1,
    status: deps.length === 0 ? "ready" : "pending",
    attempt: 0,
  };
};

const assertAcyclic = (phases: readonly DurableWorkflowPhase[]): void => {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Durable workflow contains a cycle at phase ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of phases) visit(phase.id);
};

const normalizedDefinition = (
  definition: DurableWorkflowDefinition,
  now: number,
): DurableWorkflowRecord => {
  const id = definition.id.trim();
  const name = definition.name.trim();
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid durable workflow id: ${definition.id}`);
  if (!name || name.length > 256) throw new Error("Durable workflow name must be 1-256 characters");
  if (!Array.isArray(definition.phases) || definition.phases.length < 1 || definition.phases.length > 128) {
    throw new Error("Durable workflow requires 1-128 phases");
  }
  const ids = definition.phases.map((phase) => phase.id.trim());
  if (new Set(ids).size !== ids.length) throw new Error("Durable workflow phase ids must be unique");
  const idSet = new Set(ids);
  const phases = definition.phases.map((phase) => phaseDefinition(phase, idSet));
  assertAcyclic(phases);
  const leaseMs =
    typeof definition.leaseMs === "number" && Number.isFinite(definition.leaseMs)
      ? Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, Math.floor(definition.leaseMs)))
      : 60_000;
  const definitionDigest = digest({
    id,
    name,
    leaseMs,
    phases: phases.map(({ id: phaseId, deps, objectiveDigest, maxAttempts }) => ({
      id: phaseId,
      deps,
      ...(objectiveDigest ? { objectiveDigest } : {}),
      maxAttempts,
    })),
  });
  return {
    format: 1,
    id,
    name,
    definitionDigest,
    status: "queued",
    leaseMs,
    phases,
    createdAt: now,
    updatedAt: now,
  };
};

const clearLease = (phase: DurableWorkflowPhase): void => {
  delete phase.ownerRunId;
  delete phase.ownerTraceId;
  delete phase.ownerSpanId;
  delete phase.leaseToken;
  delete phase.leaseExpiresAt;
};

const refreshReady = (record: DurableWorkflowRecord): void => {
  const completed = new Set(
    record.phases.filter((phase) => phase.status === "completed").map((phase) => phase.id),
  );
  for (const phase of record.phases) {
    if (phase.status === "pending" && phase.deps.every((dep) => completed.has(dep))) {
      phase.status = "ready";
    }
  }
};

const refreshWorkflowStatus = (record: DurableWorkflowRecord): void => {
  if (record.status === "cancelled") return;
  if (record.phases.every((phase) => phase.status === "completed")) {
    record.status = "completed";
    return;
  }
  if (record.phases.some((phase) => phase.status === "failed")) {
    record.status = record.phases.some((phase) => phase.status === "completed")
      ? "partial"
      : "failed";
    return;
  }
  record.status = record.phases.some((phase) => phase.status === "running")
    ? "running"
    : "queued";
};

const releaseExpiredLeases = (record: DurableWorkflowRecord, now: number): void => {
  for (const phase of record.phases) {
    if (
      phase.status !== "running" ||
      phase.leaseExpiresAt === undefined ||
      phase.leaseExpiresAt > now
    ) {
      continue;
    }
    clearLease(phase);
    if (phase.attempt < phase.maxAttempts) {
      phase.status = "ready";
      phase.error = "Previous phase owner lease expired";
    } else {
      phase.status = "failed";
      phase.error = "Durable workflow phase lease expired after its final attempt";
      phase.finishedAt = now;
    }
  }
  refreshReady(record);
  refreshWorkflowStatus(record);
};

const evidenceRefs = (value: readonly DurableWorkflowEvidenceRef[] | undefined): DurableWorkflowEvidenceRef[] | undefined => {
  if (value === undefined) return undefined;
  if (value.length > 32) throw new Error("Durable workflow phase evidence exceeds 32 refs");
  return value.map((entry) => {
    if (!entry.ref.trim() || entry.ref.length > 2_048) {
      throw new Error("Durable workflow evidence ref must be 1-2048 characters");
    }
    return clone(entry);
  });
};

const isRecord = (value: unknown): value is DurableWorkflowRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { format?: unknown }).format === 1 &&
  typeof (value as { id?: unknown }).id === "string" &&
  Array.isArray((value as { phases?: unknown }).phases);

export class DurableWorkflowStore {
  readonly #now: () => number;
  readonly #nextId: () => string;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    options: { now?: () => number; nextId?: () => string } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#nextId = options.nextId ?? randomUUID;
  }

  #key(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid durable workflow id: ${id}`);
    return `workflows/${id}`;
  }

  #record(entry: MeshStateEntry | undefined, id: string): DurableWorkflowRecord {
    if (!entry || !isRecord(entry.value) || entry.value.id !== id) {
      throw new Error(`Unknown durable workflow: ${id}`);
    }
    return clone(entry.value);
  }

  async #mutate<Result>(
    id: string,
    mutate: (record: DurableWorkflowRecord) => Mutation<Result>,
  ): Promise<Result> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const entry = this.mesh.get(this.#key(id));
      const current = this.#record(entry, id);
      const mutation = mutate(current);
      try {
        await this.mesh.put({
          key: this.#key(id),
          value: mutation.record,
          identity: this.identity,
          ifVersion: entry!.version,
        });
        return clone(mutation.result);
      } catch (error) {
        if (!compareAndSwapError(error) || attempt === CAS_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error(`Durable workflow compare-and-swap exhausted: ${id}`);
  }

  async create(definition: DurableWorkflowDefinition): Promise<DurableWorkflowRecord> {
    const candidate = normalizedDefinition(definition, this.#now());
    const key = this.#key(candidate.id);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = this.mesh.get(key);
      if (existing) {
        const record = this.#record(existing, candidate.id);
        if (record.definitionDigest !== candidate.definitionDigest) {
          throw new Error(`Durable workflow definition conflict: ${candidate.id}`);
        }
        return record;
      }
      try {
        const stored = await this.mesh.put({
          key,
          value: candidate,
          identity: this.identity,
          ifVersion: 0,
        });
        return this.#record(stored, candidate.id);
      } catch (error) {
        if (!compareAndSwapError(error) || attempt === CAS_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error(`Durable workflow create compare-and-swap exhausted: ${candidate.id}`);
  }

  async status(id: string): Promise<DurableWorkflowRecord> {
    return this.#record(this.mesh.get(this.#key(id)), id);
  }

  async list(limit = 100): Promise<DurableWorkflowRecord[]> {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const records: DurableWorkflowRecord[] = [];
    for (const entry of this.mesh.listAll("workflows/")) {
      if (!isRecord(entry.value)) continue;
      records.push(clone(entry.value));
      if (records.length >= bounded) break;
    }
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async claim(
    id: string,
    input: {
      ownerRunId: string;
      ownerTraceId?: string;
      ownerSpanId?: string;
      phaseId?: string;
    },
  ): Promise<DurableWorkflowClaim | undefined> {
    const ownerRunId = input.ownerRunId.trim();
    if (!ownerRunId) throw new Error("Durable workflow claim requires ownerRunId");
    return this.#mutate(id, (record) => {
      const now = this.#now();
      releaseExpiredLeases(record, now);
      if (record.status === "completed" || record.status === "cancelled" || record.status === "failed" || record.status === "partial") {
        return { record, result: undefined };
      }
      const phase = input.phaseId
        ? record.phases.find((candidate) => candidate.id === input.phaseId)
        : record.phases.find((candidate) => candidate.status === "ready");
      if (!phase || phase.status !== "ready") return { record, result: undefined };
      const leaseToken = this.#nextId();
      phase.status = "running";
      phase.attempt += 1;
      phase.ownerRunId = ownerRunId;
      if (input.ownerTraceId) phase.ownerTraceId = input.ownerTraceId;
      if (input.ownerSpanId) phase.ownerSpanId = input.ownerSpanId;
      phase.leaseToken = leaseToken;
      phase.leaseExpiresAt = now + record.leaseMs;
      phase.startedAt ??= now;
      delete phase.error;
      record.status = "running";
      record.updatedAt = now;
      return {
        record,
        result: {
          workflowId: record.id,
          leaseToken,
          leaseExpiresAt: phase.leaseExpiresAt,
          phase: clone(phase),
        },
      };
    });
  }

  async resume(id: string): Promise<DurableWorkflowRecord> {
    return this.#mutate(id, (record) => {
      if (record.status === "completed" || record.status === "cancelled") {
        return { record, result: record };
      }
      releaseExpiredLeases(record, this.#now());
      record.updatedAt = this.#now();
      return { record, result: record };
    });
  }

  async fail(
    id: string,
    input: {
      phaseId: string;
      leaseToken: string;
      error: string;
      retryable?: boolean;
    },
  ): Promise<DurableWorkflowRecord> {
    const error = input.error.trim().slice(0, 4_096) || "Durable workflow phase failed";
    return this.#mutate(id, (record) => {
      const phase = record.phases.find((candidate) => candidate.id === input.phaseId);
      if (!phase || phase.status !== "running" || phase.leaseToken !== input.leaseToken) {
        throw new Error(`Stale durable workflow phase failure: ${input.phaseId}`);
      }
      const now = this.#now();
      clearLease(phase);
      phase.error = error;
      if (input.retryable === true && phase.attempt < phase.maxAttempts) {
        phase.status = "ready";
      } else {
        phase.status = "failed";
        phase.finishedAt = now;
      }
      refreshReady(record);
      refreshWorkflowStatus(record);
      record.updatedAt = now;
      return { record, result: record };
    });
  }

  async cancel(id: string, reason?: string): Promise<DurableWorkflowRecord> {
    return this.#mutate(id, (record) => {
      if (record.status === "completed" || record.status === "cancelled") {
        return { record, result: record };
      }
      const now = this.#now();
      for (const phase of record.phases) {
        if (phase.status === "completed") continue;
        phase.status = "cancelled";
        phase.finishedAt = now;
        clearLease(phase);
      }
      record.status = "cancelled";
      record.cancelledAt = now;
      const normalizedReason = reason?.trim().slice(0, 4_096);
      if (normalizedReason) record.cancelReason = normalizedReason;
      record.updatedAt = now;
      return { record, result: record };
    });
  }

  async complete(
    id: string,
    input: {
      phaseId: string;
      leaseToken: string;
      evidence?: DurableWorkflowEvidenceRef[];
      output?: unknown;
    },
  ): Promise<DurableWorkflowRecord> {
    const evidence = evidenceRefs(input.evidence);
    return this.#mutate(id, (record) => {
      const phase = record.phases.find((candidate) => candidate.id === input.phaseId);
      if (!phase || phase.status !== "running" || phase.leaseToken !== input.leaseToken) {
        throw new Error(`Stale durable workflow phase completion: ${input.phaseId}`);
      }
      const now = this.#now();
      phase.status = "completed";
      clearLease(phase);
      phase.finishedAt = now;
      if (evidence) phase.evidence = evidence;
      if (input.output !== undefined) phase.outputDigest = digest(input.output);
      delete phase.error;
      refreshReady(record);
      refreshWorkflowStatus(record);
      record.updatedAt = now;
      return { record, result: record };
    });
  }
}
