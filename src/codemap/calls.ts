import crossSpawn from "cross-spawn";
import type { SymbolIndex } from "./symbols.js";
import { enclosingSymbol } from "./symbols.js";
import { computeEdgeWeight, type RankEdge } from "./rank.js";
import { chunkPaths } from "./outline.js";
import { groupFilesByLang } from "./lang.js";
import { buildImportScope, resolveDefiners } from "./scope.js";

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

// A precise call site: the caller file, 1-indexed line, the enclosing caller
// symbol, the callee identifier as written, and the resolved definitions.
// extractCallEdges aggregates these into invokes edges; refs surfaces them
// per-symbol (semnav find_callers shape, LocAgent invoke edges).
export interface CallSite {
  file: string;
  line: number; // 1-indexed
  caller: string; // enclosing symbol name
  callee: string; // last member segment as written at the site
  defs: Array<{ name: string; file: string; line: number }>;
  definerCount: number; // scoped definition count used for the maxDefiners gate
}

const lastSegment = (callee: string): string => {
  const parts = callee.split(".");
  return parts[parts.length - 1] ?? "";
};

export const extractCallSites = (
  index: SymbolIndex,
  options: CallEdgeOptions = {},
): CallSite[] => {
  const cwd = options.cwd ?? process.cwd();
  const binary = options.binary ?? "ast-grep";
  const maxDefiners = options.maxDefiners ?? 5;
  const files = [...index.byFile.keys()];
  if (files.length === 0) return [];
  const scope = buildImportScope(cwd);

  // Run ast-grep per language group (no hardcoded --lang ts) so call edges are
  // extracted across a polyglot tree.
  const matches: AstGrepMatch[] = [];
  for (const [lang, langFiles] of groupFilesByLang(files)) {
    // Chunk like the outline path so Windows cmd.exe shims never truncate the
    // argv of large per-language file lists.
    for (const chunk of chunkPaths(langFiles)) {
      let stdout: string;
      try {
        const res = crossSpawn.sync(
          binary,
          ["run", "--pattern", "$F($$$)", "--lang", lang, "--json=compact", ...chunk],
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
  }

  const sites: CallSite[] = [];

  for (const m of matches) {
    const calleeText = m.metaVariables?.single?.F?.text;
    if (!calleeText) continue;
    const ident = lastSegment(calleeText);
    if (!ident) continue;
    // Scope the callee to the caller’s imports: a call may only reach
    // definitions in the caller’s file or in files it imports. Callers
    // without resolvable imports fall back to all definers (prior behavior),
    // and the definer count used for the maxDefiners gate is the scoped count.
    const { defs } = resolveDefiners(index, scope, m.file, ident);
    if (defs.length === 0) continue;
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
      sites.push({
        file: m.file,
        line,
        caller: enclosing.name,
        callee: ident,
        defs: defs.map((d) => ({ name: d.name, file: d.file, line: d.line })),
        definerCount,
      });
      break; // one site record per call expression, first resolved def wins
    }
  }
  return sites;
};

export const extractCallEdges = (
  index: SymbolIndex,
  options: CallEdgeOptions = {},
): RankEdge[] => {
  const pairCounts = new Map<string, { from: string; to: string; ident: string; count: number; definerCount: number }>();
  for (const site of extractCallSites(index, options)) {
    for (const def of site.defs) {
      const fromKey = site.caller + ":" + site.file;
      const toKey = def.name + ":" + def.file;
      if (fromKey === toKey) continue;
      const pairKey = fromKey + "\0" + toKey;
      const existing = pairCounts.get(pairKey);
      if (existing) existing.count++;
      else pairCounts.set(pairKey, { from: fromKey, to: toKey, ident: site.callee, count: 1, definerCount: site.definerCount });
    }
  }
  const edges: RankEdge[] = [];
  for (const { from, to, ident, count, definerCount } of pairCounts.values()) {
    edges.push({ from, to, weight: computeEdgeWeight(ident, count, false, false, definerCount), kind: "invokes" });
  }
  return edges;
};