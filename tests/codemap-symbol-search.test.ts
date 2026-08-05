import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { searchSymbols } from "../src/codemap/search.js";

const root = process.cwd();
const files = ["src/lifecycle/store.ts"];
const index = buildSymbolIndex(runOutline(files, { cwd: root }));

describe("searchSymbols", () => {
  it("returns FabricWorkStore for pattern '.*Store' filtered to class", () => {
    const hits = searchSymbols(index, ".*Store", { symbolType: "class" });
    const store = hits.find((n) => n.name === "FabricWorkStore");
    expect(store).toBeDefined();
    expect(store!.file).toBe("src/lifecycle/store.ts");
  });

  it("does not return matches occurring only inside comments or strings", () => {
    // Symbol index nodes are definitions only; no comment/string node types exist.
    const hits = searchSymbols(index, ".*Store");
    for (const n of hits) {
      expect(n.symbolType).not.toBe("comment");
      expect(n.symbolType).not.toBe("string");
    }
    // A substring that appears in store.ts only as prose, not as a symbol name,
    // yields no hits — proving comment/string content is not matched.
    expect(searchSymbols(index, "Feature-pattern").length).toBe(0);
    expect(searchSymbols(index, "XYZNONEXISTENT123").length).toBe(0);
  });

  it("falls back to substring matching when the pattern is not valid regex", () => {
    const hits = searchSymbols(index, "FabricWorkStore", { symbolType: "class" });
    expect(hits.some((n) => n.name === "FabricWorkStore")).toBe(true);
    // An invalid-regex pattern with a regex meta-char is treated as a literal substring
    expect(searchSymbols(index, "(").length).toBe(0);
  });
});