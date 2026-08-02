import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQualityCheck, runQualityChecks } from "../src/quality/command-runner.js";
import type { PlannedQualityCheck, QualityCheckDefinition } from "../src/quality/policy.js";

const planned = (
  id: string,
  source: string,
  options: Partial<QualityCheckDefinition> = {},
  paths: string[] = [],
): PlannedQualityCheck => ({
  definition: {
    id,
    languages: ["typescript"],
    command: process.execPath,
    args: ["-e", source],
    fileMode: "none",
    timeoutMs: 2_000,
    ...options,
  },
  languages: ["typescript"],
  paths,
});

describe("quality command runner", () => {
  it("runs an executable with argv and captures a passing result", async () => {
    const result = await runQualityCheck({
      cwd: process.cwd(),
      check: planned("pass", "process.stdout.write('ok')"),
      maxOutputChars: 1_000,
    });

    expect(result).toMatchObject({
      checkId: "pass",
      outcome: "passed",
      exitCode: 0,
      output: "ok",
      outputTruncated: false,
    });
  });

  it("appends changed paths as literal arguments without shell interpretation", async () => {
    const paths = ["src/a file.ts", "$(printf unsafe)", "public/index.html"];
    const result = await runQualityCheck({
      cwd: process.cwd(),
      check: planned(
        "files",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        { fileMode: "append" },
        paths,
      ),
      maxOutputChars: 2_000,
    });

    expect(JSON.parse(result.output ?? "null")).toEqual(paths);
    expect(result.outcome).toBe("passed");
  });

  it("keeps a nonzero exit distinct from a launch crash", async () => {
    const failed = await runQualityCheck({
      cwd: process.cwd(),
      check: planned("failed", "process.stderr.write('bad'); process.exit(3)"),
      maxOutputChars: 1_000,
    });
    const crashed = await runQualityCheck({
      cwd: process.cwd(),
      check: planned("crashed", "", { command: "fabric-quality-command-that-does-not-exist" }),
      maxOutputChars: 1_000,
    });

    expect(failed).toMatchObject({ checkId: "failed", outcome: "failed", exitCode: 3 });
    expect(failed.output).toContain("bad");
    expect(crashed).toMatchObject({ checkId: "crashed", outcome: "crashed" });
    expect(crashed.exitCode).toBeUndefined();
  });

  it("terminates a timed-out command and labels it separately", async () => {
    const result = await runQualityCheck({
      cwd: process.cwd(),
      check: planned("slow", "setInterval(() => undefined, 1_000)", { timeoutMs: 50 }),
      maxOutputChars: 1_000,
    });

    expect(result.outcome).toBe("timed_out");
  });

  it("terminates descendants when a timed-out check launches another process", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-fabric-quality-tree-"));
    const marker = path.join(directory, "late-write");
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 300)`;
    const source = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
setInterval(() => undefined, 1_000);
`;

    try {
      const result = await runQualityCheck({
        cwd: process.cwd(),
        check: planned("tree", source, { timeoutMs: 50 }),
        maxOutputChars: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(result.outcome).toBe("timed_out");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps captured output without changing a successful exit", async () => {
    const result = await runQualityCheck({
      cwd: process.cwd(),
      check: planned("loud", "process.stdout.write('abcdefghijk')"),
      maxOutputChars: 8,
    });

    expect(result).toMatchObject({
      outcome: "passed",
      output: "abcdefgh",
      outputTruncated: true,
    });
  });

  it("runs checks serially and preserves configured order", async () => {
    const results = await runQualityChecks({
      cwd: process.cwd(),
      checks: [
        planned("first", "process.stdout.write('1')"),
        planned("second", "process.stdout.write('2')"),
      ],
      maxOutputChars: 1_000,
    });

    expect(results.map(({ checkId, output }) => [checkId, output])).toEqual([
      ["first", "1"],
      ["second", "2"],
    ]);
  });
});
