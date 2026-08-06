import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { extractCallEdges } from "../src/codemap/calls.js";

// Import-scoped callee resolution: a call site must only create invokes edges to
// definitions in files the caller actually imports (plus same-file definitions).
// Files with no resolvable imports keep the previous global-definer behavior so
// recall is preserved where the import graph is silent.

const dir = "/tmp/codemap-scope-fixture";

const write = (name: string, body: string): void => {
  writeFileSync(join(dir, name), body);
};

const outlineAll = (names: string[]) => runOutline(names, { cwd: dir });

describe("import-scoped call edges", () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scopes invokes edges to definers in files the caller imports", () => {
    write("mod-b.ts", "export function work() {\n  return 1;\n}\n");
    write("mod-c.ts", "export function work() {\n  return 2;\n}\n");
    write("caller.ts", "import { work } from \"./mod-b.js\";\nexport function run() {\n  return work();\n}\n");
    const index = buildSymbolIndex(outlineAll(["caller.ts", "mod-b.ts", "mod-c.ts"]));
    const edges = extractCallEdges(index, { cwd: dir });
    const intoWork = edges.filter((e) => e.to.startsWith("work:"));
    expect(intoWork.some((e) => e.to === "work:mod-b.ts")).toBe(true);
    expect(intoWork.some((e) => e.to === "work:mod-c.ts")).toBe(false);
  });

  it("falls back to global definers when the caller has no resolvable imports", () => {
    write("mod-b.ts", "export function work() {\n  return 1;\n}\n");
    write("mod-c.ts", "export function work() {\n  return 2;\n}\n");
    write("caller.ts", "export function run() {\n  return work();\n}\n");
    const index = buildSymbolIndex(outlineAll(["caller.ts", "mod-b.ts", "mod-c.ts"]));
    const edges = extractCallEdges(index, { cwd: dir });
    const intoWork = edges.filter((e) => e.to.startsWith("work:"));
    expect(intoWork.some((e) => e.to === "work:mod-b.ts")).toBe(true);
    expect(intoWork.some((e) => e.to === "work:mod-c.ts")).toBe(true);
  });

  it("counts only in-scope definers against the maxDefiners threshold", () => {
    for (let i = 1; i <= 6; i++) {
      write("mod-" + i + ".ts", "export const common = " + i + ";\nexport function g" + i + "() {\n  return common;\n}\n");
    }
    write("caller.ts", "import { common } from \"./mod-1.js\";\nexport function run() {\n  return common();\n}\n");
    const names = ["caller.ts", ...Array.from({ length: 6 }, (_, i) => "mod-" + (i + 1) + ".ts")];
    const index = buildSymbolIndex(outlineAll(names));
    const edges = extractCallEdges(index, { cwd: dir, maxDefiners: 5 });
    const intoCommon = edges.filter((e) => e.to.startsWith("common:"));
    expect(intoCommon.some((e) => e.to === "common:mod-1.ts")).toBe(true);
  });
});