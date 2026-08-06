import fs from "node:fs";
import path from "node:path";
import type { FabricPrewalkChecklist } from "./checklist.js";

// Bounded durable memory of accepted checklists keyed by task text. Seeded at
// arm time so Main adapts a prior plan instead of re-deriving it. A plain
// JSON file under the runtime state dir keeps this independent of the outcomes
// store schema (objective digests, gate verdicts) which has no checklist shape.
export const CHECKLIST_MEMORY_FILE = "prewalk-checklists.json";

// Shared directory derivation so recording and seeding land in the same place.
export const prewalkMemoryDir = (runRoot?: string): string =>
  path.dirname(runRoot ?? path.join(process.cwd(), ".pi", "fabric"));
const MAX_SEEDED_TASKS = 16;
const MAX_TASK_CHARS = 4_000;
const MAX_ITEMS_PER_SEED = 4;
const MAX_ITEM_CHARS = 300;

export interface ChecklistMemoryEntry {
  task: string;
  checklist: FabricPrewalkChecklist;
  recordedAt: number;
}

const readMemory = (dir: string): ChecklistMemoryEntry[] => {
  try {
    const raw = fs.readFileSync(path.join(dir, CHECKLIST_MEMORY_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry: unknown): entry is ChecklistMemoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ChecklistMemoryEntry).task === "string" &&
        typeof (entry as ChecklistMemoryEntry).checklist === "object" &&
        typeof (entry as ChecklistMemoryEntry).recordedAt === "number",
    );
  } catch {
    return [];
  }
};

const writeMemory = (dir: string, entries: ChecklistMemoryEntry[]): void => {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, CHECKLIST_MEMORY_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, path.join(dir, CHECKLIST_MEMORY_FILE));
};

const taskTokens = (text: string): Set<string> => {
  const normalized = text.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
  return new Set(normalized.split(" ").filter(Boolean));
};

const overlap = (a: Set<string>, b: Set<string>): { score: number; shared: number } => {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return {
    score: a.size === 0 ? 0 : shared / Math.sqrt(a.size * b.size),
    shared,
  };
};

const summarize = (checklist: FabricPrewalkChecklist): string =>
  checklist.items
    .slice(0, MAX_ITEMS_PER_SEED)
    .map((item) => `- ${item.task.slice(0, MAX_ITEM_CHARS)}`)
    .join("\n");

export const recordChecklist = (
  dir: string,
  task: string | undefined,
  checklist: FabricPrewalkChecklist,
): void => {
  if (!task || task.length > MAX_TASK_CHARS) return;
  if (checklist.trivial === true || (checklist.items.length === 0)) return;
  const entries = readMemory(dir).filter(
    (entry) => entry.task !== task || entry.recordedAt !== checklist.readyAt,
  );
  // Monotonic recordedAt: a tight loop of settlements can share a millisecond,
  // which would make the newest-entry bound nondeterministic.
  const previousLatest = entries.reduce((max, entry) => Math.max(max, entry.recordedAt), 0);
  const recordedAt = Math.max(Date.now(), previousLatest + 1);
  entries.push({ task, checklist: structuredClone(checklist), recordedAt });
  entries.sort((a, b) => b.recordedAt - a.recordedAt);
  writeMemory(dir, entries.slice(0, MAX_SEEDED_TASKS));
};

export const nearestChecklist = (
  dir: string,
  task: string,
): ChecklistMemoryEntry | undefined => {
  const tokens = taskTokens(task);
  if (tokens.size === 0) return undefined;
  let best: ChecklistMemoryEntry | undefined;
  let bestScore = 0;
  let sharedTokens = 0;
  for (const entry of readMemory(dir)) {
    const hit = overlap(tokens, taskTokens(entry.task));
    if (hit.score > bestScore) {
      bestScore = hit.score;
      sharedTokens = hit.shared;
      best = entry;
    }
  }
  return bestScore >= 0.3 && sharedTokens >= 2 ? best : undefined;
};

// Adapt-don't-rederive seed text appended to the armed prompt. Bounded so a
// stale or oversized memory can never bloat the planning context.
export const checklistSeed = (
  entry: ChecklistMemoryEntry,
): string => [
  "A prior accepted checklist for a similar task is available; adapt it to the current task instead of re-deriving from scratch:",
  entry.task.slice(0, MAX_TASK_CHARS),
  summarize(entry.checklist),
].join("\n");
