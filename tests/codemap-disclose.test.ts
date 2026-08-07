import { describe, expect, it } from "vitest";
import { runOutline, type OutlineFile } from "../src/codemap/outline.js";
import { buildSymbolIndex, buildAllEdges } from "../src/codemap/symbols.js";
import { expand, buildDisclosureGraph, minimalSkeleton, type DisclosureGraph } from "../src/codemap/disclose.js";
import { renderFileSkeleton, renderSymbolSkeleton } from "../src/codemap/skeleton.js";

const root = process.cwd();
const paths = ["src/codemap/calls.ts", "src/codemap/symbols.ts", "src/codemap/rank.ts", "src/codemap/build.ts"];
const files = runOutline(paths, { cwd: root });
const index = buildSymbolIndex(files);
const edges = buildAllEdges(index, root);
const graph: DisclosureGraph = buildDisclosureGraph(index, edges, files);
const extractCallEdgesKey = "extractCallEdges:src/codemap/calls.ts";

describe("expand direction", () => {
  it("downstream from extractCallEdges reveals its callees (enclosingSymbol, computeEdgeWeight)", () => {
    const r = expand(graph, [extractCallEdgesKey], { direction: "downstream", depth: 1 });
    expect(r.entities.some((e) => e.startsWith("enclosingSymbol:src/codemap/symbols.ts"))).toBe(true);
    expect(r.entities.some((e) => e.startsWith("computeEdgeWeight:src/codemap/rank.ts"))).toBe(true);
  });

  it("upstream from extractCallEdges reveals its caller (buildAllEdges)", () => {
    const r = expand(graph, [extractCallEdgesKey], { direction: "upstream", depth: 1 });
    expect(r.entities.some((e) => e.startsWith("buildAllEdges:src/codemap/symbols.ts"))).toBe(true);
  });
});

describe("expand depth", () => {
  it("depth 1 reaches fewer entities than depth 2", () => {
    const r1 = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 1 });
    const r2 = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 2 });
    expect(r1.entities.length).toBeLessThanOrEqual(r2.entities.length);
    // every depth-1 entity is present at depth 2 (depth bounds outward, does not remove)
    for (const e of r1.entities) expect(r2.entities).toContain(e);
  });
});

describe("expand token cost", () => {
  it("cumulative token cost is monotonically increasing with depth and under a per-step budget", () => {
    const budget = 4000;
    const t1 = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 1, maxTokens: budget }).tokens;
    const t2 = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 2, maxTokens: budget }).tokens;
    const t3 = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 3, maxTokens: budget }).tokens;
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(t2);
    expect(t2).toBeLessThanOrEqual(t3);
    expect(t3).toBeLessThanOrEqual(budget);
  });

  it("respects maxTokens by truncating", () => {
    const r = expand(graph, [extractCallEdgesKey], { direction: "both", depth: 3, maxTokens: 50 });
    expect(r.tokens).toBeLessThanOrEqual(50);
    expect(r.truncated).toBe(true);
  });
});

describe("member-level disclosure (G5)", () => {
  const fixture: OutlineFile = {
    path: "src/fixture.ts",
    language: "typescript",
    items: [
      {
        symbolType: "function",
        name: "expand",
        range: { line: 48, column: 0, endLine: 95, endColumn: 1 },
        signature: "export const expand = (graph: DisclosureGraph, entities: readonly string[]): ExpandResult => { return graph; }",
        astKind: "variable_declarator",
        isImport: false,
        isExported: true,
        members: [],
      },
      {
        symbolType: "class",
        name: "Controller",
        range: { line: 100, column: 0, endLine: 160, endColumn: 1 },
        signature: "export class Controller {",
        astKind: "class_declaration",
        isImport: false,
        isExported: true,
        members: [
          { symbolType: "method", name: "arm", range: { line: 110, column: 2, endLine: 130, endColumn: 3 }, isPublic: true },
          { symbolType: "method", name: "disarm", range: { line: 140, column: 2, endLine: 150, endColumn: 3 }, isPublic: true },
        ],
      },
    ],
  };

  it("renders a symbol skeleton with elided signature and line number", () => {
    const skel = renderSymbolSkeleton(fixture, "expand");
    expect(skel).toContain("src/fixture.ts");
    expect(skel).toContain("48:");
    expect(skel).toContain("expand");
    expect(skel).toContain("...");
    expect(skel).not.toContain("return graph");
  });

  it("renders a class member skeleton with the enclosing class", () => {
    const skel = renderSymbolSkeleton(fixture, "arm");
    expect(skel).toContain("Controller.arm");
    expect(skel).toContain("110");
    expect(skel).not.toContain("disarm");
  });

  it("returns empty for an unknown symbol", () => {
    expect(renderSymbolSkeleton(fixture, "nope")).toBe("");
  });

  it("expand charges the revealed symbol skeleton, not the whole file", () => {
    // Build a disclosure graph over a real multi-item file and reveal exactly
    // one entity; the charged cost must track the member skeleton, which is
    // strictly cheaper than rendering the file skeleton.
    const one = expand(graph, [extractCallEdgesKey], { direction: "downstream", depth: 1 });
    const wholeFile = files
      .filter((f) => one.files.includes(f.path))
      .map((f) => renderFileSkeleton(f))
      .join("\n");
    expect(one.tokens).toBeGreaterThan(0);
    expect(one.tokens).toBeLessThan(Math.ceil(wholeFile.length / 4));
  });
});

describe("minimalSkeleton ordering", () => {
  it("renders higher-ranked files first so truncation keeps the head", () => {
    const rank = new Map<string, number>();
    for (const f of graph.files) rank.set(f.path, 0);
    rank.set("src/codemap/build.ts", 10);
    rank.set("src/codemap/calls.ts", 1);
    const skel = minimalSkeleton(graph, rank);
    const buildAt = skel.indexOf("src/codemap/build.ts");
    const callsAt = skel.indexOf("src/codemap/calls.ts");
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(callsAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(callsAt);
  });

  it("ties break deterministically on path", () => {
    const flat = new Map<string, number>();
    for (const f of graph.files) flat.set(f.path, 1);
    const a = minimalSkeleton(graph, flat);
    const b = minimalSkeleton(graph, flat);
    expect(a).toBe(b);
    const order = [...graph.files.map((f) => f.path)].sort();
    expect(a.indexOf(order[0]!)).toBeLessThan(a.indexOf(order[order.length - 1]!));
  });
});

describe("minimalSkeleton", () => {
  it("renders a compressed skeleton over the graph files", () => {
    const skel = minimalSkeleton(graph);
    expect(skel).toContain("src/codemap/calls.ts");
    expect(skel).toContain("extractCallEdges");
  });
});