import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FabricPrewalkChecklist } from "../src/prewalk/checklist.js";
import {
  CHECKLIST_MEMORY_FILE,
  checklistSeed,
  nearestChecklist,
  prewalkMemoryDir,
  recordChecklist,
} from "../src/prewalk/checklist-memory.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-memory-"));

const checklist = (tasks: string[], readyAt = 42): FabricPrewalkChecklist => ({
  items: tasks.map((task) => ({ task, validation: "Run check" })),
  readyAt,
});

describe("prewalk checklist memory", () => {
  it("records an accepted checklist keyed by task and retrieves the nearest match", () => {
    const root = dir();
    const memory = prewalkMemoryDir(path.join(root, "runs"));
    recordChecklist(memory, "Implement the token guard and run its tests", checklist([
      "Add the token guard",
      "Wire the trigger refs",
      "Run the suite",
    ]));
    recordChecklist(memory, "Refactor the approval classifier", checklist([
      "Move the classifier",
    ]));

    const hit = nearestChecklist(memory, "implement the token guard and run its tests");
    expect(hit).toBeDefined();
    expect(hit!.checklist.items[0]!.task).toBe("Add the token guard");

    const miss = nearestChecklist(memory, "completely unrelated domain task");
    expect(miss).toBeUndefined();
  });

  it("keeps the memory bounded to the newest entries", () => {
    const root = dir();
    const memory = prewalkMemoryDir(path.join(root, "runs"));
    for (let index = 0; index < 20; index++) {
      recordChecklist(memory, `task number ${index}`, checklist([`item ${index}`]));
    }
    const entries = JSON.parse(
      fs.readFileSync(path.join(memory, CHECKLIST_MEMORY_FILE), "utf8"),
    );
    expect(entries).toHaveLength(16);
    expect(entries[0]!.task).toBe("task number 19");
  });

  it("ignores trivial and empty checklists when recording", () => {
    const root = dir();
    const memory = prewalkMemoryDir(path.join(root, "runs"));
    recordChecklist(memory, "some task", { items: [], readyAt: 1, trivial: true });
    recordChecklist(memory, "other task", { items: [], readyAt: 2 });
    expect(fs.existsSync(path.join(memory, CHECKLIST_MEMORY_FILE))).toBe(false);
  });

  it("produces a bounded adapt-don't-rederive seed", () => {
    const entry = {
      task: "Implement the token guard",
      checklist: checklist(["Add the guard", "Wire refs", "Run suite", "Extra", "More"]),
      recordedAt: 1,
    };
    const seed = checklistSeed(entry);
    expect(seed).toContain("adapt");
    expect(seed).toContain("Add the guard");
    // Bounded: never more than four seed items and never the whole task.
    expect(seed.split("\n- ").length - 1).toBeLessThanOrEqual(4);
    expect(seed.length).toBeLessThan(2_000);
  });
});
