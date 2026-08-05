import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex, buildAllEdges } from "../src/codemap/symbols.js";
import { expand, buildDisclosureGraph, minimalSkeleton, type DisclosureGraph } from "../src/codemap/disclose.js";

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

describe("minimalSkeleton", () => {
  it("renders a compressed skeleton over the graph files", () => {
    const skel = minimalSkeleton(graph);
    expect(skel).toContain("src/codemap/calls.ts");
    expect(skel).toContain("extractCallEdges");
  });
});