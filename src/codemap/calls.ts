import crossSpawn from "cross-spawn";
import type { SymbolIndex } from "./symbols.js";
import { enclosingSymbol } from "./symbols.js";
import { computeEdgeWeight, type RankEdge } from "./rank.js";
import { groupFilesByLang } from "./lang.js";

// AST-precise call-edge extraction. Unlike the regex token scan in
// buildReferenceEdges (which matches identifiers inside strings and comments),
// this uses `ast-grep run --pattern '$F($$$)'` to match only real call
// expressions, then resolves the callee's final member segment
// (theme.fg -> fg) against the symbol definition index. This mirrors the
// EDGE_TYPE_INVOKES edge in LocAgent (dependency_graph/build_graph.py:19) and
// the def/ref graph in RepoGraph (construct_graph.py:97-113).

interface AstGrepRange {
  start: { line: number; column: number };
}

interface AstGrepMatch {
  file: string;
  range: AstGrepRange;
  metaVariables: { single: Record<string, { text: string }> };
}

export interface CallEdgeOptions {
  cwd?: string;
  binary?: string;
  maxDefiners?: number;
}

const lastSegment = (callee: string): string => {
  const parts = callee.split(".");
  return parts[parts.length - 1] ?? "";
};

export const extractCallEdges = (
  index: SymbolIndex,
  options: CallEdgeOptions = {},
): RankEdge[] => {
  const cwd = options.cwd ?? process.cwd();
  const binary = options.binary ?? "ast-grep";
  const maxDefiners = options.maxDefiners ?? 5;
  const files = [...index.byFile.keys()];
  if (files.length === 0) return [];

  // Run ast-grep per language group (no hardcoded --lang ts) so call edges are
  // extracted across a polyglot tree.
  const matches: AstGrepMatch[] = [];
  for (const [lang, langFiles] of groupFilesByLang(files)) {
    let stdout: string;
    try {
      const res = crossSpawn.sync(
        binary,
        ["run", "--pattern", "$F($$$)", "--lang", lang, "--json=compact", ...langFiles],
        { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (res.error || res.status !== 0) continue;
      stdout = res.stdout;
    } catch {
      continue;
    }
    if (!stdout.trim()) continue;
    try {
      const parsed = JSON.parse(stdout) as AstGrepMatch[];
      if (Array.isArray(parsed)) matches.push(...parsed);
    } catch {
      // ignore unparseable output for this language group
    }
  }

  const defNames = new Set(index.byName.keys());
  const pairCounts = new Map<string, { from: string; to: string; ident: string; count: number; definerCount: number }>();

  for (const m of matches) {
    const calleeText = m.metaVariables?.single?.F?.text;
    if (!calleeText) continue;
    const ident = lastSegment(calleeText);
    if (!ident || !defNames.has(ident)) continue;
    const defs = index.byName.get(ident);
    if (!defs) continue;
    const definerCount = defs.length;
    if (definerCount > maxDefiners) continue;
    // ast-grep lines are 0-indexed; enclosingSymbol expects 1-indexed lines.
    const line = m.range.start.line + 1;
    const enclosing = enclosingSymbol(index, m.file, line);
    if (!enclosing) continue;
    if (enclosing.name === ident) continue;
    for (const def of defs) {
      if (def.file === m.file && def.line === line) continue;
      const fromKey = enclosing.name + ":" + m.file;
      const toKey = def.name + ":" + def.file;
      if (fromKey === toKey) continue;
      const pairKey = fromKey + "\0" + toKey;
      const existing = pairCounts.get(pairKey);
      if (existing) existing.count++;
      else pairCounts.set(pairKey, { from: fromKey, to: toKey, ident, count: 1, definerCount });
    }
  }

  const edges: RankEdge[] = [];
  for (const { from, to, ident, count, definerCount } of pairCounts.values()) {
    edges.push({ from, to, weight: computeEdgeWeight(ident, count, false, false, definerCount), kind: "invokes" });
  }
  return edges;
};