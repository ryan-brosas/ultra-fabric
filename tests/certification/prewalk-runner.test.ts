import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error Benchmark helpers are dependency-free JavaScript used directly by Node.
import { buildPrewalkProjectConfig, buildPrewalkSchedule, parsePrewalkEvaluatorResult, parsePrewalkRunManifest, prewalkRunnerGate, summarizePrewalkProbe } from "../../scripts/certification/prewalk-runner-lib.mjs";
// @ts-expect-error The probe is dependency-free JavaScript loaded directly by Pi.
import prewalkProbe from "../../scripts/certification/prewalk-probe.mjs";
// @ts-expect-error The real runner exports a dependency-free repository scanner for oracle tests.
import { scanPrewalkRepository } from "../../scripts/certification/prewalk-real-runner.mjs";

const task = (id = "task-01") => ({
  id,
  prompt: "Create src/value.js and satisfy the exact fixture oracle.",
  initialFiles: {
    "verify.mjs": "process.exit(0);\n",
    "protected.txt": "unchanged\n",
  },
  expectedFiles: {
    "src/value.js": "export const value = 1;\n",
  },
  protectedPaths: ["protected.txt", "verify.mjs"],
  test: {
    command: process.execPath,
    args: ["verify.mjs"],
    timeoutMs: 5_000,
    env: [],
  },
});

const manifest = () => ({
  format: 1,
  representativeTaskSet: false,
  minimumTasks: 20,
  evaluator: {
    id: "independent-rubric-v1",
    billable: false,
    command: process.execPath,
    args: ["/tmp/prewalk-evaluator.mjs"],
    timeoutMs: 5_000,
    env: ["EVALUATOR_KEY"],
  },
  tasks: [task()],
});

const enabledEnv = () => ({
  PI_FABRIC_PREWALK_REAL: "1",
  PI_FABRIC_PREWALK_TRUST_MANIFEST: "1",
  PI_FABRIC_BENCH_PROVIDER: "anthropic",
  PI_FABRIC_BENCH_MODEL: "frontier-model",
  PI_FABRIC_BENCH_KEY_ENV: "FRONTIER_KEY",
  FRONTIER_KEY: "frontier-secret",
  PI_FABRIC_PREWALK_EXECUTOR_PROVIDER: "anthropic",
  PI_FABRIC_PREWALK_EXECUTOR_MODEL: "executor-model",
  PI_FABRIC_PREWALK_EXECUTOR_KEY_ENV: "EXECUTOR_KEY",
  EXECUTOR_KEY: "executor-secret",
  PI_FABRIC_BENCH_REPEATS: "2",
  PI_FABRIC_BENCH_MAX_USD: "3.5",
  PI_FABRIC_BENCH_MAX_TOKENS: "10000",
  PI_FABRIC_BENCH_TASK_TIMEOUT_MS: "60000",
  PI_FABRIC_BENCH_SEED: "prewalk-runner-test",
});

describe("real Prewalk runner contract", () => {
  it("is disabled by default and never returns credential values", () => {
    const disabled = prewalkRunnerGate({});
    expect(disabled.enabled).toBe(false);
    expect(disabled.reasons).toContain("PI_FABRIC_PREWALK_REAL must equal 1");
    expect(disabled.reasons).toContain(
      "PI_FABRIC_PREWALK_TRUST_MANIFEST must equal 1",
    );

    const enabled = prewalkRunnerGate(enabledEnv());
    expect(enabled).toMatchObject({
      enabled: true,
      config: {
        frontier: { provider: "anthropic", model: "frontier-model", keyVariable: "FRONTIER_KEY" },
        executor: { provider: "anthropic", model: "executor-model", keyVariable: "EXECUTOR_KEY" },
        repeats: 2,
        maxUsd: 3.5,
        maxTokens: 10_000,
        taskTimeoutMs: 60_000,
        seed: "prewalk-runner-test",
      },
    });
    expect(JSON.stringify(enabled)).not.toContain("frontier-secret");
    expect(JSON.stringify(enabled)).not.toContain("executor-secret");

    const relativeCli = prewalkRunnerGate({
      ...enabledEnv(),
      PI_FABRIC_PREWALK_PI_CLI: "relative/fake-pi.mjs",
    });
    expect(relativeCli.enabled).toBe(false);
    expect(relativeCli.reasons).toContain(
      "PI_FABRIC_PREWALK_PI_CLI must be an absolute path when set",
    );
  });

  it("parses bounded manifests and rejects unknown, escaping, and reserved paths", () => {
    expect(parsePrewalkRunManifest(manifest())).toMatchObject({
      format: 1,
      representativeTaskSet: false,
      minimumTasks: 20,
      evaluator: { id: "independent-rubric-v1" },
      tasks: [{ id: "task-01", protectedPaths: ["protected.txt", "verify.mjs"] }],
    });

    expect(() => parsePrewalkRunManifest({ ...manifest(), rawPromptLog: true }))
      .toThrow(/unknown field.*rawPromptLog/i);
    expect(() => parsePrewalkRunManifest({
      ...manifest(),
      evaluator: { ...manifest().evaluator, billable: true },
    })).toThrow(/evaluator.billable.*false/i);
    expect(() => parsePrewalkRunManifest({
      ...manifest(),
      tasks: [{ ...task(), initialFiles: { "../escape.txt": "no" } }],
    })).toThrow(/escapes|relative path/i);
    expect(() => parsePrewalkRunManifest({
      ...manifest(),
      tasks: [{ ...task(), expectedFiles: { ".pi/fabric.json": "no" } }],
    })).toThrow(/reserved.*.pi/i);
    expect(() => parsePrewalkRunManifest({
      ...manifest(),
      tasks: [{
        ...task(),
        expectedFiles: { ...task().expectedFiles, "verify.mjs": "process.exit(0);\n" },
      }],
    })).toThrow(/both expected and protected/i);
  });

  it("bounds repository inspection by entries, depth, and bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-scan-"));
    try {
      fs.mkdirSync(path.join(root, "one", "two"), { recursive: true });
      fs.writeFileSync(path.join(root, "first.txt"), "1234", "utf8");
      fs.writeFileSync(path.join(root, "one", "two", "second.txt"), "5678", "utf8");

      expect(scanPrewalkRepository(root, { maxEntries: 1, maxDepth: 10, maxBytes: 100 }))
        .toMatchObject({ kind: "limit", reason: "entries" });
      expect(scanPrewalkRepository(root, { maxEntries: 10, maxDepth: 1, maxBytes: 100 }))
        .toMatchObject({ kind: "limit", reason: "depth" });
      expect(scanPrewalkRepository(root, { maxEntries: 10, maxDepth: 10, maxBytes: 3 }))
        .toMatchObject({ kind: "limit", reason: "bytes" });
      expect(scanPrewalkRepository(root, { maxEntries: 10, maxDepth: 10, maxBytes: 100 }))
        .toMatchObject({
          kind: "complete",
          files: ["first.txt", "one/two/second.txt"],
          bytes: 8,
        });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds deterministic complete pairs for every task and repeat", () => {
    const tasks = [task("task-a"), task("task-b")];
    const first = buildPrewalkSchedule(tasks, 3, "seed");
    const second = buildPrewalkSchedule(tasks, 3, "seed");
    expect(first).toEqual(second);
    expect(first).toHaveLength(12);
    for (const id of ["task-a", "task-b"]) {
      for (const repeat of [1, 2, 3]) {
        expect(first.filter((entry: { taskId: string; repeat: number }) =>
          entry.taskId === id && entry.repeat === repeat
        ).map((entry: { variant: string }) => entry.variant).sort()).toEqual([
          "in-place",
          "research",
        ]);
      }
    }
  });

  it("writes prompt-free probe telemetry and derives mechanical protocol evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-probe-"));
    const output = path.join(root, "probe.jsonl");
    const previous = process.env.PI_FABRIC_PREWALK_PROBE_PATH;
    process.env.PI_FABRIC_PREWALK_PROBE_PATH = output;
    try {
      const handlers = new Map<string, (event: any) => void>();
      prewalkProbe({ on: (name: string, handler: (event: any) => void) => {
        handlers.set(name, handler);
      } });
      handlers.get("context")!({ messages: [
        { role: "custom", customType: "pi-fabric-prewalk-research-plan" },
      ] });
      handlers.get("message_end")!({ message: {
        role: "assistant",
        provider: "anthropic",
        model: "frontier-model",
        usage: {
          input: 90,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { total: 0.1 },
        },
      } });
      handlers.get("tool_execution_end")!({
        toolName: "fabric_exec",
        isError: false,
        result: {
          terminate: true,
          details: { trace: { operations: [
            { ref: "fabric.prewalk.checklist", outcome: "succeeded", args: { items: Array(5).fill({ task: "private plan", validation: "private proof" }) } },
            { ref: "pi.write", outcome: "succeeded", effect: "workspace", args: { path: "private.txt" } },
          ] } },
        },
      });
      handlers.get("context")!({ messages: [
        { role: "custom", customType: "pi-fabric-prewalk-continue" },
      ] });
      handlers.get("message_end")!({ message: {
        role: "assistant",
        provider: "anthropic",
        model: "executor-model",
        usage: {
          input: 70,
          output: 15,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 90,
          cost: { total: 0.05 },
        },
      } });

      const raw = fs.readFileSync(output, "utf8");
      expect(raw).not.toContain("private plan");
      expect(raw).not.toContain("private.txt");
      const records = raw.trim().split("\n").map((line) => JSON.parse(line));
      expect(summarizePrewalkProbe(records, {
        frontier: { provider: "anthropic", model: "frontier-model" },
        executor: { provider: "anthropic", model: "executor-model" },
      })).toEqual({
        contextTokensBeforeRequests: [100, 75],
        parentContextTokens: 100,
        executorContextTokens: 75,
        inputTokens: 160,
        outputTokens: 35,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        requestCount: 2,
        checklistItems: 5,
        firstMutationBoundary: true,
        planningInstructionPruned: true,
        executorSeen: true,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_FABRIC_PREWALK_PROBE_PATH;
      else process.env.PI_FABRIC_PREWALK_PROBE_PATH = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds bounded project config and validates independent evaluator output", () => {
    expect(buildPrewalkProjectConfig("research", {
      provider: "anthropic",
      model: "executor-model",
    }, 60_000)).toMatchObject({
      configVersion: 2,
      fullCodeMode: true,
      prewalk: {
        mode: "research",
        model: "anthropic/executor-model",
        thinking: "off",
        returnPolicy: "executor",
      },
      executor: { runtime: "quickjs", timeoutMs: 60_000 },
      quality: { mode: "off" },
      schema: { mode: "off" },
    });
    expect(parsePrewalkEvaluatorResult({
      unsupportedClaims: 1,
      planQualityScore: 0.75,
    }, "research")).toEqual({ unsupportedClaims: 1, planQualityScore: 0.75 });
    expect(() => parsePrewalkEvaluatorResult({ unsupportedClaims: 0 }, "research"))
      .toThrow(/planQualityScore/i);
    expect(() => parsePrewalkEvaluatorResult({
      unsupportedClaims: 0,
      planQualityScore: 1,
      explanation: "must not persist",
    }, "research")).toThrow(/unknown field.*explanation/i);
  });

  it("collects paired real runs through RPC and stops before exceeding budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-real-"));
    try {
      const fakePi = path.join(root, "fake-pi.mjs");
      const evaluator = path.join(root, "evaluator.mjs");
      const input = path.join(root, "manifest.json");
      fs.writeFileSync(fakePi, `
import fs from "node:fs";
import path from "node:path";
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const probe = (value) => fs.appendFileSync(process.env.PI_FABRIC_PREWALK_PROBE_PATH, JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_commands") {
      send({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: [{ name: "fabric", source: "extension" }] } });
    } else if (command.type === "prompt") {
      const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".pi", "fabric.json"), "utf8"));
      const research = config.prewalk.mode === "research";
      fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });
      const valuePath = path.join(process.cwd(), "src", "value.js");
      fs.writeFileSync(valuePath, "export const value = 1;\\n", "utf8");
      if (process.env.FAKE_SYMLINK_TARGET) {
        fs.unlinkSync(valuePath);
        fs.symlinkSync(process.env.FAKE_SYMLINK_TARGET, valuePath);
      }
      send({ id: command.id, type: "response", command: "prompt", success: true });
      const frontier = { type: "message_end", message: { role: "assistant", provider: "anthropic", model: "frontier-model", content: [], usage: { input: 90, cacheRead: 10, cacheWrite: 0, totalTokens: 120, cost: { total: 0.1 } } } };
      send(frontier);
      probe({ type: "message", phase: "frontier", provider: "anthropic", model: "frontier-model", contextTokens: 100, inputTokens: 90, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 120 });
      if (research) {
        const items = Array.from({ length: 5 }, (_, item) => ({ task: "private plan " + item, validation: "private proof " + item }));
        send({ type: "tool_execution_end", toolName: "fabric_exec", isError: false, result: { terminate: true, details: { trace: { operations: [
          { ref: "fabric.prewalk.checklist", outcome: "succeeded", args: { items } },
          { ref: "pi.write", outcome: "succeeded", effect: "workspace", args: {} },
        ] } } } });
        probe({ type: "fabric_exec", checklistItems: 5, workspaceMutations: 1, terminate: true, isError: false });
      }
      probe({ type: "context", planningPresent: false, continuationPresent: true });
      send({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "executor-model", content: [{ type: "text", text: "private final response" }], usage: { input: 70, cacheRead: 5, cacheWrite: 0, totalTokens: 90, cost: { total: 0.05 } } } });
      probe({ type: "message", phase: "executor", provider: "anthropic", model: "executor-model", contextTokens: 75, inputTokens: 70, outputTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 90 });
      send({ type: "agent_settled" });
    } else if (command.type === "get_session_stats") {
      send({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 210 }, cost: 0.15 } });
    } else if (command.type === "get_last_assistant_text") {
      send({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "private final response" } });
    }
  }
});
`, "utf8");
      fs.writeFileSync(evaluator, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  process.stdout.write(JSON.stringify(value.variant === "research"
    ? { unsupportedClaims: 0, planQualityScore: 0.9 }
    : { unsupportedClaims: 0 }));
});
`, "utf8");
      const document = manifest();
      document.evaluator.args = [evaluator];
      fs.writeFileSync(input, JSON.stringify(document), "utf8");
      const env = {
        ...process.env,
        ...enabledEnv(),
        PI_FABRIC_BENCH_REPEATS: "1",
        PI_FABRIC_PREWALK_PI_CLI: fakePi,
      };
      const command = path.resolve("scripts/benchmark-prewalk-real.mjs");
      const output = path.join(root, "collected.json");
      const collected = spawnSync(
        process.execPath,
        [command, input, "--output", output],
        {
          encoding: "utf8",
          env,
          timeout: 20_000,
        },
      );
      expect(collected.status, collected.stderr).toBe(0);
      expect(collected.stdout).toContain("Real Prewalk benchmark: COMPLETE");
      expect(collected.stdout).not.toContain("frontier-secret");
      expect(collected.stdout).not.toContain("private plan");
      expect(collected.stdout).not.toContain("private final response");
      expect(collected.stdout).not.toContain("Create src/value.js");
      expect(collected.stdout).toContain(output);
      expect(collected.stdout).not.toContain('"runs"');
      const dataset = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(dataset).toMatchObject({
        representativeTaskSet: false,
        minimumTasks: 20,
        provenance: {
          collector: "ultra-prewalk-real-v1",
          manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          frontier: { provider: "anthropic", model: "frontier-model" },
          executor: { provider: "anthropic", model: "executor-model" },
          repeats: 1,
          observedCostUsd: 0.3,
          observedTokens: 420,
        },
      });
      expect(dataset.runs).toHaveLength(2);
      expect(dataset.runs.find((run: any) => run.variant === "research")).toMatchObject({
        acceptance: { completed: 4, total: 4 },
        unsupportedClaims: 0,
        missedConstraints: 0,
        contextTokensBeforeRequests: [100, 75],
        parentContextTokens: 100,
        executorContextTokens: 75,
        inputTokens: 160,
        outputTokens: 35,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        requestCount: 2,
        totalTokens: 210,
        costUsd: 0.15,
        protocol: {
          checklistItems: 5,
          firstMutationBoundary: true,
          planningInstructionPruned: true,
          executorVerified: true,
          planQualityScore: 0.9,
          planEvaluator: "independent-rubric-v1",
        },
      });

      const overBudget = spawnSync(process.execPath, [command, input], {
        encoding: "utf8",
        env: { ...env, PI_FABRIC_BENCH_MAX_USD: "0.1" },
        timeout: 20_000,
      });
      expect(overBudget.status).toBe(1);
      expect(overBudget.stderr).toMatch(/budget.*0\.1/i);

      const overTokenBudget = spawnSync(process.execPath, [command, input], {
        encoding: "utf8",
        env: { ...env, PI_FABRIC_BENCH_MAX_TOKENS: "200" },
        timeout: 20_000,
      });
      expect(overTokenBudget.status).toBe(1);
      expect(overTokenBudget.stderr).toMatch(/token budget.*200/i);

      const matchingExternalFile = path.join(root, "matching-external.js");
      fs.writeFileSync(matchingExternalFile, "export const value = 1;\n", "utf8");
      const symlinked = spawnSync(process.execPath, [command, input], {
        encoding: "utf8",
        env: { ...env, FAKE_SYMLINK_TARGET: matchingExternalFile },
        timeout: 20_000,
      });
      expect(symlinked.status, symlinked.stderr).toBe(0);
      const symlinkDataset = JSON.parse(
        symlinked.stdout.slice(symlinked.stdout.indexOf("{")),
      );
      expect(symlinkDataset.runs.every((run: any) =>
        run.acceptance.completed < run.acceptance.total && run.missedConstraints > 0
      )).toBe(true);

      const brokenDocument = manifest();
      brokenDocument.evaluator.args = [evaluator];
      brokenDocument.tasks[0]!.test.command = path.join(root, "missing-test-command");
      const brokenInput = path.join(root, "broken-manifest.json");
      fs.writeFileSync(brokenInput, JSON.stringify(brokenDocument), "utf8");
      const brokenOracle = spawnSync(process.execPath, [command, brokenInput], {
        encoding: "utf8",
        env,
        timeout: 20_000,
      });
      expect(brokenOracle.status).toBe(1);
      expect(brokenOracle.stderr).toMatch(/test command failed/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("safely skips by default and dry-runs without model credentials", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(packageJson.scripts["benchmark:prewalk:real"]).toBe(
      "pnpm run build && node scripts/benchmark-prewalk-real.mjs",
    );
    const command = path.resolve("scripts/benchmark-prewalk-real.mjs");
    const skipped = spawnSync(process.execPath, [command], {
      encoding: "utf8",
      env: {},
      timeout: 10_000,
    });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("Real Prewalk benchmark: SKIP");
    expect(skipped.stdout).toContain('"skipped": true');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-runner-dry-"));
    try {
      const input = path.join(root, "manifest.json");
      fs.writeFileSync(input, JSON.stringify(manifest()), "utf8");
      const dryRun = spawnSync(process.execPath, [command, "--", "--dry-run", input], {
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      });
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("Real Prewalk benchmark: DRY RUN");
      expect(dryRun.stdout).toContain('"runs": 2');
      expect(dryRun.stdout).not.toContain("Create src/value.js");

      const relativeOutput = spawnSync(
        process.execPath,
        [command, "--dry-run", input, "--output", "relative.json"],
        { encoding: "utf8", env: {}, timeout: 10_000 },
      );
      expect(relativeOutput.status).toBe(1);
      expect(relativeOutput.stderr).toBe(
        "Real Prewalk benchmark failed: --output path must be absolute\n",
      );

      const existingOutput = path.join(root, "existing.json");
      fs.writeFileSync(existingOutput, "control\n", "utf8");
      const missingPi = path.join(root, "missing-pi.mjs");
      const noOverwrite = spawnSync(
        process.execPath,
        [command, input, "--output", existingOutput],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ...enabledEnv(),
            PI_FABRIC_PREWALK_PI_CLI: missingPi,
          },
          timeout: 10_000,
        },
      );
      expect(noOverwrite.status).toBe(1);
      expect(noOverwrite.stderr).toMatch(/output already exists/i);
      expect(noOverwrite.stderr).not.toMatch(/agent process|missing-pi/i);
      expect(fs.readFileSync(existingOutput, "utf8")).toBe("control\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
