import { describe, expect, it } from "vitest";
import { extractImportEdges, resolveSpecifier } from "../src/codemap/imports.js";

describe("resolveSpecifier", () => {
  it("resolves a ./x.js specifier to the x.ts path", () => {
    expect(resolveSpecifier("/proj/src", "./x.js")).toBe("/proj/src/x.ts");
  });

  it("resolves a ../y.js specifier relative to the importer directory", () => {
    expect(resolveSpecifier("/proj/src/sub", "../y.js")).toBe("/proj/src/y.ts");
  });

  it("returns undefined for a bare package specifier", () => {
    expect(resolveSpecifier("/proj/src", "node:path")).toBeUndefined();
    expect(resolveSpecifier("/proj/src", "vitest")).toBeUndefined();
  });
});

describe("extractImportEdges", () => {
  it("finds at least 500 edges across 200+ nodes on this repository", () => {
    const { nodes, edges } = extractImportEdges(process.cwd());
    expect(nodes.length).toBeGreaterThanOrEqual(200);
    expect(edges.length).toBeGreaterThanOrEqual(500);
  });

  it("includes a known edge from src/fabric-state.ts to src/lifecycle/store.ts", () => {
    const { edges } = extractImportEdges(process.cwd());
    expect(edges.some((e) => e.from === "src/fabric-state.ts" && e.to === "src/lifecycle/store.ts")).toBe(true);
  });
});