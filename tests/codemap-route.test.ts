import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { buildLiteralIndex } from "../src/codemap/literals.js";
import { classify, route } from "../src/codemap/route.js";

const root = process.cwd();
const files = ["src/codemap/calls.ts", "src/codemap/symbols.ts", "src/codemap/rank.ts", "src/codemap/build.ts", "src/codemap/tool.ts"];
const index = buildSymbolIndex(runOutline(files, { cwd: root }));
const literals = buildLiteralIndex(files, index, { cwd: root });
const indexes = { index, literals };

describe("classify", () => {
  it("classifies representative real mined patterns correctly", () => {
    expect(classify("orderBy")).toBe("symbol");
    expect(classify("class .*Select")).toBe("declaration");
    expect(classify("Key(")).toBe("call");
    expect(classify("RFC 5445")).toBe("literal");
    expect(classify("delegate|registry")).toBe("regex");
  });
});

describe("route", () => {
  it("records which index produced each routed result", () => {
    const cases: Array<[string, "symbol" | "declaration" | "call" | "literal" | "regex", "symbol-index" | "literal-index"]> = [
      ["orderBy", "symbol", "symbol-index"],
      ["class .*Select", "declaration", "symbol-index"],
      ["Key(", "call", "symbol-index"],
      ["RFC 5445", "literal", "literal-index"],
      ["delegate|registry", "regex", "symbol-index"],
    ];
    for (const [q, cat, src] of cases) {
      const r = route(q, indexes);
      expect(r.category).toBe(cat);
      expect(r.source).toBe(src);
    }
  });

  it("returns exact-name match before substring matches", () => {
    const exact = "CodeGraph";
    const r = route(exact, indexes);
    expect(r.category).toBe("symbol");
    expect(r.source).toBe("symbol-index");
    expect(r.symbols.length).toBeGreaterThanOrEqual(1);
    const match = r.symbols[0]!;
    expect(match.name).toBe(exact);
    expect(match.file).toContain("build.ts");
  });

  it("routes a declaration query through the symbol index with a type filter", () => {
    const r = route("class .*Edges", indexes);
    expect(r.category).toBe("declaration");
    expect(r.source).toBe("symbol-index");
    // buildAllEdges is not a class; no class symbol matches '.*Edges' here, but
    // the dispatch must have run a symbol search (not a literal search).
    expect(r.literals.length).toBe(0);
  });
});