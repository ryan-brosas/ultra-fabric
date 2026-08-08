export const MIN_PREWALK_CHECKLIST_ITEMS = 5;
export const MAX_PREWALK_CHECKLIST_ITEMS = 9;
// Easy-path bound: a bounded mid-tier task still hands off to the executor but
// skips deep research, so its checklist carries 2-4 items instead of 5-9.
export const MIN_EASY_PREWALK_CHECKLIST_ITEMS = 2;
export const MAX_EASY_PREWALK_CHECKLIST_ITEMS = 4;
const MAX_PREWALK_CHECKLIST_FIELD_CHARS = 1_000;

// Schema-first planning contract: the accepted checklist is a readable
// projection of this contract, not an independent progression authority.
// Intent states the claimed state transition, references name external
// questions answered through CGC or reference checkouts, localScope names the
// project files, symbols, and codemap cascade refs the change touches,
// invariants must survive, and postconditions must hold after implementation.
export interface FabricPrewalkSchemaReference {
  repository: string;
  question: string;
  evidenceRefs: string[];
}

export interface FabricPrewalkSchemaLocalScope {
  files: string[];
  symbols: string[];
  cascadeRefs: string[];
}

export interface FabricPrewalkSchemaContract {
  intent: string;
  references: FabricPrewalkSchemaReference[];
  localScope: FabricPrewalkSchemaLocalScope;
  invariants: string[];
  postconditions: string[];
}

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
  // Typed Schema-first planning contract. Present on every accepted
  // items-bearing checklist (trivial dispositions remain schema-free); parsed
  // strictly — incomplete or unverified contracts are rejected at planning
  // time.
  schema?: FabricPrewalkSchemaContract;
}

const checklistField = (
  value: unknown,
  field: string,
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
  const record = input as { trivial?: unknown; easy?: unknown; items?: unknown; schema?: unknown };
  if (record.trivial !== undefined) {
    if (typeof record.trivial !== "boolean") {
      throw new Error("Prewalk trivial flag must be a boolean");
    }
    if (record.trivial) {
      if (record.items !== undefined) {
        throw new Error("Prewalk trivial checklist must not carry items");
      }
      if (record.schema !== undefined) {
        throw new Error("Prewalk trivial checklist must not carry a schema contract");
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
  const schema = record.schema;
  if (schema === undefined) {
    throw new Error(
      "Prewalk checklist requires a schema contract for every items-bearing checklist",
    );
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("Prewalk schema contract must be an object");
    }
    const contract = schema as Record<string, unknown>;
    const intent = checklistField(contract.intent, "intent", 0);
    const references = contract.references;
    if (!Array.isArray(references)) {
      throw new Error("Prewalk schema contract requires a references array");
    }
    const parsedReferences = references.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`Prewalk schema reference ${index + 1} must be an object`);
      }
      const ref = entry as Record<string, unknown>;
      const repository = checklistField(ref.repository, "repository", index);
      const question = checklistField(ref.question, "question", index);
      const evidenceRefs = ref.evidenceRefs;
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        throw new Error(`Prewalk schema reference ${index + 1} requires nonempty evidenceRefs`);
      }
      return { repository, question, evidenceRefs: evidenceRefs.map(String) };
    });
    const localScope = contract.localScope;
    if (typeof localScope !== "object" || localScope === null || Array.isArray(localScope)) {
      throw new Error("Prewalk schema contract requires localScope");
    }
    const scope = localScope as Record<string, unknown>;
    const files = scope.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("Prewalk schema contract localScope.files must list at least one project file");
    }
    const symbols = Array.isArray(scope.symbols) ? scope.symbols.map(String) : [];
    const cascadeRefs = Array.isArray(scope.cascadeRefs) ? scope.cascadeRefs.map(String) : [];
    const invariants = contract.invariants;
    if (!Array.isArray(invariants) || invariants.length === 0) {
      throw new Error("Prewalk schema contract requires nonempty invariants");
    }
    const postconditions = contract.postconditions;
    if (!Array.isArray(postconditions) || postconditions.length === 0) {
      throw new Error("Prewalk schema contract requires nonempty postconditions");
    }
    return {
      ...parsed,
      schema: {
        intent,
        references: parsedReferences,
        localScope: { files: files.map(String), symbols, cascadeRefs },
        invariants: invariants.map(String),
        postconditions: postconditions.map(String),
      },
    };
};
