import { describe, expect, it } from "vitest";
import {
  MAX_EASY_PREWALK_CHECKLIST_ITEMS,
  MAX_PREWALK_CHECKLIST_ITEMS,
  MIN_EASY_PREWALK_CHECKLIST_ITEMS,
  MIN_PREWALK_CHECKLIST_ITEMS,
  parsePrewalkChecklist,
  scanChecklistSafety,
} from "../src/prewalk/checklist.js";

const items = (count = MIN_PREWALK_CHECKLIST_ITEMS) =>
  Array.from({ length: count }, (_, index) => ({
    task: `  Change target ${index + 1}  `,
    validation: `  Run check ${index + 1}  `,
  }));

describe("parsePrewalkChecklist", () => {
  it("accepts and normalizes a bounded planning-and-validation checklist", () => {
    expect(parsePrewalkChecklist({ items: items() }, 42)).toEqual({
      items: Array.from({ length: MIN_PREWALK_CHECKLIST_ITEMS }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
      readyAt: 42,
    });
  });

  it("rejects lists outside the research protocol item bound", () => {
    expect(() => parsePrewalkChecklist({ items: items(MIN_PREWALK_CHECKLIST_ITEMS - 1) }))
      .toThrow(/between 5 and 9 items/);
    expect(() => parsePrewalkChecklist({ items: items(MAX_PREWALK_CHECKLIST_ITEMS + 1) }))
      .toThrow(/between 5 and 9 items/);
  });

  it("requires a concrete task and validation for every item", () => {
    const missingTask = items();
    missingTask[0] = { task: " ", validation: "Run check" };
    expect(() => parsePrewalkChecklist({ items: missingTask })).toThrow(/task/);

    const missingValidation = items();
    missingValidation[0] = { task: "Change target", validation: " " };
    expect(() => parsePrewalkChecklist({ items: missingValidation })).toThrow(/validation/);
  });

  // Trivial-path escape (adopted from opencode-prewalk triviality check and
  // hermes single-edit no-handoff philosophy): a task that clearly fits in one
  // or two small edits must not force the full 5-9 item ceremony or a model
  // swap. The trivial disposition is recorded by the same checklist call.
  it("accepts a trivial disposition without an item list", () => {
    expect(parsePrewalkChecklist({ trivial: true }, 42)).toEqual({
      items: [],
      trivial: true,
      readyAt: 42,
    });
  });

  it("rejects a trivial disposition that also carries items", () => {
    expect(() => parsePrewalkChecklist({ trivial: true, items: items(5) }))
      .toThrow(/trivial/);
  });

  it("rejects a non-boolean trivial flag", () => {
    expect(() => parsePrewalkChecklist({ trivial: "yes" })).toThrow(/trivial/);
  });

  // Easy-path router: a bounded, mid-tier task still hands off to the executor
  // (unlike trivial), but relaxes the planning ceremony from 5-9 items to a
  // short 2-4 item checklist so Main skips deep research on it.
  it("accepts a 2-4 item checklist under the easy disposition", () => {
    const easy = parsePrewalkChecklist({ easy: true, items: items(MIN_EASY_PREWALK_CHECKLIST_ITEMS) }, 42);
    expect(easy).toEqual({
      items: Array.from({ length: MIN_EASY_PREWALK_CHECKLIST_ITEMS }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
      easy: true,
      readyAt: 42,
    });
    expect(
      parsePrewalkChecklist({ easy: true, items: items(MAX_EASY_PREWALK_CHECKLIST_ITEMS) }).items,
    ).toHaveLength(MAX_EASY_PREWALK_CHECKLIST_ITEMS);
  });

  it("rejects an easy checklist outside its 2-4 item bound", () => {
    expect(() =>
      parsePrewalkChecklist({ easy: true, items: items(MIN_EASY_PREWALK_CHECKLIST_ITEMS - 1) }),
    ).toThrow(/between 2 and 4 items/);
    expect(() =>
      parsePrewalkChecklist({ easy: true, items: items(MAX_EASY_PREWALK_CHECKLIST_ITEMS + 1) }),
    ).toThrow(/between 2 and 4 items/);
  });

  it("rejects a non-boolean easy flag", () => {
    expect(() => parsePrewalkChecklist({ easy: "yes" })).toThrow(/easy/);
  });

  it("keeps the full 5-9 item bound without an easy flag", () => {
    expect(() => parsePrewalkChecklist({ items: items(4) })).toThrow(/between 5 and 9 items/);
    expect(() => parsePrewalkChecklist({ easy: false, items: items(4) })).toThrow(
      /between 5 and 9 items/,
    );
  });
});

describe("scanChecklistSafety", () => {
  const withTask = (task: string) => ({
    items: [
      { task, validation: "Run check 1" },
      ...Array.from({ length: 4 }, (_, i) => ({ task: "Change " + (i + 2), validation: "Check " + (i + 2) })),
    ],
    readyAt: 0,
  });

  it("flags unambiguous destructive patterns with the 1-based item index", () => {
    const cases: Array<[string, string]> = [
      ["commit with git commit --no-verify to skip hooks", "--no-verify"],
      ["run git reset --hard HEAD~1 to drop the change", "reset --hard"],
      ["clean the tree with git clean -fd first", "clean -fd"],
      ["git push --force origin main after rebase", "force push"],
      ["stage everything with git add -A then commit", "bare git add"],
      ["stage with git add . and commit", "bare git add"],
    ];
    for (const [task, expected] of cases) {
      const warnings = scanChecklistSafety(withTask(task));
      expect(warnings.length, task).toBeGreaterThanOrEqual(1);
      expect(warnings[0]!.item).toBe(1);
      expect(warnings[0]!.pattern).toBe(expected);
    }
  });

  it("does not flag scoped staging or ordinary tasks", () => {
    expect(scanChecklistSafety(withTask("stage with git add -A src tests docs then commit"))).toEqual([]);
    expect(scanChecklistSafety(withTask("run the full gate and commit the three files"))).toEqual([]);
  });

  it("scans validations too and reports each offending item once per pattern", () => {
    const checklist = {
      items: [
        { task: "Change 1", validation: "git reset --hard proves rollback" },
        { task: "git clean -fd the tree", validation: "Check 2" },
        ...Array.from({ length: 3 }, (_, i) => ({ task: "Change " + (i + 3), validation: "Check " + (i + 3) })),
      ],
      readyAt: 0,
    };
    const warnings = scanChecklistSafety(checklist);
    expect(warnings).toEqual([
      { item: 1, pattern: "reset --hard" },
      { item: 2, pattern: "clean -fd" },
    ]);
  });

  it("returns an empty array for a trivial empty checklist", () => {
    expect(scanChecklistSafety({ items: [], readyAt: 0, trivial: true })).toEqual([]);
  });
});
