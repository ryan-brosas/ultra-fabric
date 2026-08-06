import { dfs } from "./search.js";
import { buildAdjacency } from "./search.js";
import { buildNodeKeys, type SymbolIndex } from "./symbols.js";
import { renderFileSkeleton, renderSymbolSkeleton } from "./skeleton.js";
import type { OutlineFile } from "./outline.js";
import type { EdgeKind, RankEdge } from "./rank.js";

// Progressive disclosure over the AST semantic graph, mirroring LocAgent's
// explore_graph_structure(start_entities, direction, traversal_depth,
// entity_type_filter, dependency_type_filter) at
// inspo/locagent/plugins/location_tools/repo_ops/repo_ops.py. The agent starts
// from a minimal skeleton and expands entities on demand; each expansion
// returns the newly revealed entities and the token cost of revealing them.

export type Direction = "upstream" | "downstream" | "both";

export interface ExpandOptions {
  direction?: Direction;
  depth?: number;
  entityTypes?: readonly string[];
  edgeKinds?: readonly EdgeKind[];
  maxTokens?: number;
}

export interface ExpandResult {
  entities: string[];      // newly revealed symbol keys (name:file)
  files: string[];         // files included in this step (in reveal order)
  tokens: number;          // token cost of the revealed skeleton included
  truncated: boolean;      // true if maxTokens stopped the expansion early
}

export interface DisclosureGraph {
  index: SymbolIndex;
  edges: readonly RankEdge[];
  files: readonly OutlineFile[];
}

const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);

const reverseEdges = (edges: readonly RankEdge[]): RankEdge[] =>
  edges.map((e) => ({ from: e.to, to: e.from, weight: e.weight, kind: e.kind }));

export const buildDisclosureGraph = (index: SymbolIndex, edges: readonly RankEdge[], files: readonly OutlineFile[]): DisclosureGraph => ({
  index,
  edges,
  files,
});

export const expand = (
  graph: DisclosureGraph,
  entities: readonly string[],
  options: ExpandOptions = {},
): ExpandResult => {
  const direction = options.direction ?? "downstream";
  const depth = options.depth ?? 1;
  const nodes = buildNodeKeys(graph.index);
  const kindOpt = options.edgeKinds ? { edgeKinds: options.edgeKinds } : {};
  const fwdAdj = buildAdjacency(nodes, graph.edges, kindOpt);
  const revAdj = buildAdjacency(nodes, reverseEdges(graph.edges), kindOpt);

  const startSet = new Set(entities);
  const reached = new Set<string>(entities);
  const walk = (adj: Map<string, string[]>, e: string) => {
    for (const n of dfs(adj, e, depth)) reached.add(n);
  };
  if (direction !== "upstream") for (const e of entities) walk(fwdAdj, e);
  if (direction !== "downstream") for (const e of entities) walk(revAdj, e);

  const revealed = [...reached].filter((k) => !startSet.has(k));

  // entity-type filter, resolved from the symbol index.
  const typeSet = options.entityTypes ? new Set(options.entityTypes) : undefined;
  if (typeSet) {
    const typeByKey = new Map<string, string>();
    for (const n of graph.index.nodes) typeByKey.set(n.name + ":" + n.file, n.symbolType);
    for (let i = revealed.length - 1; i >= 0; i--) {
      const t = typeByKey.get(revealed[i]!);
      if (!t || !typeSet.has(t)) revealed.splice(i, 1);
    }
  }

  // Token cost (G5 member-level disclosure): each revealed symbol is charged
  // its own skeleton (elided signature + member names, or enclosing.member for
  // class members), not the whole file. The file path header is charged once
  // per file. This is the cAST-style member elision from doc §11 G5: the agent
  // pays for the symbol it disclosed, not the file's unrelated declarations.
  const outlineByPath = new Map(graph.files.map((f) => [f.path, f]));
  const includedFiles: string[] = [];
  const includedEntities: string[] = [];
  let tokens = 0;
  let truncated = false;
  const seenFiles = new Set<string>();
  for (const key of revealed) {
    const symbolName = key.split(":")[0] ?? "";
    const file = key.split(":").slice(1).join(":");
    const outline = outlineByPath.get(file);
    // The symbol skeleton already carries the file path on its first line, so
    // the header is charged exactly once through the skeleton itself.
    const symbolSkeleton = outline ? renderSymbolSkeleton(outline, symbolName) : "";
    const cost = outline && symbolSkeleton
      ? tokenEstimate(symbolSkeleton)
      : tokenEstimate(file);
    if (options.maxTokens !== undefined && tokens + cost > options.maxTokens) {
      truncated = true;
      break;
    }
    seenFiles.add(file);
    if (!includedFiles.includes(file)) includedFiles.push(file);
    includedEntities.push(key);
    tokens += cost;
  }
  return { entities: includedEntities, files: includedFiles, tokens, truncated };
};

// Minimal repository skeleton: the compressed view an agent starts from before
// any expansion.
export const minimalSkeleton = (graph: DisclosureGraph): string =>
  graph.files.map((f) => renderFileSkeleton(f)).join("\n\n");