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
describe("route regex over literals", () => {
  it("matches a content regex against literal texts with file and line", () => {
    const q = "[Cc]hunk.*outline path";
    const r = route(q, indexes);
    expect(r.category).toBe("regex");
    const hit = r.literals.find((e) => e.file === "src/codemap/calls.ts" && e.text.includes("outline path"));
    expect(hit).toBeDefined();
    expect(hit!.line).toBeGreaterThan(0);
  });

  it("matches a regex against string literals, not only comments", () => {
    const r = route("--json[=]compact", indexes);
    expect(r.category).toBe("regex");
    expect(r.literals.some((e) => e.kind === "string" && e.text.includes("--json=compact"))).toBe(true);
  });

  it("keeps symbol-name regexes on the symbol index", () => {
    const r = route("CodeGraph|buildAllEdges", indexes);
    expect(r.category).toBe("regex");
    expect(r.source).toBe("symbol-index");
    expect(r.symbols.some((n) => n.name === "CodeGraph" || n.name === "buildAllEdges")).toBe(true);
  });

  it("tolerates an invalid regex without throwing", () => {
    const r = route("unclosed[", indexes);
    expect(r.category).toBe("regex");
    expect(Array.isArray(r.literals)).toBe(true);
  });
});

describe("route phrase fallback", () => {
  it("retries the symbol index when a phrase matches no literal", () => {
    // classify() treats multi-word text as literal; the literal index is
    // exact-substring, so a phrase naming a real symbol matches nothing there.
    // The fallback must tokenize and resolve the symbol, marking provenance.
    const r = route("the buildAllEdges function", indexes);
    expect(r.category).toBe("literal");
    expect(r.source).toBe("symbol-index");
    expect(r.symbols.some((s) => s.name === "buildAllEdges")).toBe(true);
  });
});
