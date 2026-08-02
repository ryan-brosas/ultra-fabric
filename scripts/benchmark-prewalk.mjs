#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  parsePrewalkBenchmarkDataset,
  summarizePrewalkBenchmark,
} from "./certification/prewalk-benchmark-lib.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const inputPath = args[0];
if (!inputPath) {
  process.stdout.write("Prewalk benchmark: SKIP\n");
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    skipped: true,
    reason: "Pass a bounded benchmark result JSON file to analyze; no model calls run automatically.",
  }, null, 2) + "\n");
} else {
  try {
    const resolved = path.resolve(inputPath);
    const size = fs.statSync(resolved).size;
    if (size > MAX_INPUT_BYTES) {
      throw new Error(
        `Prewalk benchmark input exceeds ${MAX_INPUT_BYTES.toLocaleString("en-US")} bytes`,
      );
    }
    const input = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const dataset = parsePrewalkBenchmarkDataset(input);
    const report = summarizePrewalkBenchmark(dataset.runs, dataset);
    process.stdout.write(`Prewalk benchmark: ${report.status}\n`);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status !== "comparison_ready") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Prewalk benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
