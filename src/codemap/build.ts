import { pageRank, type RankEdge } from "./rank.js";
import { buildSymbolIndex, buildContainmentEdges, buildInheritanceEdges, buildNodeKeys, type SymbolIndex } from "./symbols.js";
import { extractCallEdges } from "./calls.js";
import { expandNeighborhood, buildBothAdjacency, type PrebuiltAdjacency } from "./search.js";
import { findSourceFiles } from "./lang.js";
import { runOutlineCached } from "./cache.js";
import type { RenderNode } from "./render-heat.js";

export const buildAllEdges = (
  index: SymbolIndex,
  root: string,
  options: { maxDefiners?: number } = {},
): RankEdge[] => {
  const containment = buildContainmentEdges(index);
  const inheritance = buildInheritanceEdges(index);
  const callOpts: { cwd: string; maxDefiners?: number } = { cwd: root };
  if (options.maxDefiners !== undefined) callOpts.maxDefiners = options.maxDefiners;
  const calls = extractCallEdges(index, callOpts);
  return [...containment, ...inheritance, ...calls];
};


// Query-anchored multi-hop retrieval: instead of a global PageRank over every
// symbol for every query (DyRetriever 2608.01927 notes static global graphs are
// costly), seed anchors from the query, expand a bounded neighborhood, and rank
// only the reachable subgraph. Returns the PageRank over the subgraph with
// personalization set only on the anchors (aider repomap.py:443-445 style).
export const anchoredPageRank = (
  nodeKeys: readonly string[],
  edges: readonly RankEdge[],
  anchors: readonly string[],
  options: { depth?: number; damping?: number; maxIterations?: number; maxSubgraph?: number; prebuilt?: PrebuiltAdjacency; personalize?: readonly string[] } = {},
): Map<string, number> => {
  const depth = options.depth ?? 2;
  if (anchors.length === 0) return pageRank(nodeKeys, edges, options.damping !== undefined ? { damping: options.damping } : {});
  // Keys to personalize (teleport boost). Defaults to all anchors, but callers
  // can pass a focused subset so secondary seeds expand the subgraph without
  // diluting the personalization (aider repomap.py:443-445 focuses on matches).
  const personalize = options.personalize ?? anchors;
  const persSet = new Set(personalize);
  let sub = expandNeighborhood(nodeKeys, edges, anchors, depth, options.prebuilt);
  // Bound the subgraph size so per-query PageRank cost is predictable. dfs order
  // visits anchors and their nearest neighbors first, so slicing keeps the
  // most relevant nodes.
  if (options.maxSubgraph !== undefined && sub.length > options.maxSubgraph) sub = sub.slice(0, options.maxSubgraph);
  const subSet = new Set(sub);
  // Extract subgraph edges from the precomputed outgoing-edge index in O(subgraph
  // degree) instead of scanning every edge each query.
  const subEdges: RankEdge[] = [];
  if (options.prebuilt) {
    for (const n of sub) {
      for (const e of options.prebuilt.outEdges.get(n) ?? []) {
        if (subSet.has(e.to)) subEdges.push(e);
      }
    }
  } else {
    for (const e of edges) if (subSet.has(e.from) && subSet.has(e.to)) subEdges.push(e);
  }
  const pers = new Map<string, number>();
  for (const n of sub) {
    if (persSet.has(n)) pers.set(n, 10);
  }
  return pageRank(sub, subEdges, { personalization: pers, ...(options.damping !== undefined ? { damping: options.damping } : {}), ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}) });
};

// Build the symbol graph once so callers can run many anchored queries against
// the same precomputed adjacency (the pattern the benchmark uses).
export const buildCodeGraph = (options: { root?: string } = {}) => {
  const root = options.root ?? process.cwd();
  const find = findSourceFiles(root);
  const outlineFiles = runOutlineCached(find, { cwd: root }).files;
  const index = buildSymbolIndex(outlineFiles);
  const edges = buildAllEdges(index, root);
  const nodeKeys = buildNodeKeys(index);
  const prebuilt = buildBothAdjacency(nodeKeys, edges);
  return { nodeKeys, edges, prebuilt, index, outlineFiles, files: find };
};

export type CodeGraph = ReturnType<typeof buildCodeGraph>;

// Build RenderNode[] aligned 1:1 with CodeGraph.nodeKeys so the heat field and
// heat-field renderer can index the same node ordering. Each nodeKey is a
// "name:file" symbol key; we look it up in the symbol index to attach line and
// signature. Keys with no matching SymbolNode (rare parent fallbacks) get a
// minimal entry so the renderer still has a stable per-node id.
export const buildRenderNodes = (
  keys: readonly string[],
  index: SymbolIndex,
): RenderNode[] => {
  const nodes: RenderNode[] = [];
  for (const key of keys) {
    const sep = key.lastIndexOf(":");
    const name = key.slice(0, sep);
    const file = key.slice(sep + 1);
    const syms = index.byFile.get(file);
    const sym = syms?.find((s) => s.name === name);
    nodes.push({
      id: key,
      name,
      kind: sym?.symbolType ?? "decl",
      file,
      line: sym?.line ?? 0,
      sig: sym?.signature?.trim() || name,
    });
  }
  return nodes;
};



