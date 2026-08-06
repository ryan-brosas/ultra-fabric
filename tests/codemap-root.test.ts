import { describe, expect, it } from "vitest";
import { findSourceFiles } from "../src/codemap/lang.js";
import { buildCodeGraph } from "../src/codemap/build.js";
import { searchSymbols } from "../src/codemap/search.js";

// The graph must see the whole first-party tree, not only src/: a symbol
// defined in tests/ or scripts/ must be resolvable from the AST index, or the
// agent falls back to grep for exactly the queries the code map is built for.

const root = process.cwd();

describe("codemap graph root coverage", () => {
  it("includes tests/ and scripts/ files in the source scan", () => {
    const files = findSourceFiles(root);
    expect(files.some((f) => f.startsWith("src/"))).toBe(true);
    expect(files.some((f) => f.startsWith("tests/"))).toBe(true);
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
  });

  it("resolves a symbol defined only in tests/", () => {
    const graph = buildCodeGraph({ root });
    const hits = searchSymbols(graph.index, "^outlineAll$");
    expect(hits.some((n) => n.file === "tests/codemap-scope.test.ts")).toBe(true);
  });

  it("resolves a symbol defined in scripts/", () => {
    const graph = buildCodeGraph({ root });
    const hits = searchSymbols(graph.index, "^MAX_FILES$");
    expect(hits.some((n) => n.file.startsWith("scripts/"))).toBe(true);
  });
});
