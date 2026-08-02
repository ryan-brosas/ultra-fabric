export interface FabricActorBudgetInput {
  lifetimeActivations?: number;
  windowActivations?: number;
  windowMs?: number;
}

export interface FabricActorBudgetPolicy {
  lifetimeActivations: number;
  windowActivations: number;
  windowMs: number;
}

export type FabricActorBudgetRejection = "lifetime_exhausted" | "window_exhausted";

export interface FabricActorBudgetUsage {
  lifetimeActivations: number;
  lifetimeTokens: number;
  windowStartedAt: number;
  windowActivations: number;
  windowTokens: number;
  rejectedActivations: number;
  lastRejectedAt?: number;
  lastRejection?: FabricActorBudgetRejection;
}

export interface FabricActorBudgetSnapshot {
  policy: FabricActorBudgetPolicy;
  usage: FabricActorBudgetUsage;
  admission: "open" | FabricActorBudgetRejection;
}

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

export const normalizeActorBudgetPolicy = (
  input: FabricActorBudgetInput | undefined,
): FabricActorBudgetPolicy => ({
  lifetimeActivations: boundedInteger(input?.lifetimeActivations, 0, 0, 1_000_000),
  windowActivations: boundedInteger(input?.windowActivations, 0, 0, 1_000_000),
  windowMs: boundedInteger(input?.windowMs, 3_600_000, 1_000, 30 * 86_400_000),
});

export const createActorBudgetUsage = (now: number): FabricActorBudgetUsage => ({
  lifetimeActivations: 0,
  lifetimeTokens: 0,
  windowStartedAt: now,
  windowActivations: 0,
  windowTokens: 0,
  rejectedActivations: 0,
});

const currentWindow = (
  policy: FabricActorBudgetPolicy,
  usage: FabricActorBudgetUsage,
  now: number,
): FabricActorBudgetUsage =>
  now < usage.windowStartedAt || now - usage.windowStartedAt >= policy.windowMs
    ? {
        ...usage,
        windowStartedAt: now,
        windowActivations: 0,
        windowTokens: 0,
      }
    : { ...usage };

const rejection = (
  policy: FabricActorBudgetPolicy,
  usage: FabricActorBudgetUsage,
): FabricActorBudgetRejection | undefined => {
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

export const admitActorActivation = (
  policy: FabricActorBudgetPolicy,
  usage: FabricActorBudgetUsage,
  now: number,
):
  | { ok: true; usage: FabricActorBudgetUsage }
  | { ok: false; reason: FabricActorBudgetRejection; usage: FabricActorBudgetUsage } => {
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

export const restoreActorBudgetUsage = (
  value: unknown,
  now: number,
): FabricActorBudgetUsage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createActorBudgetUsage(now);
  }
  const record = value as Partial<FabricActorBudgetUsage>;
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

export const recordActorTokens = (
  policy: FabricActorBudgetPolicy,
  usage: FabricActorBudgetUsage,
  tokens: number,
  now: number,
): FabricActorBudgetUsage => {
  const current = currentWindow(policy, usage, now);
  const amount = boundedInteger(tokens, 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    ...current,
    lifetimeTokens: current.lifetimeTokens + amount,
    windowTokens: current.windowTokens + amount,
  };
};

export interface FabricActorBudgetTelemetry {
  actors: number;
  open: number;
  lifetimeExhausted: number;
  windowExhausted: number;
  lifetimeActivations: number;
  lifetimeTokens: number;
  rejectedActivations: number;
}

export const summarizeActorBudgets = (
  snapshots: readonly FabricActorBudgetSnapshot[],
): FabricActorBudgetTelemetry => ({
  actors: snapshots.length,
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

export const actorBudgetSnapshot = (
  policy: FabricActorBudgetPolicy,
  usage: FabricActorBudgetUsage,
  now: number,
): FabricActorBudgetSnapshot => {
  const current = currentWindow(policy, usage, now);
  return {
    policy: { ...policy },
    usage: current,
    admission: rejection(policy, current) ?? "open",
  };
};
