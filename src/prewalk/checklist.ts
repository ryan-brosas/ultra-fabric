export const MIN_PREWALK_CHECKLIST_ITEMS = 5;
export const MAX_PREWALK_CHECKLIST_ITEMS = 9;
const MAX_PREWALK_CHECKLIST_FIELD_CHARS = 1_000;

interface FabricPrewalkChecklistItem {
  task: string;
  validation: string;
}

export interface FabricPrewalkChecklist {
  items: FabricPrewalkChecklistItem[];
  readyAt: number;
  // Trivial-path escape: a task that clearly fits in one or two small edits
  // records the trivial disposition through the same checklist call, so the
  // controller suppresses the mutation boundary and the executor handoff
  // instead of forcing the 5-9 item ceremony and a model swap.
  trivial?: boolean;
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

export const parsePrewalkChecklist = (
  input: unknown,
  readyAt = Date.now(),
): FabricPrewalkChecklist => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Prewalk checklist requires an object with an items array");
  }
  const record = input as { trivial?: unknown; items?: unknown };
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
    // trivial: false falls through to the full item contract.
  }
  const items = record.items;
  if (
    !Array.isArray(items) ||
    items.length < MIN_PREWALK_CHECKLIST_ITEMS ||
    items.length > MAX_PREWALK_CHECKLIST_ITEMS
  ) {
    throw new Error(
      `Prewalk checklist requires between ${MIN_PREWALK_CHECKLIST_ITEMS} and ${MAX_PREWALK_CHECKLIST_ITEMS} items`,
    );
  }
  return {
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
  };
};
