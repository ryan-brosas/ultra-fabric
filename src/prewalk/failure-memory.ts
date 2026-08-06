import fs from "node:fs";
import path from "node:path";

// Bounded durable memory of gate-failure patterns keyed by task text. Seeded at
// arm time (when prewalk.failureMemory is on) so the planning phase inherits the
// failure modes of similar prior tasks — the prospective-distillation half of
// PreFlect + Reflexion: failures from past executions sharpen the next checklist
// instead of being forgotten. A plain JSON file under the runtime state dir
// keeps this independent of the outcomes-store schema.
export const FAILURE_MEMORY_FILE = "prewalk-failures.json";

export type FailureKind = "gate-abort" | "revision-exhausted";

export interface FailurePattern {
  task: string;
  kind: FailureKind;
  gate: string;
  feedback: string;
  recordedAt: number;
}

const MAX_PATTERNS = 32;
const MAX_TASK_CHARS = 4_000;
const MAX_SEEDED_PATTERNS = 4;
const MAX_FEEDBACK_CHARS = 300;
// Recall floor: minimum weighted overlap (one path token or two plain
// keywords) and a minimum cosine score, mirroring the accepted-checklist
// matcher so unrelated tasks never seed.
const MIN_SCORE = 0.3;
const MIN_SHARED = 2;

export const prewalkFailureDir = (runRoot?: string): string =>
  path.dirname(runRoot ?? path.join(process.cwd(), ".pi", "fabric"));

const readFailures = (dir: string): FailurePattern[] => {
  try {
    const raw = fs.readFileSync(path.join(dir, FAILURE_MEMORY_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry: unknown): entry is FailurePattern =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as FailurePattern).task === "string" &&
        (entry as FailurePattern).kind === "gate-abort" ||
        (entry as FailurePattern).kind === "revision-exhausted" &&
        typeof (entry as FailurePattern).feedback === "string" &&
        typeof (entry as FailurePattern).recordedAt === "number",
    );
  } catch {
    return [];
  }
};

const writeFailures = (dir: string, entries: FailurePattern[]): void => {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, FAILURE_MEMORY_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, path.join(dir, FAILURE_MEMORY_FILE));
};

const taskTokens = (text: string): Set<string> => {
  const normalized = text.toLowerCase().replace(/[^a-z0-9_./-]+/g, " ").trim();
  return new Set(normalized.split(/\s+/).filter(Boolean));
};

// Path tokens (contain "/" or "." — real file references like src/config.ts)
// are the highest-signal overlap: two tasks touching the same file are related
// even when their verb lists differ. Weight them so a single shared path
// crosses the recall floor while generic keyword overlap still needs more hits.
const PATH_TOKEN = /[./]/;
const overlap = (a: Set<string>, b: Set<string>): { score: number; shared: number } => {
  let weighted = 0;
  for (const token of a) {
    if (!b.has(token)) continue;
    weighted += PATH_TOKEN.test(token) ? 2 : 1;
  }
  const denom = Math.sqrt(a.size * b.size);
  return { score: denom === 0 ? 0 : weighted / denom, shared: weighted };
};

// Record a gate failure pattern keyed by task. Bounded by recency: the newest
// entries survive the cap. Trivial tasks never reach the gate, so nothing here
// filters on triviality — the caller decides what counts as a failure.
export const recordFailure = (
  dir: string,
  task: string | undefined,
  pattern: { kind: FailureKind; gate: string; feedback: string },
): void => {
  if (!task || task.length > MAX_TASK_CHARS) return;
  const entries = readFailures(dir);
  const previousLatest = entries.reduce((max, entry) => Math.max(max, entry.recordedAt), 0);
  entries.push({
    task,
    kind: pattern.kind,
    gate: pattern.gate.slice(0, MAX_FEEDBACK_CHARS),
    feedback: pattern.feedback.slice(0, MAX_FEEDBACK_CHARS),
    recordedAt: Math.max(Date.now(), previousLatest + 1),
  });
  entries.sort((a, b) => b.recordedAt - a.recordedAt);
  writeFailures(dir, entries.slice(0, MAX_PATTERNS));
};

// Recall the most relevant failure patterns for a task, newest-first among
// ties. Zero model tokens: pure keyword/path overlap over the bounded store.
export const nearestFailures = (
  dir: string,
  task: string,
  limit = MAX_SEEDED_PATTERNS,
): FailurePattern[] => {
  const tokens = taskTokens(task);
  if (tokens.size === 0) return [];
  const scored = readFailures(dir)
    .map((entry) => ({ entry, ...overlap(tokens, taskTokens(entry.task)) }))
    .filter((hit) => hit.score >= MIN_SCORE && hit.shared >= MIN_SHARED)
    .sort((a, b) => b.score - a.score || b.entry.recordedAt - a.entry.recordedAt);
  return scored.slice(0, limit).map((hit) => hit.entry);
};

// Bounded seed block appended to the armed prompt so the planning phase
// inherits prior failure modes instead of re-discovering them.
export const failureSeed = (patterns: readonly FailurePattern[]): string => {
  if (patterns.length === 0) return "";
  const lines = patterns
    .slice(0, MAX_SEEDED_PATTERNS)
    .map(
      (p) =>
        `- ${p.kind} (${p.gate}): ${p.feedback.slice(0, MAX_FEEDBACK_CHARS)}`,
    )
    .join("\n");
  return [
    "Prior failures on similar tasks; plan to avoid repeating them:",
    lines,
  ].join("\n");
};
