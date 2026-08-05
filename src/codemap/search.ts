import type { EdgeKind, RankEdge } from "./rank.js";
import type { SymbolIndex, SymbolNode } from "./symbols.js";

export const buildAdjacency = (
  nodes: readonly string[],
  edges: readonly RankEdge[],
  options: { edgeKinds?: readonly EdgeKind[] } = {},
): Map<string, string[]> => {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node, []);
  const allow = options.edgeKinds ? new Set(options.edgeKinds) : undefined;
  for (const edge of edges) {
    if (allow && !allow.has(edge.kind)) continue;
    const list = adj.get(edge.from);
    if (list) list.push(edge.to);
  }
  return adj;
};

export const oneHop = (
  adj: Map<string, string[]>,
  query: string,
): string[] => adj.get(query) ?? [];

export const dfs = (
  adj: Map<string, string[]>,
  query: string,
  depth: number,
): string[] => {
  const visited = new Set<string>([query]);
  const result: string[] = [query];
  const stack: Array<{ node: string; level: number }> = [{ node: query, level: 0 }];
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    if (level >= depth) continue;
    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        result.push(neighbor);
        stack.push({ node: neighbor, level: level + 1 });
      }
    }
  }
  return result;
};


// Expand a multi-hop neighborhood from anchor nodes along both forward and reverse
// edges (RepoGraph graph_searcher.py:1-44; DyRetriever 2608.01927 entry-point-
// then-multi-hop). Forward edges follow callers to callees; reverse edges follow
// callees back to callers, so the subgraph captures both who an anchor calls and
// who calls it.
export interface PrebuiltAdjacency {
  fwd: Map<string, string[]>;
  rev: Map<string, string[]>;
  outEdges: Map<string, RankEdge[]>;
}

export const buildBothAdjacency = (
  nodes: readonly string[],
  edges: readonly RankEdge[],
): PrebuiltAdjacency => {
  const fwd = buildAdjacency(nodes, edges);
  const rev = buildAdjacency(
    nodes,
    edges.map((e) => ({ from: e.to, to: e.from, weight: e.weight, kind: e.kind })),
  );
  const outEdges = new Map<string, RankEdge[]>();
  for (const n of nodes) outEdges.set(n, []);
  for (const e of edges) {
    const list = outEdges.get(e.from);
    if (list) list.push(e);
  }
  return { fwd, rev, outEdges };
};

// Symbol pattern search over the AST index: match symbol names by regex (or
// substring if the pattern is not a valid regex), with an optional symbolType
// filter. This serves declaration-shaped queries like 'class .*Select' natively
// from the AST index, so they never fall through to text matching. Results are
// SymbolNodes (definitions only) — comment and string content is not in the
// symbol index and can never be returned here.
export const searchSymbols = (
  index: SymbolIndex,
  pattern: string,
  options: { symbolType?: string; limit?: number } = {},
): SymbolNode[] => {
  const limit = options.limit ?? 50;
  const typeOk = options.symbolType;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return index.nodes
      .filter((n) => n.name.includes(pattern) && (!typeOk || n.symbolType === typeOk))
      .slice(0, limit);
  }
  return index.nodes.filter((n) => re.test(n.name) && (!typeOk || n.symbolType === typeOk)).slice(0, limit);
};

export const expandNeighborhood = (
  nodes: readonly string[],
  edges: readonly RankEdge[],
  anchors: readonly string[],
  depth: number,
  prebuilt?: PrebuiltAdjacency,
): string[] => {
  const fwd = prebuilt?.fwd ?? buildAdjacency(nodes, edges);
  const rev = prebuilt?.rev ?? buildAdjacency(
    nodes,
    edges.map((e) => ({ from: e.to, to: e.from, weight: e.weight, kind: e.kind })),
  );
  const reached = new Set<string>(anchors);
  for (const a of anchors) {
    for (const n of dfs(fwd, a, depth)) reached.add(n);
    for (const n of dfs(rev, a, depth)) reached.add(n);
  }
  return [...reached];
};