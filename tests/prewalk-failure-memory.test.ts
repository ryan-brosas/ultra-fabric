import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAILURE_MEMORY_FILE,
  failureSeed,
  nearestFailures,
  recordFailure,
} from "../src/prewalk/failure-memory.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-failures-"));

describe("prewalk failure memory", () => {
  it("records a failure pattern keyed by task and recalls it for a similar task", () => {
    const root = dir();
    recordFailure(root, "Implement the token guard and run its tests", {
      kind: "gate-abort",
      gate: "plan-check",
      feedback: "Checklist missed the trigger refs wiring step",
    });
    recordFailure(root, "Implement the token guard and run its tests", {
      kind: "revision-exhausted",
      gate: "verify",
      feedback: "Exceeded maxPhaseRevisions without a passing gate",
    });

    const hits = nearestFailures(root, "implement the token guard and run its tests");
    expect(hits.length).toBe(2);
    expect(hits[0]!.kind).toBe("revision-exhausted");
    expect(hits[1]!.kind).toBe("gate-abort");
  });

  it("does not recall patterns for an unrelated task", () => {
    const root = dir();
    recordFailure(root, "Implement the token guard", {
      kind: "gate-abort",
      gate: "plan-check",
      feedback: "missed wiring",
    });
    const hits = nearestFailures(root, "completely unrelated database migration");
    expect(hits).toEqual([]);
  });

  it("ranks keyword/path overlap above weak matches", () => {
    const root = dir();
    recordFailure(root, "Edit src/config.ts parser for tokens", {
      kind: "gate-abort",
      gate: "g1",
      feedback: "bad parse",
    });
    recordFailure(root, "Update the settings UI panel", {
      kind: "gate-abort",
      gate: "g2",
      feedback: "wrong label",
    });
    const hits = nearestFailures(root, "fix src/config.ts token parsing");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.task).toContain("config.ts");
  });

  it("renders a bounded seed block for the planning phase", () => {
    const root = dir();
    for (let i = 0; i < 10; i++) {
      recordFailure(root, "Implement the token guard", {
        kind: "gate-abort",
        gate: "g" + i,
        feedback: "feedback line " + i,
      });
    }
    const seed = failureSeed(nearestFailures(root, "implement the token guard"));
    expect(seed).toContain("Prior failures");
    // bounded: at most 4 patterns
    const lines = seed.split("\n").filter((l) => /^- /.test(l));
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("bounds the store and tolerates a corrupt file", () => {
    const root = dir();
    fs.writeFileSync(path.join(root, FAILURE_MEMORY_FILE), "not json");
    expect(nearestFailures(root, "any task")).toEqual([]);
    for (let i = 0; i < 40; i++) {
      recordFailure(root, "task number " + i + " token guard", {
        kind: "gate-abort",
        gate: "g",
        feedback: "f",
      });
    }
    const raw = JSON.parse(fs.readFileSync(path.join(root, FAILURE_MEMORY_FILE), "utf8"));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeLessThanOrEqual(32);
  });
});
