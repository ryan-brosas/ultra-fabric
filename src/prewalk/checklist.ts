export const MIN_PREWALK_CHECKLIST_ITEMS = 5;
export const MAX_PREWALK_CHECKLIST_ITEMS = 9;
// Easy-path bound: a bounded mid-tier task still hands off to the executor but
// skips deep research, so its checklist carries 2-4 items instead of 5-9.
export const MIN_EASY_PREWALK_CHECKLIST_ITEMS = 2;
export const MAX_EASY_PREWALK_CHECKLIST_ITEMS = 4;
const MAX_PREWALK_CHECKLIST_FIELD_CHARS = 1_000;

interface FabricPrewalkChecklistItem {
  task: string;
  validation: string;
}

export interface FabricPrewalkChecklist {
  items: FabricPrewalkChecklistItem[];
  readyAt: number;
  // 0-based indexes of items the executor marked complete via [DONE:n]
  // markers in its turn text. Kept separate from items so the plan text
  // stays intact; the reminder and progress widget read only this.
  doneIndexes?: number[];
  // Trivial-path escape: a task that clearly fits in one or two small edits
  // records the trivial disposition through the same checklist call, so the
  // controller suppresses the mutation boundary and the executor handoff
  // instead of forcing the 5-9 item ceremony and a model swap.
  trivial?: boolean;
  // Easy-path router: a bounded mid-tier task still hands off to the executor
  // (unlike trivial) but relaxes the planning ceremony to 2-4 items so Main
  // skips deep research on it.
  easy?: boolean;
}

const checklistField = (
  value: unknown,
  field: keyof FabricPrewalkChecklistItem,
  index: number,
): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Prewalk checklist item ${index + 1} requires a concrete ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_PREWALK_CHECKLIST_FIELD_CHARS) {
    throw new Error(
      `Prewalk checklist item ${index + 1} ${field} exceeds ${MAX_PREWALK_CHECKLIST_FIELD_CHARS} characters`,
    );
  }
  return normalized;
};

export interface ChecklistSafetyWarning {
  item: number; // 1-based item index
  pattern: string;
}

// Warn-only destructive-pattern scan over checklist item text. Flags only
// unambiguous commands that a plan should never carry; the host surfaces the
// warnings to Main but never rejects the checklist on them.
const SAFETY_PATTERNS: Array<{ pattern: string; test: RegExp }> = [
  { pattern: "--no-verify", test: /--no-verify\b/i },
  { pattern: "reset --hard", test: /git\s+reset\s+--hard\b/i },
  { pattern: "clean -fd", test: /git\s+clean\s+-\S*f\S*/i },
  { pattern: "force push", test: /--force(?!-with-lease)\b|\bpush\s+-f\b|force\s+push/i },
{ pattern: "bare git add", test: /git\s+add\s+(-A|-all|\.)\s*(?=then\b|and\b|,|;|$)/i },
];

export const scanChecklistSafety = (checklist: FabricPrewalkChecklist): ChecklistSafetyWarning[] => {
  const warnings: ChecklistSafetyWarning[] = [];
  checklist.items.forEach((item, index) => {
const text = item.task + "\n" + item.validation;
    for (const { pattern, test } of SAFETY_PATTERNS) {
      if (test.test(text)) {
        warnings.push({ item: index + 1, pattern });
      }
    }
  });
  return warnings;
};

export const parsePrewalkChecklist = (
  input: unknown,
  readyAt = Date.now(),
): FabricPrewalkChecklist => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Prewalk checklist requires an object with an items array");
  }
  const record = input as { trivial?: unknown; easy?: unknown; items?: unknown };
  if (record.trivial !== undefined) {
    if (typeof record.trivial !== "boolean") {
      throw new Error("Prewalk trivial flag must be a boolean");
    }
    if (record.trivial) {
      if (record.items !== undefined) {
        throw new Error("Prewalk trivial checklist must not carry items");
      }
      return { items: [], readyAt, trivial: true };
    }
    // trivial: false falls through to the item contract.
  }
  const easy = record.easy;
  if (easy !== undefined && typeof easy !== "boolean") {
    throw new Error("Prewalk easy flag must be a boolean");
  }
  // trivial: true returns above, so an easy checklist can never also be trivial.
  const items = record.items;
  const min = easy === true ? MIN_EASY_PREWALK_CHECKLIST_ITEMS : MIN_PREWALK_CHECKLIST_ITEMS;
  const max = easy === true ? MAX_EASY_PREWALK_CHECKLIST_ITEMS : MAX_PREWALK_CHECKLIST_ITEMS;
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    throw new Error(
      `Prewalk checklist requires between ${min} and ${max} items`,
    );
  }
  const parsed = {
    items: items.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`Prewalk checklist item ${index + 1} must be an object`);
      }
      const entry = item as Record<string, unknown>;
      return {
        task: checklistField(entry.task, "task", index),
        validation: checklistField(entry.validation, "validation", index),
      };
    }),
    readyAt,
    ...(easy === true ? { easy: true } : {}),
  };
  return parsed;
};
