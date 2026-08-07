// Test-support module: detailed budget-ledger rollups. This was previously
// exported from src/agents/budget-ledger.ts but has no production caller, so
// the implementation moved here with its private parse helper.
import fs from "node:fs";
import type { BudgetLedgerEntry } from "../../src/agents/budget-ledger.js";

export interface BudgetLedgerDetail {
  cost: number;
  tokens: number;
  byPersistentAgent: Record<string, { cost: number; tokens: number }>;
  entries: BudgetLedgerEntry[];
}

const parseBudgetLedgerEntry = (value: unknown): BudgetLedgerEntry | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.cost !== "number" ||
    typeof candidate.tokens !== "number" ||
    typeof candidate.ts !== "number"
  ) {
    return undefined;
  }
  return candidate as unknown as BudgetLedgerEntry;
};

/**
 * Sum the append-only ledger with full per-attribution breakdown.
 */
export function readBudgetLedgerDetailed(file: string): BudgetLedgerDetail {
  const detail: BudgetLedgerDetail = {
    cost: 0,
    tokens: 0,
    byPersistentAgent: {},
    entries: [],
  };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return detail;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = parseBudgetLedgerEntry(JSON.parse(line));
      if (!entry) continue;
      detail.cost += Number(entry.cost) || 0;
      detail.tokens += Number(entry.tokens) || 0;
      detail.entries.push(entry);
      if (entry.persistentAgentId) {
        const persistentAgentRollup = (detail.byPersistentAgent[entry.persistentAgentId] ??= { cost: 0, tokens: 0 });
        persistentAgentRollup.cost += entry.cost;
        persistentAgentRollup.tokens += entry.tokens;
      }
    } catch {
      // Ignore malformed cost lines; the ledger is best-effort.
    }
  }
  return detail;
}
