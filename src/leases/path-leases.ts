import fs from "node:fs";
import path from "node:path";
import type { MeshIdentity, MeshStore } from "../mesh/store.js";

export interface FabricPathLease {
  id: string;
  ownerRunId: string;
  path: string;
  scope: "file" | "tree";
  acquiredAt: number;
  expiresAt: number;
}
interface PathLeaseState {
  format: 1;
  leases: FabricPathLease[];
}
interface AcquirePathLeaseInput {
  ownerRunId: string;
  paths: Array<{ path: string; scope: "file" | "tree" }>;
  ttlMs: number;
}
const STATE_KEY = "path-leases/v1";
const isLease = (value: unknown): value is FabricPathLease => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return Object.keys(lease).every((key) =>
    ["id", "ownerRunId", "path", "scope", "acquiredAt", "expiresAt"].includes(key)
  ) && typeof lease.id === "string" && Boolean(lease.id) &&
    typeof lease.ownerRunId === "string" && Boolean(lease.ownerRunId) &&
    typeof lease.path === "string" && path.isAbsolute(lease.path) &&
    (lease.scope === "file" || lease.scope === "tree") &&
    typeof lease.acquiredAt === "number" && Number.isFinite(lease.acquiredAt) &&
    typeof lease.expiresAt === "number" && Number.isFinite(lease.expiresAt);
};
const isState = (value: unknown): value is PathLeaseState =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value as Record<string, unknown>).every((key) => ["format", "leases"].includes(key)) &&
  (value as { format?: unknown }).format === 1 &&
  Array.isArray((value as { leases?: unknown }).leases) &&
  ((value as { leases: unknown[] }).leases).length <= 32 &&
  ((value as { leases: unknown[] }).leases).every(isLease);
const casError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Mesh compare-and-swap failed");
const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const conflicts = (
  left: Pick<FabricPathLease, "path" | "scope">,
  right: Pick<FabricPathLease, "path" | "scope">,
): boolean =>
  left.path === right.path ||
  (left.scope === "tree" && within(left.path, right.path)) ||
  (right.scope === "tree" && within(right.path, left.path));
const canonicalPath = (cwd: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) throw new Error("Path lease path must be 1-4096 characters");
  const resolved = path.resolve(cwd, trimmed.startsWith("@") ? trimmed.slice(1) : trimmed);
  const suffix: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const real = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  return path.normalize(path.join(real, ...suffix));
};

export class PathLeaseStore {
  readonly #now: () => number;
  readonly #nextId: () => string;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    options: { now?: () => number; nextId?: () => string } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#nextId = options.nextId ?? (() => crypto.randomUUID());
  }

  #state(entry = this.mesh.get(STATE_KEY)): PathLeaseState {
    if (!entry) return { format: 1, leases: [] };
    if (!isState(entry.value)) {
      throw new Error(
        "Invalid path lease state; run /fabric leases --release-all to reset it",
      );
    }
    return structuredClone(entry.value);
  }

  #active(state: PathLeaseState): FabricPathLease[] {
    const now = this.#now();
    return state.leases.filter((lease) => lease.expiresAt > now);
  }

  async #mutate<T>(
    update: (state: PathLeaseState) => { state: PathLeaseState; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const entry = this.mesh.get(STATE_KEY);
      const changed = update({ format: 1, leases: this.#active(this.#state(entry)) });
      try {
        await this.mesh.put({
          key: STATE_KEY,
          value: changed.state,
          identity: this.identity,
          ifVersion: entry?.version ?? 0,
        });
        return structuredClone(changed.result);
      } catch (error) {
        if (!casError(error) || attempt === 11) throw error;
      }
    }
    throw new Error("Path lease contention limit reached");
  }

  async acquire(cwd: string, input: AcquirePathLeaseInput): Promise<{ leases: FabricPathLease[] }> {
    const ownerRunId = input.ownerRunId.trim().slice(0, 256);
    if (!ownerRunId) throw new Error("Path lease requires ownerRunId");
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 32) {
      throw new Error("Path lease requires 1-32 paths");
    }
    const ttlMs = Math.max(1_000, Math.min(86_400_000, Math.floor(input.ttlMs)));
    const requested = input.paths.map((entry) => ({
      path: canonicalPath(cwd, entry.path),
      scope: entry.scope === "tree" ? "tree" as const : "file" as const,
    }));
    if (requested.some((entry, index) =>
      requested.some((other, otherIndex) => index !== otherIndex && conflicts(entry, other))
    )) {
      throw new Error("Path lease request contains overlapping paths");
    }
    return this.#mutate((state) => {
      for (const request of requested) {
        const conflict = state.leases.find((lease) =>
          lease.ownerRunId !== ownerRunId && conflicts(lease, request)
        );
        if (conflict) {
          throw new Error(
            `Path lease conflict with ${conflict.id} owned by ${conflict.ownerRunId}: ${conflict.path}`,
          );
        }
      }
      const now = this.#now();
      const acquired = requested.map((request) => {
        const existing = state.leases.find((lease) =>
          lease.ownerRunId === ownerRunId && lease.path === request.path && lease.scope === request.scope
        );
        if (existing) {
          existing.expiresAt = now + ttlMs;
          return existing;
        }
        if (state.leases.length >= 32) {
          throw new Error("Path lease capacity reached (32)");
        }
        const lease: FabricPathLease = {
          id: this.#nextId(),
          ownerRunId,
          ...request,
          acquiredAt: now,
          expiresAt: now + ttlMs,
        };
        state.leases.push(lease);
        return lease;
      });
      return { state, result: { leases: acquired } };
    });
  }

  async release(ownerRunId: string, ids: string[]): Promise<{ released: string[] }> {
    const owner = ownerRunId.trim();
    return this.#mutate((state) => {
      const requested = [...new Set(ids)].slice(0, 32);
      for (const id of requested) {
        const lease = state.leases.find((candidate) => candidate.id === id);
        if (lease && lease.ownerRunId !== owner) {
          throw new Error(`Run ${owner} does not own path lease ${id}`);
        }
      }
      const released = state.leases
        .filter((lease) => requested.includes(lease.id) && lease.ownerRunId === owner)
        .map((lease) => lease.id);
      state.leases = state.leases.filter((lease) => !released.includes(lease.id));
      return { state, result: { released } };
    });
  }

  /**
   * Operator escape hatch: clears leases regardless of owner, and rebuilds
   * unreadable state so a corrupt record cannot permanently block every write.
   */
  async forceRelease(ids?: string[]): Promise<{ released: string[] }> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const entry = this.mesh.get(STATE_KEY);
      const current: PathLeaseState = entry && isState(entry.value)
        ? structuredClone(entry.value)
        : { format: 1, leases: [] };
      const removed = ids
        ? current.leases.filter((lease) => ids.includes(lease.id))
        : current.leases;
      const removedIds = removed.map((lease) => lease.id);
      const next: PathLeaseState = {
        format: 1,
        leases: current.leases.filter((lease) => !removedIds.includes(lease.id)),
      };
      try {
        await this.mesh.put({
          key: STATE_KEY,
          value: next,
          identity: this.identity,
          ifVersion: entry?.version ?? 0,
        });
        return { released: removedIds };
      } catch (error) {
        if (!casError(error) || attempt === 11) throw error;
      }
    }
    throw new Error("Path lease contention limit reached");
  }

  async list(): Promise<FabricPathLease[]> {
    return this.#active(this.#state())
      .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id));
  }

  assertCanWrite(cwd: string, ownerRunId: string, target: string): void {
    const entry = this.mesh.get(STATE_KEY);
    if (!entry) return;
    const foreign = this.#active(this.#state(entry)).filter(
      (lease) => lease.ownerRunId !== ownerRunId,
    );
    // Only canonicalize (filesystem syscalls) once a foreign lease could conflict.
    if (foreign.length === 0) return;
    const write = { path: canonicalPath(cwd, target), scope: "file" as const };
    const conflict = foreign.find((lease) => conflicts(lease, write));
    if (conflict) {
      throw new Error(
        `Path write conflicts with lease ${conflict.id} owned by ${conflict.ownerRunId}: ${conflict.path}`,
      );
    }
  }
}
