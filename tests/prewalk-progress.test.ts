import { describe, expect, it } from "vitest";
import { extractDoneMarkers, checklistProgress, checklistWidgetLines } from "../src/prewalk/checklist-progress.js";
import { prewalkChecklistReminder } from "../src/prewalk/continuation.js";
import { PrewalkController } from "../src/prewalk/controller.js";

const items = Array.from({ length: 5 }, (_, index) => ({
  task: "Step " + (index + 1),
  validation: "Check " + (index + 1),
}));
const checklist = (doneIndexes?: number[]) => ({ items, readyAt: 1, ...(doneIndexes ? { doneIndexes } : {}) });

describe("extractDoneMarkers", () => {
  it("extracts 1-based markers bounded by the item count", () => {
    expect(extractDoneMarkers("[DONE:1] first step done", 5)).toEqual([0]);
    expect(extractDoneMarkers("[DONE:1] and [DONE:3]", 5)).toEqual([0, 2]);
  });

  it("drops out-of-range markers and deduplicates", () => {
    expect(extractDoneMarkers("[DONE:7] [DONE:1] [DONE:1]", 5)).toEqual([0]);
    expect(extractDoneMarkers("[DONE:0] [DONE:-1]", 5)).toEqual([]);
  });

  it("is empty without markers", () => {
    expect(extractDoneMarkers("plain text no markers", 5)).toEqual([]);
  });
});

describe("checklistProgress", () => {
  it("counts done and total", () => {
    expect(checklistProgress(checklist([0, 2]))).toEqual({ done: 2, total: 5 });
    expect(checklistProgress(checklist())).toEqual({ done: 0, total: 5 });
  });
});

describe("checklistWidgetLines", () => {
  it("crosses out done items with strikethrough and keeps the [x] marker", () => {
    const lines = checklistWidgetLines(checklist([0, 2]));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("[x] \u001b[9;2mStep 1\u001b[0m");
    expect(lines[2]).toBe("[x] \u001b[9;2mStep 3\u001b[0m");
  });

  it("renders pending items as plain [ ] lines with no escapes", () => {
    const lines = checklistWidgetLines(checklist([0]));
    expect(lines[1]).toBe("[ ] Step 2");
    expect(lines[1]).not.toContain("\u001b");
  });

  it("renders all items pending when nothing is done", () => {
    const lines = checklistWidgetLines(checklist());
    expect(lines).toEqual(items.map((item) => "[ ] " + item.task));
  });
});

describe("prewalkChecklistReminder with progress", () => {
  it("omits completed items and keeps the done-count header", () => {
    const out = prewalkChecklistReminder(checklist([0, 1]));
    expect(out).toContain("2 of 5 done");
    expect(out).toContain("Step 3");
    expect(out).toContain("Step 5");
    expect(out).not.toContain("Step 1");
    expect(out).not.toContain("Step 2");
  });

  it("keeps the current shape when nothing is done", () => {
    const out = prewalkChecklistReminder(checklist());
    expect(out).toContain("Step 1");
    expect(out).toContain("Step 5");
    expect(out).toContain("0 of 5 done");
  });

  it("numbers open items by original position when earlier items are done", () => {
    const out = prewalkChecklistReminder(checklist([0, 2]));
    // Step 2 (open, original index 1) must keep its original 1-based number 2,
    // not be renumbered to 1: [DONE:n] indexes refer to the original checklist order.
    expect(out).toContain("- 2. Step 2");
    expect(out).not.toContain("- 1. Step 2");
    expect(out).toContain("- 4. Step 4");
    expect(out).toContain("- 5. Step 5");
  });

  it("instructs the executor to emit [DONE:n] markers as items complete", () => {
    const out = prewalkChecklistReminder(checklist([0]));
    expect(out).toMatch(/\[DONE:\d+\]/);
    expect(out).toMatch(/emit/i);
  });
});

describe("PrewalkController.markChecklistDone", () => {
  it("records completed indexes on the live checklist without mutating items", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    controller.executionBoundary("session-1")!.registerChecklist(checklist());
    expect(controller.markChecklistDone("session-1", [0, 2])).toBe(true);
    const status = controller.status();
    if (status.state === "armed") {
      expect(status.checklist?.doneIndexes).toEqual([0, 2]);
      expect(status.checklist?.items).toEqual(items);
    } else {
      throw new Error("expected armed");
    }
    // merging keeps sorted unique indexes
    expect(controller.markChecklistDone("session-1", [2, 4])).toBe(true);
    const s2 = controller.status();
    if (s2.state === "armed") expect(s2.checklist?.doneIndexes).toEqual([0, 2, 4]);
  });

  it("ignores other sessions and unarmed controllers", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    controller.executionBoundary("session-1")!.registerChecklist(checklist());
    expect(controller.markChecklistDone("session-2", [0])).toBe(false);
    expect(controller.markChecklistDone("session-1", [0])).toBe(true);
    controller.cancel();
    expect(controller.markChecklistDone("session-1", [1])).toBe(false);
  });
});
