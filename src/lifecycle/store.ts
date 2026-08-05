import type { MeshIdentity, MeshStateEntry, MeshStore } from "../mesh/store.js";

const WORK_PREFIX = "work/";
const ACTIVE_KEY = "work/.active";
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const PHASES = new Set(["research", "create", "plan", "ship", "verify", "done"]);
const STATUSES = new Set(["active", "blocked", "abandoned", "done"]);

export type FabricWorkPhase = "research" | "create" | "plan" | "ship" | "verify" | "done";
export type FabricWorkStatus = "active" | "blocked" | "abandoned" | "done";
export type FabricArtifactName = "research" | "spec" | "plan" | "progress" | "impact";

export interface FabricWorkEvidence {
  phase: string;
  ref: string;
  claim: string;
}

export interface FabricWorkGate {
  gate: string;
  passed: boolean;
  sequence: number;
  recordedAt: number;
}

export interface FabricWorkInput {
  slug: string;
  title: string;
  phase: FabricWorkPhase;
  artifacts?: Partial<Record<FabricArtifactName, string>>;
  inFlight?: string[];
  progress?: string[];
  evidence?: FabricWorkEvidence[];
  gates?: FabricWorkGate[];
  status?: FabricWorkStatus;
}

export interface FabricWorkRecord extends FabricWorkInput {
  format: 1;
  slug: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  artifacts: Partial<Record<FabricArtifactName, string>>;
  inFlight: string[];
  progress: string[];
  evidence: FabricWorkEvidence[];
  gates: FabricWorkGate[];
  status: FabricWorkStatus;
}

const bounded = (value: string, limit = 4_096): string => value.trim().slice(0, limit);
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isPhase = (value: unknown): value is FabricWorkPhase =>
  typeof value === "string" && PHASES.has(value);
const isStatus = (value: unknown): value is FabricWorkStatus =>
  typeof value === "string" && STATUSES.has(value);

const isEvidence = (value: unknown): value is FabricWorkEvidence => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.phase === "string" && Boolean(record.phase) &&
    typeof record.ref === "string" && Boolean(record.ref) &&
    typeof record.claim === "string" && Boolean(record.claim);
};

const isGate = (value: unknown): value is FabricWorkGate => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.gate === "string" && Boolean(record.gate) &&
    typeof record.passed === "boolean" &&
    finiteNonnegative(record.sequence) && finiteNonnegative(record.recordedAt);
};

const isRecord = (value: unknown): value is FabricWorkRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.format === 1 &&
    typeof record.slug === "string" && Boolean(record.slug) &&
    typeof record.title === "string" &&
    isPhase(record.phase) &&
    finiteNonnegative(record.createdAt) &&
    finiteNonnegative(record.updatedAt) &&
    typeof record.progress === "object" && Array.isArray(record.progress) &&
    record.progress.every((item: unknown) => typeof item === "string") &&
    Array.isArray(record.inFlight) && record.inFlight.every((item: unknown) => typeof item === "string") &&
    Array.isArray(record.evidence) && record.evidence.every(isEvidence) &&
    Array.isArray(record.gates) && record.gates.every(isGate) &&
    (record.artifacts === undefined ||
      (typeof record.artifacts === "object" && record.artifacts !== null &&
        !Array.isArray(record.artifacts) &&
        Object.entries(record.artifacts as Record<string, unknown>).every(
          ([k, v]) => typeof k === "string" && typeof v === "string" && Boolean(v)))) &&
    isStatus(record.status);
};

export const sanitizeWorkSlug = (title: string): string => {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Work slug cannot be empty");
  for (const segment of slug.split("/")) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw new Error(`Work slug contains an unsafe segment: ${segment}`);
    }
  }
  return slug;
};

export class FabricWorkStore {
  readonly #mesh: MeshStore;
  readonly #identity: MeshIdentity;
  readonly #now: () => number;
  #maxRecords: number;
  readonly #claimedPhase = new Map<string, FabricWorkPhase>();

  constructor(
    mesh: MeshStore,
    identity: MeshIdentity,
    options: { maxRecords?: number; now?: () => number } = {},
  ) {
    this.#mesh = mesh;
    this.#identity = identity;
    this.#maxRecords = Math.max(1, Math.min(10_000, Math.floor(options.maxRecords ?? 1_000)));
    this.#now = options.now ?? Date.now;
  }

  #key(slug: string): string {
    return `${WORK_PREFIX}${slug}`;
  }

  #from(entry: MeshStateEntry | undefined, slug: string): FabricWorkRecord {
    if (!entry || !isRecord(entry.value) || entry.value.slug !== slug) {
      throw new Error(`Unknown Fabric work record: ${slug}`);
    }
    return structuredClone(entry.value);
  }

  async create(input: FabricWorkInput): Promise<FabricWorkRecord> {
    const slug = sanitizeWorkSlug(input.slug);
    const title = bounded(input.title);
    if (!title) throw new Error("Fabric work record requires a title");
    if (!isPhase(input.phase)) throw new Error(`Invalid work phase: ${input.phase}`);
    const existing = this.#mesh.get(this.#key(slug));
    if (existing) {
      return this.#from(existing, slug);
    }
    if (this.#mesh.listAll(WORK_PREFIX).filter((e) => isRecord(e.value)).length >= this.#maxRecords) {
      throw new Error(`Fabric work ledger capacity reached (${this.#maxRecords})`);
    }
    const now = this.#now();
    const record: FabricWorkRecord = {
      format: 1,
      slug,
      title,
      phase: input.phase,
      createdAt: now,
      updatedAt: now,
      progress: [...(input.progress ?? [])],
      evidence: [...(input.evidence ?? [])],
      gates: [...(input.gates ?? [])],
      status: input.status ?? "active",
      artifacts: { ...(input.artifacts ?? {}) },
      inFlight: [...new Set((input.inFlight ?? []).map((id) => bounded(id, 64)))],
    };
    const stored = await this.#mesh.put({
      key: this.#key(slug), value: record, identity: this.#identity, ifVersion: 0,
    });
    return this.#from(stored, slug);
  }

  get(slug: string): FabricWorkRecord {
    const normalized = sanitizeWorkSlug(slug);
    return this.#from(this.#mesh.get(this.#key(normalized)), normalized);
  }

  async update(slug: string, mutate: (record: FabricWorkRecord) => FabricWorkRecord): Promise<FabricWorkRecord> {
    const normalized = sanitizeWorkSlug(slug);
    const current = this.#from(this.#mesh.get(this.#key(normalized)), normalized);
    const next = mutate(structuredClone(current));
    if (!isPhase(next.phase)) throw new Error(`Invalid work phase: ${next.phase}`);
    next.updatedAt = this.#now();
    const existing = this.#mesh.get(this.#key(normalized));
    const stored = await this.#mesh.put({
      key: this.#key(normalized), value: next, identity: this.#identity,
      ...(existing ? { ifVersion: existing.version } : {}),
    });
    return this.#from(stored, normalized);
  }

  list(): FabricWorkRecord[] {
    return this.#mesh.listAll(WORK_PREFIX)
      .filter((entry) => isRecord(entry.value))
      .map((entry) => structuredClone(entry.value as FabricWorkRecord));
  }

  async setActive(slug: string): Promise<void> {
    const normalized = sanitizeWorkSlug(slug);
    await this.#mesh.put({
      key: ACTIVE_KEY, value: normalized, identity: this.#identity,
    });
  }

  getActive(): string | undefined {
    const entry = this.#mesh.get(ACTIVE_KEY);
    if (!entry || typeof entry.value !== "string") return undefined;
    return entry.value;
  }

  async completeInFlight(slug: string): Promise<FabricWorkRecord> {
    const normalized = sanitizeWorkSlug(slug);
    const current = this.#from(this.#mesh.get(this.#key(normalized)), normalized);
    if (current.inFlight.length === 0) return current;
    const completed = [...new Set([...current.progress, ...current.inFlight])];
    return this.update(normalized, (record) => ({
      ...record,
      inFlight: [],
      progress: completed,
    }));
  }

  claimPhaseContract(sessionId: string): FabricWorkPhase | undefined {
    const slug = this.getActive();
    if (!slug) return undefined;
    let record: FabricWorkRecord;
    try {
      record = this.get(slug);
    } catch {
      return undefined;
    }
    const last = this.#claimedPhase.get(sessionId);
    if (last === record.phase) return undefined;
    this.#claimedPhase.set(sessionId, record.phase);
    return record.phase;
  }
}