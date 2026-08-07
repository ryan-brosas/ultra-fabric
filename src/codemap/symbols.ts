import { readFileSync } from "node:fs";
import type { OutlineFile, OutlineItem, OutlineMember } from "./outline.js";
import { computeEdgeWeight, type RankEdge } from "./rank.js";
import { extractCallEdges } from "./calls.js";

export interface SymbolNode {
  name: string;
  file: string;
  line: number;
  endLine: number;
  symbolType: string;
  parent: string | undefined;
  signature: string;
  isExported: boolean;
}

export interface SymbolIndex {
  nodes: SymbolNode[];
  byName: Map<string, SymbolNode[]>;
  byFile: Map<string, SymbolNode[]>;
}

// Limitation: ast-grep outline emits zero items with isImport=true, so references
// are extracted by scanning each source file for identifier tokens and matching
// them against the definition index. This also matches occurrences inside
// strings and comments — a known imprecision. The computeEdgeWeight penalty
// (x0.1 for names defined in >5 files) down-weights common names that would
// otherwise over-connect the graph, matching aider's repomap.py:499.

const toNode = (
  name: string,
  file: string,
 item: OutlineItem,
  parent: string | undefined,
): SymbolNode => ({
  name,
  file,
  line: item.range.line,
  endLine: item.range.endLine,
  symbolType: item.symbolType,
  parent,
  signature: item.signature,
  isExported: item.isExported,
});

const memberToNode = (
  member: OutlineMember,
  file: string,
  parent: string,
): SymbolNode => ({
  name: member.name,
  file,
  line: member.range.line,
  endLine: member.range.endLine,
  symbolType: member.symbolType,
  parent,
  signature: "",
  isExported: false,
});

export const buildSymbolIndex = (
  files: readonly OutlineFile[],
): SymbolIndex => {
  const nodes: SymbolNode[] = [];
  const byName = new Map<string, SymbolNode[]>();
  const byFile = new Map<string, SymbolNode[]>();
  for (const file of files) {
    const fileNodes: SymbolNode[] = [];
    for (const item of file.items) {
      if (item.isImport) continue;
      const node = toNode(item.name, file.path, item, undefined);
      nodes.push(node);
      fileNodes.push(node);
      const named = byName.get(item.name) ?? [];
      named.push(node);
      byName.set(item.name, named);
      for (const member of item.members) {
        const mNode = memberToNode(member, file.path, item.name);
        nodes.push(mNode);
        fileNodes.push(mNode);
        const mNamed = byName.get(member.name) ?? [];
        mNamed.push(mNode);
        byName.set(member.name, mNamed);
      }
    }
    byFile.set(file.path, fileNodes);
  }
  return { nodes, byName, byFile };
};

export const enclosingSymbol = (
  index: SymbolIndex,
  file: string,
  line: number,
): SymbolNode | undefined => {
  const fileNodes = index.byFile.get(file);
  if (!fileNodes) return undefined;
  let best: SymbolNode | undefined;
  for (const node of fileNodes) {
    if (line >= node.line && line <= node.endLine) {
      if (!best || (node.parent !== undefined && best.parent === undefined)) {
        best = node;
      } else if (node.parent !== undefined && best.parent !== undefined) {
        // Prefer the narrower range (member over parent)
        if (node.endLine - node.line <= best.endLine - best.line) {
          best = node;
        }
      }
    }
  }
  return best;
};



export const buildContainmentEdges = (
  index: SymbolIndex,
): RankEdge[] => {
  const edges: RankEdge[] = [];
  for (const node of index.nodes) {
    if (node.parent) {
      // Edge from parent to child, keyed by name (RepoGraph construct_graph.py:101-105)
      const fromKey = node.parent + ":" + node.file;
      const toKey = node.name + ":" + node.file;
      if (fromKey !== toKey) {
        edges.push({ from: fromKey, to: toKey, weight: 1, kind: "contains" });
      }
    }
  }
  return edges;
};

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export const buildReferenceEdges = (
  index: SymbolIndex,
  root: string,
  options: { maxDefiners?: number } = {},
): RankEdge[] => {
  const maxDefiners = options.maxDefiners ?? 5;
  // Build a set of all defined symbol names for O(1) lookup
  const defNames = new Set(index.byName.keys());
  // Dedup: accumulate (from, to) pair counts, emit one edge per pair
  const pairCounts = new Map<string, { from: string; to: string; ident: string; count: number; definerCount: number }>();
  for (const [file] of index.byFile) {
    let content: string;
    try {
      content = readFileSync(root + "/" + file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const line = lines[lineNum - 1] ?? "";
      const enclosing = enclosingSymbol(index, file, lineNum);
      if (!enclosing) continue;
      IDENT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IDENT_RE.exec(line)) !== null) {
        const ident = match[0]!;
        if (ident === enclosing.name) continue;
        if (!defNames.has(ident)) continue;
        const defs = index.byName.get(ident);
        if (!defs) continue;
        const definerCount = defs.length;
        // Item 4: skip identifiers with too many definitions (duplicate-name noise)
        if (definerCount > maxDefiners) continue;
        for (const def of defs) {
          if (def.file === file && def.line === lineNum) continue;
          const fromKey = enclosing.name + ":" + file;
          const toKey = def.name + ":" + def.file;
          if (fromKey === toKey) continue;
          // Item 5: accumulate count per (from, to) pair
          const pairKey = fromKey + "\0" + toKey;
          const existing = pairCounts.get(pairKey);
          if (existing) {
            existing.count++;
          } else {
            pairCounts.set(pairKey, { from: fromKey, to: toKey, ident, count: 1, definerCount });
          }
        }
      }
    }
  }
  // Emit one edge per pair, weighted by sqrt(count) * multiplier (mirrors repomap.py:501-514)
  const edges: RankEdge[] = [];
  for (const { from, to, ident, count, definerCount } of pairCounts.values()) {
    edges.push({
      from,
      to,
      weight: computeEdgeWeight(ident, count, false, false, definerCount),
      kind: "invokes",
    });
  }
  return edges;
};

const INHERITS_RE = /\bextends\s+([A-Za-z_$][\w$]*)/g;
const IMPLEMENTS_RE = /\bimplements\s+([A-Za-z_$][\w$,\s]*)/g;

const buildInheritanceEdges = (index: SymbolIndex): RankEdge[] => {
  const defNames = new Set(index.byName.keys());
  const edges: RankEdge[] = [];
  for (const node of index.nodes) {
    if (node.symbolType !== "class" && node.symbolType !== "interface") continue;
    if (!node.signature) continue;
    const fromKey = node.name + ":" + node.file;
    const bases = new Set<string>();
    INHERITS_RE.lastIndex = 0;
    IMPLEMENTS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INHERITS_RE.exec(node.signature)) !== null) bases.add(m[1]!);
    while ((m = IMPLEMENTS_RE.exec(node.signature)) !== null) {
      for (const part of m[1]!.split(",")) {
        const t = part.trim();
        if (t) bases.add(t);
      }
    }
    for (const base of bases) {
      if (!defNames.has(base)) continue;
      const defs = index.byName.get(base);
      if (!defs) continue;
      for (const def of defs) {
        const toKey = def.name + ":" + def.file;
        if (fromKey !== toKey) edges.push({ from: fromKey, to: toKey, weight: 1, kind: "inherits" });
      }
    }
  }
  return edges;
};

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

// Helper to get the unique node keys used in the graph (parent:file or name:file format)
export const buildNodeKeys = (index: SymbolIndex): string[] => {
  const keys = new Set<string>();
  for (const node of index.nodes) {
    if (node.parent) {
      keys.add(node.parent + ":" + node.file);
      keys.add(node.name + ":" + node.file);
    } else {
      keys.add(node.name + ":" + node.file);
    }
  }
  return [...keys];
};