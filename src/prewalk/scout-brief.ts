// Auto-scout brief: a cheap small-model pass that gathers compressed context
// for a non-trivial task before the frontier planning model drafts the plan.
// Pure policy plus an injectable runner seam. The host supplies the actual
// agent run (one-shot manager / AgentsProvider); this module owns the prompt,
// the output bound, and the budget category used for token accounting.
export const SCOUT_BUDGET_CATEGORY = "prewalk:scout";

export interface ScoutRunResult {
  result?: unknown;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export type ScoutRunner = (request: {
  task: string;
  role: "scout" | "explorer";
  maxTokens: number;
  timeoutMs: number;
}) => Promise<ScoutRunResult>;

// Bound the brief so the frontier planning prompt never grows without limit.
// 2k characters is comfortably inside a small prompt block while carrying the
// files, symbols, and one-line observations a scout should return.
const MAX_SCOUT_BRIEF_CHARS = 2000;

const scoutBriefPrompt = (task: string): string =>
  "Read-only context scout. Do not edit any file. Explore the repository and " +
  "return a compressed brief for the task below: up to 8 lines, each line a " +
  "file path with a one-line responsibility note. End with a 2-line summary " +
  "of the blast radius (which files change, which tests cover them).\n\n" +
  "TASK: " + task;

export const buildScoutBrief = (run: ScoutRunResult): string => {
  const raw = String(run.result ?? "").trim();
  if (!raw) return "";
  return raw.length > MAX_SCOUT_BRIEF_CHARS
    ? raw.slice(0, MAX_SCOUT_BRIEF_CHARS) + "\n[scout brief truncated]"
    : raw;
};

// Host adapter: run the cheap scout, bound the brief, and record its token
// spend into the run's budget ledger under the scout category so Slice 8 can
// compare small-model context cost against frontier planning spend.
import { appendBudgetLedger } from "../agents/budget-ledger.js";
import path from "node:path";

const SCOUT_MAX_TOKENS = 512;
const SCOUT_TIMEOUT_MS = 60_000;

export const runScoutBrief = async (
  runner: ScoutRunner,
  task: string,
  runRoot?: string,
): Promise<string> => {
  try {
    const run = await runner({
      task: scoutBriefPrompt(task),
      role: "scout",
      maxTokens: SCOUT_MAX_TOKENS,
      timeoutMs: SCOUT_TIMEOUT_MS,
    });
    const brief = buildScoutBrief(run);
    // Best-effort accounting: never let a ledger failure block arming.
    if (runRoot && run.usage) {
      try {
        const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = run.usage;
        appendBudgetLedger(path.join(runRoot, "budget-ledger.jsonl"), {
          id: "scout-brief",
          depth: 0,
          cost: 0,
          tokens: input + output + cacheRead + cacheWrite,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheWrite,
          persistentAgentName: SCOUT_BUDGET_CATEGORY,
        });
      } catch {
        // Ledger write is best-effort.
      }
    }
    return brief;
  } catch {
    // Scout failure never blocks arming; the frontier plans without the brief.
    return "";
  }
};
