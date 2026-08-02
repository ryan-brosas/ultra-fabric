#!/usr/bin/env node
import { writeNewOutput } from "./certification/atomic-output.mjs";
import { buildPrewalkCorpusManifest } from "./certification/prewalk-corpus.mjs";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

try {
  const attestRepresentative = args[2] === "--attest-representative";
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== "--output" ||
    !args[1] ||
    (args.length === 3 && !attestRepresentative)
  ) {
    throw new Error(
      "usage: build-prewalk-corpus --output <absolute-path> [--attest-representative]",
    );
  }
  const manifest = buildPrewalkCorpusManifest({ attestRepresentative });
  writeNewOutput(args[1], JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`Prewalk corpus: WROTE ${manifest.tasks.length} tasks → ${args[1]}\n`);
} catch (error) {
  process.stderr.write(`Prewalk corpus failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
