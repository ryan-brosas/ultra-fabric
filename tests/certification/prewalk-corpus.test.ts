import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error Certification helpers are dependency-free JavaScript used directly by Node.
import { buildPrewalkCorpusManifest, PREWALK_CONTRACT_CORPUS, PREWALK_REFERENCE_EVALUATOR } from "../../scripts/certification/prewalk-corpus.mjs";
// @ts-expect-error Benchmark helpers are dependency-free JavaScript used directly by Node.
import { parsePrewalkRunManifest } from "../../scripts/certification/prewalk-runner-lib.mjs";

const root = path.resolve(".");

const SOURCE_MARKERS: Record<string, string> = {
  "prewalk-checklist-normalization": "parsePrewalkChecklist",
  "prewalk-continuation-ownership": "filterPrewalkContinuationMessages",
  "persistent-delivery-policy": "resolvePersistentAgentDeliveryPolicy",
  "persistent-delivery-notice": "persistentAgentDeliveryNotice",
  "retry-bounded-backoff": "retryWithBackoff",
  "persistent-validity-decision": "evaluatePersistentAgentValidWhile",
  "run-envelope-validation": "isFabricRunEnvelopeV1",
  "path-lease-conflicts": "class PathLeaseStore",
  "durable-workflow-readiness": "refreshReady",
  "context-qos-supersession": "applyContextQos",
  "capability-aware-model-route": "routeModel",
  "quality-language-detection": "detectQualityLanguage",
  "quality-check-planning": "planQualityChecks",
  "quality-policy-verdict": "evaluateQualityPolicy",
  "memory-query-planning": "planMemoryQuery",
  "consult-path-normalization": "normalizeConsultPath",
  "consult-admission-modes": "admitConsult",
  "deterministic-outcome-scoring": "evaluateDeterministic",
  "retention-root-decision": "sweepTempRunRoots",
  "budget-ledger-rollup": "readBudgetLedgerDetailed",
};

const writeFiles = (directory: string, files: Record<string, string>) => {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
};

const runVerifier = (directory: string, task: any) => spawnSync(
  task.test.command,
  task.test.args,
  {
    cwd: directory,
    encoding: "utf8",
    timeout: task.test.timeoutMs,
    env: { PI_OFFLINE: "1" },
  },
);

describe("bundled Prewalk contract corpus", () => {
  it("covers 20 unique source-qualified tasks across the Ultra backend", () => {
    expect(PREWALK_CONTRACT_CORPUS.version).toBe(1);
    expect(PREWALK_CONTRACT_CORPUS.tasks).toHaveLength(20);
    expect(new Set(PREWALK_CONTRACT_CORPUS.tasks.map((task: any) => task.id)).size).toBe(20);
    expect(new Set(PREWALK_CONTRACT_CORPUS.tasks.map((task: any) => task.domain))).toEqual(
      new Set([
        "prewalk",
        "persistent-agents",
        "reliability",
        "run-context",
        "coordination",
        "workflows",
        "context-qos",
        "routing",
        "quality",
        "memory",
        "consult",
        "outcomes",
        "retention",
      ]),
    );
    for (const task of PREWALK_CONTRACT_CORPUS.tasks) {
      expect(task.sourcePaths.length).toBeGreaterThanOrEqual(2);
      for (const sourcePath of task.sourcePaths) {
        expect(fs.existsSync(path.join(root, sourcePath)), `${task.id}: ${sourcePath}`).toBe(true);
      }
      const primarySource = fs.readFileSync(path.join(root, task.sourcePaths[0]), "utf8");
      expect(primarySource, task.id).toContain(SOURCE_MARKERS[task.id]);
    }
  });

  it("builds a strict paired-ready manifest without hidden solution bytes", () => {
    const manifest = buildPrewalkCorpusManifest();
    expect(parsePrewalkRunManifest(manifest)).toMatchObject({
      format: 1,
      representativeTaskSet: false,
      minimumTasks: 20,
      evaluator: {
        id: "ultra-prewalk-structural-rubric-v1",
        billable: false,
        command: process.execPath,
        args: [PREWALK_REFERENCE_EVALUATOR],
      },
    });
    expect(manifest.tasks).toHaveLength(20);
    expect(buildPrewalkCorpusManifest({ attestRepresentative: true }).representativeTaskSet)
      .toBe(true);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("solutionFiles");
    expect(serialized).not.toContain("sourcePaths");
    for (const task of PREWALK_CONTRACT_CORPUS.tasks) {
      for (const solution of Object.values(task.solutionFiles) as string[]) {
        expect(serialized).not.toContain(solution);
      }
    }
  });

  it("proves every fixture RED then GREEN while protected files stay unchanged", () => {
    const manifest = buildPrewalkCorpusManifest();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-corpus-"));
    try {
      for (const task of PREWALK_CONTRACT_CORPUS.tasks) {
        const manifestTask = manifest.tasks.find((candidate: any) => candidate.id === task.id)!;
        const directory = path.join(temp, task.id);
        writeFiles(directory, manifestTask.initialFiles);
        const protectedBefore = Object.fromEntries(manifestTask.protectedPaths.map(
          (relative: string) => [relative, fs.readFileSync(path.join(directory, relative), "utf8")],
        ));
        const red = runVerifier(directory, manifestTask);
        expect(red.status, `${task.id} unexpectedly passed before implementation`).not.toBe(0);
        writeFiles(directory, task.solutionFiles);
        const green = runVerifier(directory, manifestTask);
        expect(green.status, `${task.id}: ${green.stderr}`).toBe(0);
        for (const [relative, content] of Object.entries(protectedBefore)) {
          expect(fs.readFileSync(path.join(directory, relative), "utf8")).toBe(content);
        }
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses a deterministic prompt-free evaluator contract", () => {
    const checklist = Array.from({ length: 5 }, (_, index) => ({
      task: `Inspect src/contract.mjs behavior ${index}`,
      validation: `Run node verify.mjs for case ${index}`,
    }));
    const passed = spawnSync(process.execPath, [PREWALK_REFERENCE_EVALUATOR], {
      input: JSON.stringify({
        format: 1,
        taskId: "task",
        variant: "research",
        objective: "Implement src/contract.mjs after reading CONTRACT.md and run node verify.mjs.",
        checklist,
        finalResponse: "Implemented and verified.",
        oracle: { acceptance: { completed: 3, total: 3 }, missedConstraints: 0, failed: [], testStatus: 0 },
      }),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(passed.status, passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual({
      unsupportedClaims: 0,
      planQualityScore: 1,
    });

    const failed = spawnSync(process.execPath, [PREWALK_REFERENCE_EVALUATOR], {
      input: JSON.stringify({
        format: 1,
        taskId: "task",
        variant: "in-place",
        objective: "Implement the contract.",
        checklist: [],
        finalResponse: "Implemented successfully. Tests pass.",
        oracle: { acceptance: { completed: 1, total: 3 }, missedConstraints: 2, failed: ["test"], testStatus: 1 },
      }),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(failed.status, failed.stderr).toBe(0);
    expect(JSON.parse(failed.stdout)).toEqual({ unsupportedClaims: 2 });
    expect(failed.stdout).not.toContain("Implemented successfully");
  });

  it("generates a non-overwriting manifest accepted by the 40-arm dry-run", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.scripts["benchmark:prewalk:corpus"]).toBe(
      "node scripts/build-prewalk-corpus.mjs",
    );
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-prewalk-corpus-build-"));
    try {
      const output = path.join(temp, "manifest.json");
      const generator = path.join(root, "scripts", "build-prewalk-corpus.mjs");
      const generated = spawnSync(process.execPath, [generator, "--", "--output", output], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(generated.status, generated.stderr).toBe(0);
      expect(generated.stdout).toContain("20 tasks");
      const document = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(parsePrewalkRunManifest(document).tasks).toHaveLength(20);
      expect(document.representativeTaskSet).toBe(false);

      const attestedOutput = path.join(temp, "attested-manifest.json");
      const attested = spawnSync(
        process.execPath,
        [generator, "--output", attestedOutput, "--attest-representative"],
        { cwd: root, encoding: "utf8", timeout: 10_000 },
      );
      expect(attested.status, attested.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(attestedOutput, "utf8")).representativeTaskSet)
        .toBe(true);

      const dryRun = spawnSync(
        process.execPath,
        [path.join(root, "scripts", "benchmark-prewalk-real.mjs"), "--dry-run", output],
        { cwd: root, encoding: "utf8", timeout: 10_000, env: {} },
      );
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain('"tasks": 20');
      expect(dryRun.stdout).toContain('"runs": 40');

      const repeated = spawnSync(process.execPath, [generator, "--output", output], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(repeated.status).toBe(1);
      expect(repeated.stderr).toMatch(/already exists/i);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20_000);
});
