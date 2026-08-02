export interface FabricPersistentAgentBudgetInput {
  lifetimeActivations?: number;
  windowActivations?: number;
  windowMs?: number;
}

export interface FabricPersistentAgentBudgetPolicy {
  lifetimeActivations: number;
  windowActivations: number;
  windowMs: number;
}

export type FabricPersistentAgentBudgetRejection = "lifetime_exhausted" | "window_exhausted";

export interface FabricPersistentAgentBudgetUsage {
  lifetimeActivations: number;
  lifetimeTokens: number;
  windowStartedAt: number;
  windowActivations: number;
  windowTokens: number;
  rejectedActivations: number;
  lastRejectedAt?: number;
  lastRejection?: FabricPersistentAgentBudgetRejection;
}

export interface FabricPersistentAgentBudgetSnapshot {
  policy: FabricPersistentAgentBudgetPolicy;
  usage: FabricPersistentAgentBudgetUsage;
  admission: "open" | FabricPersistentAgentBudgetRejection;
}

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

export const normalizePersistentAgentBudgetPolicy = (
  input: FabricPersistentAgentBudgetInput | undefined,
): FabricPersistentAgentBudgetPolicy => ({
  lifetimeActivations: boundedInteger(input?.lifetimeActivations, 0, 0, 1_000_000),
  windowActivations: boundedInteger(input?.windowActivations, 0, 0, 1_000_000),
  windowMs: boundedInteger(input?.windowMs, 3_600_000, 1_000, 30 * 86_400_000),
});

export const createPersistentAgentBudgetUsage = (now: number): FabricPersistentAgentBudgetUsage => ({
  lifetimeActivations: 0,
  lifetimeTokens: 0,
  windowStartedAt: now,
  windowActivations: 0,
  windowTokens: 0,
  rejectedActivations: 0,
});

const currentWindow = (
  policy: FabricPersistentAgentBudgetPolicy,
  usage: FabricPersistentAgentBudgetUsage,
  now: number,
): FabricPersistentAgentBudgetUsage =>
  now < usage.windowStartedAt || now - usage.windowStartedAt >= policy.windowMs
    ? {
        ...usage,
        windowStartedAt: now,
        windowActivations: 0,
        windowTokens: 0,
      }
    : { ...usage };

const rejection = (
  policy: FabricPersistentAgentBudgetPolicy,
  usage: FabricPersistentAgentBudgetUsage,
): FabricPersistentAgentBudgetRejection | undefined => {
  if (
    policy.lifetimeActivations > 0 &&
    usage.lifetimeActivations >= policy.lifetimeActivations
  ) {
    return "lifetime_exhausted";
  }
  if (
    policy.windowActivations > 0 &&
    usage.windowActivations >= policy.windowActivations
  ) {
    return "window_exhausted";
  }
  return undefined;
};

export const admitPersistentAgentActivation = (
  policy: FabricPersistentAgentBudgetPolicy,
  usage: FabricPersistentAgentBudgetUsage,
  now: number,
):
  | { ok: true; usage: FabricPersistentAgentBudgetUsage }
  | { ok: false; reason: FabricPersistentAgentBudgetRejection; usage: FabricPersistentAgentBudgetUsage } => {
  const current = currentWindow(policy, usage, now);
  const reason = rejection(policy, current);
  if (reason) {
    return {
      ok: false,
      reason,
      usage: {
        ...current,
        rejectedActivations: current.rejectedActivations + 1,
        lastRejectedAt: now,
        lastRejection: reason,
      },
    };
  }
  return {
    ok: true,
    usage: {
      ...current,
      lifetimeActivations: current.lifetimeActivations + 1,
      windowActivations: current.windowActivations + 1,
    },
  };
};

export const restorePersistentAgentBudgetUsage = (
  value: unknown,
  now: number,
): FabricPersistentAgentBudgetUsage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createPersistentAgentBudgetUsage(now);
  }
  const record = value as Partial<FabricPersistentAgentBudgetUsage>;
  const lastRejection =
    record.lastRejection === "lifetime_exhausted" ||
    record.lastRejection === "window_exhausted"
      ? record.lastRejection
      : undefined;
  return {
    lifetimeActivations: boundedInteger(
      record.lifetimeActivations,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    lifetimeTokens: boundedInteger(record.lifetimeTokens, 0, 0, Number.MAX_SAFE_INTEGER),
    windowStartedAt:
      typeof record.windowStartedAt === "number" && Number.isFinite(record.windowStartedAt)
        ? Math.floor(record.windowStartedAt)
        : now,
    windowActivations: boundedInteger(
      record.windowActivations,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    windowTokens: boundedInteger(record.windowTokens, 0, 0, Number.MAX_SAFE_INTEGER),
    rejectedActivations: boundedInteger(
      record.rejectedActivations,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(typeof record.lastRejectedAt === "number" && Number.isFinite(record.lastRejectedAt)
      ? { lastRejectedAt: Math.floor(record.lastRejectedAt) }
      : {}),
    ...(lastRejection ? { lastRejection } : {}),
  };
};

export const recordPersistentAgentTokens = (
  policy: FabricPersistentAgentBudgetPolicy,
  usage: FabricPersistentAgentBudgetUsage,
  tokens: number,
  now: number,
): FabricPersistentAgentBudgetUsage => {
  const current = currentWindow(policy, usage, now);
  const amount = boundedInteger(tokens, 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    ...current,
    lifetimeTokens: current.lifetimeTokens + amount,
    windowTokens: current.windowTokens + amount,
  };
};

export interface FabricPersistentAgentBudgetTelemetry {
  persistentAgents: number;
  open: number;
  lifetimeExhausted: number;
  windowExhausted: number;
  lifetimeActivations: number;
  lifetimeTokens: number;
  rejectedActivations: number;
}

export const summarizePersistentAgentBudgets = (
  snapshots: readonly FabricPersistentAgentBudgetSnapshot[],
): FabricPersistentAgentBudgetTelemetry => ({
  persistentAgents: snapshots.length,
  open: snapshots.filter((snapshot) => snapshot.admission === "open").length,
  lifetimeExhausted: snapshots.filter(
    (snapshot) => snapshot.admission === "lifetime_exhausted",
  ).length,
  windowExhausted: snapshots.filter(
    (snapshot) => snapshot.admission === "window_exhausted",
  ).length,
  lifetimeActivations: snapshots.reduce(
    (total, snapshot) => total + snapshot.usage.lifetimeActivations,
    0,
  ),
  lifetimeTokens: snapshots.reduce(
    (total, snapshot) => total + snapshot.usage.lifetimeTokens,
    0,
  ),
  rejectedActivations: snapshots.reduce(
    (total, snapshot) => total + snapshot.usage.rejectedActivations,
    0,
  ),
});

export const persistentAgentBudgetSnapshot = (
  policy: FabricPersistentAgentBudgetPolicy,
  usage: FabricPersistentAgentBudgetUsage,
  now: number,
): FabricPersistentAgentBudgetSnapshot => {
  const current = currentWindow(policy, usage, now);
  return {
    policy: { ...policy },
    usage: current,
    admission: rejection(policy, current) ?? "open",
  };
};
