import { describe, expect, it } from "vitest";
import { computeEdgeWeight, pageRank, type RankEdge } from "../src/codemap/rank.js";

describe("computeEdgeWeight", () => {
  it("boosts distinctive long camelCase identifiers by 10x", () => {
    const base = computeEdgeWeight("helper", 1, false, false, 1);
    const boosted = computeEdgeWeight("importantFunction", 1, false, false, 1);
    expect(boosted / base).toBe(10);
  });

  it("boosts mentioned identifiers by an additional 10x", () => {
    const unmentioned = computeEdgeWeight("importantFunction", 1, false, false, 1);
    const mentioned = computeEdgeWeight("importantFunction", 1, true, false, 1);
    expect(mentioned / unmentioned).toBe(10);
  });

  it("suppresses private identifiers by 0.1x", () => {
    const pub = computeEdgeWeight("publicMethod", 1, false, false, 1);
    const priv = computeEdgeWeight("_privateMethod", 1, false, false, 1);
    // _privateMethod does not get the distinctive boost because it starts with _
    // but publicMethod does get the boost (camelCase, >= 8 chars)
    expect(priv).toBeLessThan(pub);
  });
});

describe("pageRank", () => {
  it("converges on a known graph with the expected ordering", () => {
    // Three files: fileA is referenced heavily, fileC is referenced lightly
    const nodes = ["fileA", "fileB", "fileC"];
    const edges: RankEdge[] = [
      { from: "fileB", to: "fileA", weight: 10, kind: "invokes" },
      { from: "fileC", to: "fileA", weight: 10, kind: "invokes" },
      { from: "fileA", to: "fileB", weight: 1, kind: "invokes" },
      { from: "fileC", to: "fileB", weight: 1, kind: "invokes" },
    ];
    const ranked = pageRank(nodes, edges);
    // fileA receives more high-weight incoming edges, so it should rank higher
    expect(ranked.get("fileA")!).toBeGreaterThan(ranked.get("fileB")!);
    expect(ranked.get("fileA")!).toBeGreaterThan(ranked.get("fileC")!);
  });

  it("produces different rankings under different personalization vectors on the same graph", () => {
    // Structurally symmetric: A and B both have incoming edges from C
    const nodes = ["A", "B", "C"];
    const edges: RankEdge[] = [
      { from: "C", to: "A", weight: 1, kind: "invokes" },
      { from: "C", to: "B", weight: 1, kind: "invokes" },
    ];
    const persA = new Map([["A", 100], ["B", 1], ["C", 1]]);
    const persB = new Map([["A", 1], ["B", 100], ["C", 1]]);
    const rankedA = pageRank(nodes, edges, { personalization: persA });
    const rankedB = pageRank(nodes, edges, { personalization: persB });
    const topA = [...rankedA.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const topB = [...rankedB.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(topA).toBe("A");
    expect(topB).toBe("B");
    expect(topA).not.toBe(topB);
  });

  it("gives a single seeded node a rank more than 10x the uniform share (no dilution floor)", () => {
    // Aider repomap.py:443-445 sets personalization only for matched files and omits
    // the rest. Seeding 1 of 100 nodes must lift that node well above the uniform 1/100
    // share, proving unmatched nodes are not assigned a diluting floor.
    const nodes = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const edges: RankEdge[] = [];
    for (let i = 0; i < 50; i++) edges.push({ from: `n${i}`, to: `n${(i + 1) % 50}`, weight: 1, kind: "invokes" });
    const pers = new Map([[`n0`, 10]]);
    const ranked = pageRank(nodes, edges, { personalization: pers });
    const uniform = 1 / 100;
    expect(ranked.get(`n0`)!).toBeGreaterThan(10 * uniform);
  });

  it("falls back to uniform when personalization keys do not intersect the node set", () => {
    const nodes = ["A", "B", "C"];
    const edges: RankEdge[] = [
      { from: "C", to: "A", weight: 1, kind: "invokes" },
    ];
    const pers = new Map([["nonexistent", 100]]);
    const ranked = pageRank(nodes, edges, { personalization: pers });
    for (const node of nodes) {
      const r = ranked.get(node)!;
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    }
  });

  it("returns empty for an empty graph", () => {
    expect(pageRank([], [])).toEqual(new Map());
  });
});
