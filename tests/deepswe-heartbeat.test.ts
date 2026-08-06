import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("bench", "deepswe-heartbeat.mjs");

const sampleStatus = {
  updatedAt: 1786024642,
  runnerPid: 1830191,
  runnerAlive: true,
  expected: 113,
  cellsStarted: 5,
  results: 4,
  exceptions: 0,
  pending: 109,
};

const runHeartbeat = (root: string, supervisorId: string, status: object) =>
  spawnSync("node", [SCRIPT, "-", supervisorId, root], {
    input: JSON.stringify(status),
    encoding: "utf8",
  });

describe("DeepSWE watchdog mesh heartbeat publisher", () => {
  it("publishes one bounded heartbeat addressed to the supervisor via MeshStore", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepswe-mesh-"));
    try {
      const r = runHeartbeat(root, "supervisor-123", sampleStatus);
      expect(r.status).toBe(0);
      const lines = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const first = lines[0];
      expect(first).toBeDefined();
      const event = JSON.parse(first as string);
      expect(event.topic).toBe("bench.deepswe.heartbeat");
      expect(event.to).toBe("supervisor-123");
      expect(event.kind).toBe("status");
      const data: Record<string, unknown> = event.data ?? {};
      const allowed = new Set(["updatedAt", "runnerPid", "runnerAlive", "expected", "cellsStarted", "results", "exceptions", "pending"]);
      expect(Object.keys(data).every((key) => allowed.has(key))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never carries credentials, solution content, or oversized payloads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepswe-mesh-"));
    try {
      const r = runHeartbeat(root, "supervisor-123", {
        ...sampleStatus,
        apiKey: "sk-super-secret",
        solutionPatch: "--- a/x\n+++ b/x\n+leak",
      });
      expect(r.status).toBe(0);
      const raw = fs.readFileSync(path.join(root, "events.jsonl"), "utf8");
      expect(raw).not.toMatch(/sk-super-secret/);
      expect(raw).not.toMatch(/solutionPatch|\+leak/);
      expect(raw.length).toBeLessThan(1024 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends exactly one event per poll on a stable topic", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepswe-mesh-"));
    try {
      runHeartbeat(root, "supervisor-123", sampleStatus);
      runHeartbeat(root, "supervisor-123", { ...sampleStatus, updatedAt: sampleStatus.updatedAt + 300, results: 5 });
      const lines = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(JSON.parse(line).topic).toBe("bench.deepswe.heartbeat");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
