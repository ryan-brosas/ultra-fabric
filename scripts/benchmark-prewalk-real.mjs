#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { assertNewOutputPath, writeNewOutput } from "./certification/atomic-output.mjs";
import {
  buildPrewalkSchedule,
  parsePrewalkRunManifest,
  prewalkRunnerGate,
} from "./certification/prewalk-runner-lib.mjs";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const dryRun = args[0] === "--dry-run";
const manifestPath = dryRun ? args[1] : args[0];
const trailing = args.slice(dryRun ? 2 : 1);
let argumentError;
if (trailing.length !== 0 && (trailing.length !== 2 || trailing[0] !== "--output")) {
  argumentError = "usage: benchmark-prewalk-real [--dry-run] <manifest> [--output <absolute-path>]";
}
const outputPath = trailing[1];
if (!argumentError && outputPath && !path.isAbsolute(outputPath)) {
  argumentError = "--output path must be absolute";
}

const loadManifest = (inputPath) => {
  const resolved = path.resolve(inputPath);
  const size = fs.statSync(resolved).size;
  if (size > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES.toLocaleString("en-US")} bytes`);
  }
  return parsePrewalkRunManifest(JSON.parse(fs.readFileSync(resolved, "utf8")));
};

if (!manifestPath && !dryRun) {
  const gate = prewalkRunnerGate();
  process.stdout.write("Real Prewalk benchmark: SKIP\n");
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    skipped: true,
    reasons: gate.reasons,
  }, null, 2) + "\n");
} else {
  try {
    if (argumentError) throw new Error(argumentError);
    if (!manifestPath) throw new Error("manifest path is required");
    if (outputPath) assertNewOutputPath(outputPath);
    const manifest = loadManifest(manifestPath);
    if (dryRun) {
      const schedule = buildPrewalkSchedule(manifest.tasks, 1, "ultra-prewalk-dry-run-v1");
      process.stdout.write("Real Prewalk benchmark: DRY RUN\n");
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        tasks: manifest.tasks.length,
        runs: schedule.length,
        representativeTaskSet: manifest.representativeTaskSet,
        minimumTasks: manifest.minimumTasks,
        evaluator: manifest.evaluator.id,
        schedule,
      }, null, 2) + "\n");
    } else {
      const gate = prewalkRunnerGate();
      if (!gate.enabled) {
        process.stdout.write("Real Prewalk benchmark: SKIP\n");
        process.stdout.write(JSON.stringify({
          schemaVersion: 1,
          skipped: true,
          reasons: gate.reasons,
        }, null, 2) + "\n");
      } else {
        const { runRealPrewalkBenchmark } = await import(
          "./certification/prewalk-real-runner.mjs"
        );
        const collected = await runRealPrewalkBenchmark(manifest, gate.config);
        const serialized = JSON.stringify(collected.dataset, null, 2) + "\n";
        if (outputPath) writeNewOutput(outputPath, serialized);
        process.stdout.write(
          `Real Prewalk benchmark: COMPLETE (${collected.dataset.runs.length} runs, $${collected.observedCostUsd.toFixed(4)})${outputPath ? ` → ${outputPath}` : ""}\n`,
        );
        if (!outputPath) process.stdout.write(serialized);
      }
    }
  } catch (error) {
    process.stderr.write(
      `Real Prewalk benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
