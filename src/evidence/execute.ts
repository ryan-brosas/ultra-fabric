import {
  buildPlan,
  classifyIntent,
  type EvidenceHealth,
  type EvidenceIntent,
  type EvidencePlan,
  type RouteOverrides,
} from "./route.js";
import type { EvidenceToolShape } from "./classify.js";

// Plan executor with dependency injection: the adapter supplies the real
// call implementation and a record callback that feeds the health map.
// No direct I/O imports; effects live at the adapter.

export type EvidenceExec = (server: string, tool: string) => Promise<unknown>;
export type EvidenceRecord = (tool: string, success: boolean, elapsedMs: number) => void;

export interface AttemptProvenance {
  server: string;
  tool: string;
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

export interface EvidenceOutcome {
  results: unknown;
  provenance: { intent: string; attempts: AttemptProvenance[] };
}

export const executePlan = async (
  plan: EvidencePlan,
  exec: EvidenceExec,
  record: EvidenceRecord,
): Promise<EvidenceOutcome> => {
  const attempts: AttemptProvenance[] = [];
  for (const a of plan.attempts) {
    const t0 = Date.now();
    try {
      const results = await exec(a.server, a.tool);
      const elapsedMs = Date.now() - t0;
      attempts.push({ server: a.server, tool: a.tool, ok: true, elapsedMs });
      record(a.tool, true, elapsedMs);
      return { results, provenance: { intent: plan.intent, attempts } };
    } catch (error) {
      const elapsedMs = Date.now() - t0;
      attempts.push({
        server: a.server,
        tool: a.tool,
        ok: false,
        elapsedMs,
        error: error instanceof Error ? error.message : String(error),
      });
      record(a.tool, false, elapsedMs);
    }
  }
  return { results: undefined, provenance: { intent: plan.intent, attempts } };
};

// Intent -> call-args shaping (pure policy).
export const argsForIntent = (intent: EvidenceIntent, query: string): Record<string, unknown> => {
  switch (intent) {
    case "web-fetch":
      return { url: query };
    case "repo-wiki": {
      const m = query.match(/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/i);
      return m ? { repoName: m[1], question: query } : { question: query };
    }
    default:
      return { query };
  }
};

export interface SearchOutcome {
  intent: EvidenceIntent;
  results: unknown;
  provenance: { intent: string; attempts: AttemptProvenance[] };
  toolsAvailable: number;
}

// Orchestration with dependency injection: the adapter supplies enumeration,
// execution, and health recording; policy stays in src/evidence.
export const runSearchWithDeps = async (
  query: string,
  enumerate: () => Promise<EvidenceToolShape[]>,
  health: ReadonlyMap<string, EvidenceHealth>,
  overrides: RouteOverrides,
  options: { maxAttempts?: number; timeoutMs?: number },
  exec: EvidenceExec,
  record: EvidenceRecord,
): Promise<SearchOutcome> => {
  const tools = await enumerate();
  const intent = classifyIntent(query);
  const plan: EvidencePlan = buildPlan(intent, tools, health, overrides, options);
  const out = await executePlan(plan, exec, record);
  return { intent, results: out.results, provenance: out.provenance, toolsAvailable: tools.length };
};
