import { classifyToolCapability, type EvidenceCapability, type EvidenceToolShape } from "./classify.js";

// Evidence routing: pure plan builder. Intent classification, capability
// matching, and health/LRU-ranked tool selection with pin/deny/weight
// overrides. No I/O; the adapter executes the plan.

export type EvidenceIntent = Exclude<EvidenceCapability, "health" | "none">;

export interface EvidenceHealth {
  successRate: number;
  lastUsedAt: number;
  usedCount: number;
}

export interface RouteOverrides {
  pin?: readonly string[];
  deny?: readonly string[];
  weights?: Readonly<Record<string, number>>;
}

export interface EvidenceAttempt {
  tool: string;
  server: string;
  timeoutMs: number;
}

export interface EvidencePlan {
  intent: EvidenceIntent;
  attempts: EvidenceAttempt[];
}

export interface PlanOptions {
  maxAttempts?: number;
  timeoutMs?: number;
}

const URL_RE = /^https?:\/\//i;
const REPO_RE = /(github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+|\brepository\b|\brepo\b)/i;
const DOCS_RE = /(documentation|\bdocs\b|library|reference|guide)/i;

export const classifyIntent = (query: string): EvidenceIntent => {
  const q = query.trim();
  if (URL_RE.test(q)) return "web-fetch";
  if (REPO_RE.test(q)) return "repo-wiki";
  if (DOCS_RE.test(q)) return "docs-search";
  return "web-search";
};

const serverOf = (tool: string): string => {
  const sep = tool.indexOf(".");
  return sep > 0 ? tool.slice(0, sep) : tool;
};

export const buildPlan = (
  intent: EvidenceIntent,
  tools: readonly EvidenceToolShape[],
  health: ReadonlyMap<string, EvidenceHealth>,
  overrides: RouteOverrides = {},
  options: PlanOptions = {},
): EvidencePlan => {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const denied = new Set(overrides.deny ?? []);
  const pin = overrides.pin ?? [];
  const capable = tools.filter((t) => classifyToolCapability(t) === intent && !denied.has(t.name));
  const pinned = capable
    .filter((t) => pin.includes(t.name))
    .map((t) => ({ tool: t, eff: overrides.weights?.[t.name] ?? 1, lru: health.get(t.name)?.lastUsedAt ?? 0 }));
  const rest = capable
    .filter((t) => !pin.includes(t.name))
    .map((t) => ({
      tool: t,
      eff: (overrides.weights?.[t.name] ?? 1) * (health.get(t.name)?.successRate ?? 1),
      lru: health.get(t.name)?.lastUsedAt ?? 0,
    }))
    .sort((a, b) => b.eff - a.eff || a.lru - b.lru);
  const ordered = [...pinned, ...rest].slice(0, maxAttempts);
  return {
    intent,
    attempts: ordered.map((c) => ({ tool: c.tool.name, server: serverOf(c.tool.name), timeoutMs })),
  };
};

export const updateHealth = (
  health: ReadonlyMap<string, EvidenceHealth>,
  tool: string,
  success: boolean,
  now: number,
  alpha = 0.3,
): Map<string, EvidenceHealth> => {
  const prev = health.get(tool) ?? { successRate: 1, lastUsedAt: 0, usedCount: 0 };
  const next: EvidenceHealth = {
    successRate: prev.successRate * (1 - alpha) + (success ? 1 : 0) * alpha,
    lastUsedAt: now,
    usedCount: prev.usedCount + 1,
  };
  const out = new Map(health);
  out.set(tool, next);
  return out;
};
