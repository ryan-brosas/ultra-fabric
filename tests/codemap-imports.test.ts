import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractImportEdges, resolveSpecifier } from "../src/codemap/imports.js";

const fixtureRepo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-imports-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

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

describe("extractImportEdges specifier coverage (G7)", () => {
  it("resolves require() edges", () => {
    const dir = fixtureRepo({
      "a.ts": "const b = require(\"./b.js\");\nexport const a = 1;",
      "b.ts": "export const b = 1;",
    });
    const { edges } = extractImportEdges(dir);
    expect(edges.some((e) => e.from === "a.ts" && e.to === "b.ts")).toBe(true);
  });

  it("resolves dynamic import() edges", () => {
    const dir = fixtureRepo({
      "a.ts": "export const load = () => import(\"./c.js\");",
      "c.ts": "export const c = 1;",
    });
    const { edges } = extractImportEdges(dir);
    expect(edges.some((e) => e.from === "a.ts" && e.to === "c.ts")).toBe(true);
  });

  it("captures side-effect imports", () => {
    const dir = fixtureRepo({
      "a.ts": "import \"./d.js\";\nexport const a = 1;",
      "d.ts": "export const d = 1;",
    });
    const { edges } = extractImportEdges(dir);
    expect(edges.some((e) => e.from === "a.ts" && e.to === "d.ts")).toBe(true);
  });

  it("resolves extensionless specifiers to sibling .ts files", () => {
    const dir = fixtureRepo({
      "a.ts": "import { e } from \"./e\";\nexport const a = e;",
      "e.ts": "export const e = 1;",
    });
    const { edges } = extractImportEdges(dir);
    expect(edges.some((e) => e.from === "a.ts" && e.to === "e.ts")).toBe(true);
  });
});

describe("extractImportEdges", () => {
  it("finds at least 500 edges across 200+ nodes on this repository", () => {
    const { nodes, edges } = extractImportEdges(process.cwd());
    expect(nodes.length).toBeGreaterThanOrEqual(200);
    expect(edges.length).toBeGreaterThanOrEqual(500);
  });

  it("includes a known edge from src/fabric-state.ts to src/workflows/durable.ts", () => {
    const { edges } = extractImportEdges(process.cwd());
    expect(edges.some((e) => e.from === "src/fabric-state.ts" && e.to === "src/workflows/durable.ts")).toBe(true);
  });
});