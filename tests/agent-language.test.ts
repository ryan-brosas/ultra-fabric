import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LEGACY_BOUNDARIES = new Set([
  "src/config-migrations.ts",
  "src/migrations/legacy-agent.ts",
]);
const ACTIVE_DOCS = [
  "README.md",
  "docs/agents.md",
  "docs/architecture.md",
  "docs/audit-trace.md",
  "docs/configuration.md",
  "docs/interface.md",
  "docs/schema-enforcement.md",
  "docs/skills.md",
  "package.json",
];
const LEGACY_LANGUAGE = /\b(?:actors?|subagents?)\b|\bFabricActor|\bPersistentAgentManager|\bactor[A-Z_]/i;

const filesBelow = (relativeRoot: string): string[] => {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  const files: string[] = [];
  const visit = (absolutePath: string): void => {
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(?:ts|md|json)$/.test(entry.name)) {
        files.push(path.relative(ROOT, child).split(path.sep).join("/"));
      }
    }
  };
  visit(absoluteRoot);
  return files;
};

describe("Agent language", () => {
  it("keeps legacy lifecycle nouns inside migration boundaries", () => {
    const candidates = [
      ...filesBelow("src"),
      ...filesBelow("skills"),
      ...ACTIVE_DOCS,
    ].filter((file, index, all) => all.indexOf(file) === index && !LEGACY_BOUNDARIES.has(file));
    const violations = candidates.flatMap((file) => {
      if (LEGACY_LANGUAGE.test(file)) return [`${file} (path)`];
      return fs.readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .flatMap((line, index) => LEGACY_LANGUAGE.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []);
    });

    expect(violations).toEqual([]);
  });
});
