import { describe, expect, it } from "vitest";
import { buildAdjacency, dfs } from "../src/codemap/search.js";
import type { RankEdge } from "../src/codemap/rank.js";

const nodes = ["A", "B", "C", "D"];
const edges: RankEdge[] = [
  { from: "A", to: "B", weight: 1, kind: "invokes" },
  { from: "B", to: "C", weight: 1, kind: "invokes" },
  { from: "C", to: "D", weight: 1, kind: "invokes" },
];
const adj = buildAdjacency(nodes, edges);

describe("search", () => {

  it("dfs at depth 0 returns only the query", () => {
    expect(dfs(adj, "A", 0)).toEqual(["A"]);
  });

  it("dfs at depth 2 reaches A->B->C", () => {
    const result = dfs(adj, "A", 2);
    expect(result).toContain("C");
    expect(result).toContain("A");
  });

  it("buildAdjacency edgeKinds filter excludes non-matching edge kinds", () => {
    // Graph: A -contains-> B, B -invokes-> C. Filtering to ["invokes"] must drop A->B.
    const mixed: RankEdge[] = [
      { from: "A", to: "B", weight: 1, kind: "contains" },
      { from: "B", to: "C", weight: 1, kind: "invokes" },
    ];
    const onlyInvokes = buildAdjacency(["A", "B", "C"], mixed, { edgeKinds: ["invokes"] });
    expect(onlyInvokes.get("A") ?? []).toEqual([]);
    expect(onlyInvokes.get("B") ?? []).toEqual(["C"]);
  });
});