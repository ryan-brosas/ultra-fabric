import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const BENCH = path.resolve("bench");

const runMatrix = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", ["run-deepswe-matrix.sh", ...args], {
    cwd: BENCH,
    env: {
      ...process.env,
      PIER_DRY_RUN: "1",
      PIER_N_ATTEMPTS: "1",
      PIER_N_CONCURRENT: "1",
      DEEPSWE_ROOT: path.join(os.tmpdir(), "deepswe"),
      ...env,
    },
    encoding: "utf8",
  });

const withFixture = (fn: (root: string) => void) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepswe-"));
  fs.mkdirSync(path.join(root, "tasks", "scc-bounded-memory-spilling"), { recursive: true });
  fs.writeFileSync(path.join(root, "subsets.txt"), "scc-bounded-memory-spilling\n");
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("DeepSWE matrix harness (fabric-prewalk)", () => {
  it("accepts fabric-prewalk as a config and emits a distinct resumable job", () => {
    withFixture((root) => {
      const r = runMatrix([path.join(root, "subsets.txt"), "fabric-prewalk"], { DEEPSWE_ROOT: root });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("deepswe-subsets-fabric-prewalk");
      expect(r.stdout).toContain("--include-task-name scc-bounded-memory-spilling");
      expect(r.stdout).toMatch(/run-deepswe-pier\.sh \S+ fabric-prewalk/);
    });
  });

  it("refuses an unknown config", () => {
    withFixture((root) => {
      const r = runMatrix([path.join(root, "subsets.txt"), "fabric-foo"], { DEEPSWE_ROOT: root });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
    });
  });

  it("carries the dirty-worktree and paid-cell guards", () => {
    const script = fs.readFileSync(path.join(BENCH, "run-deepswe-matrix.sh"), "utf8");
    expect(script).toContain("PIER_ALLOW_DIRTY");
    expect(script).toContain("Refusing to benchmark a dirty worktree");
    expect(script).toContain("PIER_CONFIRM_FULL_MATRIX");
  });
});