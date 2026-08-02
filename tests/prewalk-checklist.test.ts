import { describe, expect, it } from "vitest";
import {
  MAX_PREWALK_CHECKLIST_ITEMS,
  MIN_PREWALK_CHECKLIST_ITEMS,
  parsePrewalkChecklist,
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
});
