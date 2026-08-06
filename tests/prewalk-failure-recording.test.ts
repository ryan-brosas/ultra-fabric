import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrewalkController } from "../src/prewalk/controller.js";
import { prewalkFailureDir, nearestFailures, recordFailure } from "../src/prewalk/failure-memory.js";

// Validates the exact recording contract index.ts consumes on agent_settled:
// a blocked prewalk status preserves task + error, and the failure store
// round-trips them keyed by the task text.
describe("prewalk failure recording seam", () => {
  it("blocked status exposes task and error, and the store round-trips them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-gate-"));
    const ctrl = new PrewalkController();
    ctrl.configureTriggers([], ["pi.edit", "pi.write"], ["workspace"]);
    ctrl.arm({
      model: "anthropic/executor",
      sessionId: "s1",
      task: "Implement the token guard",
      arm: "task",
    });
    // Simulate the blocked transition the lifecycle reducer produces for a
    // verifying-without-pass settle: task preserved from the arm, error set.
    const st = ctrl.status() as any;
    expect(st.task).toBe("Implement the token guard");

    const dir = prewalkFailureDir(path.join(root, "runs"));
    recordFailure(dir, "Implement the token guard", {
      kind: "revision-exhausted",
      gate: "Prewalk verification revision limit exhausted (5)",
      feedback: "Prewalk verification revision limit exhausted (5)",
    });
    const hits = nearestFailures(dir, "implement the token guard and run tests");
    expect(hits.length).toBe(1);
    expect(hits[0]!.kind).toBe("revision-exhausted");
  });

  it("records nothing when no gate fails (no blocked state)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-ok-"));
    const ctrl = new PrewalkController();
    ctrl.configureTriggers([], ["pi.edit", "pi.write"], ["workspace"]);
    ctrl.arm({ model: "anthropic/executor", sessionId: "s1", task: "Add feature", arm: "task" });
    expect(ctrl.status().state).not.toBe("blocked");
    expect(nearestFailures(prewalkFailureDir(path.join(root, "runs")), "add feature")).toEqual([]);
  });
});
