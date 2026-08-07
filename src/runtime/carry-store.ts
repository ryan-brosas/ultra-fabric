import { CARRY_MAX_SERIALIZED_CHARS } from "./quickjs-runtime.js";

// Bounded per-session store for the fabric_exec carry namespace: guest state
// survives across fabric_exec calls within a Pi session (the CodeAct REPL
// pattern), keyed by sessionId with LRU eviction beyond the session bound.
// Snapshots are JSON-safe by construction (they come from the sandbox result
// envelope) and returned as defensive copies.

const DEFAULT_MAX_SESSIONS = 8;

const clone = (carry: Record<string, unknown>): Record<string, unknown> =>
  structuredClone(carry);

const withinCap = (carry: Record<string, unknown>): boolean => {
  try {
    return JSON.stringify(carry).length <= CARRY_MAX_SERIALIZED_CHARS;
  } catch {
    return false;
  }
};

export class CarryStore {
  readonly #sessions = new Map<string, Record<string, unknown>>();
  readonly #recency: string[] = [];
  readonly #maxSessions: number;

  constructor(maxSessions: number = DEFAULT_MAX_SESSIONS) {
    this.#maxSessions = Math.max(1, Math.floor(maxSessions));
  }

  snapshot(sessionId: string): Record<string, unknown> {
    const entry = this.#sessions.get(sessionId);
    return entry === undefined ? {} : clone(entry);
  }

  persist(sessionId: string, carry: Record<string, unknown> | undefined): void {
    if (!carry || Object.keys(carry).length === 0) return;
    if (!withinCap(carry)) return;
    if (this.#sessions.has(sessionId)) {
      const existing = this.#recency.indexOf(sessionId);
      if (existing !== -1) this.#recency.splice(existing, 1);
    }
    this.#recency.push(sessionId);
    while (this.#recency.length > this.#maxSessions) {
      const evicted = this.#recency.shift();
      if (evicted !== undefined) this.#sessions.delete(evicted);
    }
    this.#sessions.set(sessionId, clone(carry));
  }

  clear(): void {
    this.#sessions.clear();
    this.#recency.length = 0;
  }
}
