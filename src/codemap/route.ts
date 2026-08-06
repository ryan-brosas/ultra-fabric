import type { SymbolIndex, SymbolNode } from "./symbols.js";
import { searchSymbols } from "./search.js";
import type { LiteralEntry } from "./literals.js";
import { searchLiterals } from "./literals.js";
import { extractQueryIdentifiers } from "./eval.js";

// Query router: classify an incoming search string into symbol, declaration,
// call, literal, or regex and dispatch to the matching index, merging results
// with provenance. The taxonomy mirrors the empirical distribution measured
// from 2302 mined agent greps (38.8% bare identifier / 23.5% declaration /
// 18.0% regex / 9.4% other literal / 6.5% call site / 3.8% phrase).

export type QueryCategory = "symbol" | "declaration" | "call" | "literal" | "regex";

export interface RoutedResult {
  category: QueryCategory;
  source: "symbol-index" | "literal-index";
  symbols: SymbolNode[];
  literals: LiteralEntry[];
}

// Declaration keyword -> the symbolType filter to apply when dispatching.
const DECL_TO_TYPE = new Map<string, string>([
  ["class", "class"],
  ["interface", "interface"],
  ["type", "type"],
  ["def", "function"],
  ["func", "function"],
  ["fn", "function"],
  ["function", "function"],
  ["struct", "struct"],
  ["enum", "enum"],
  ["trait", "trait"],
  ["impl", "impl"],
]);

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const REGEX_CHAR_RE = /[|*+?^$[\]{}()\\]/;

export const classify = (query: string): QueryCategory => {
  const s = query.trim();
  if (!s) return "literal";
  const parts = s.split(/\s+/);
  const first = parts[0]!.toLowerCase().replace(/:$/, "");
  // declaration-shaped: "class .*Select", "type Module interface", "def foo"
  if (DECL_TO_TYPE.has(first) && parts.length > 1) return "declaration";
  // call-site: "Key(", "window("
  if (s.endsWith("(") && IDENT_RE.test(s.slice(0, -1))) return "call";
  // bare identifier
  if (IDENT_RE.test(s)) return "symbol";
  // regex-shaped: contains regex metacharacters
  if (REGEX_CHAR_RE.test(s)) return "regex";
  // phrase or free text -> literal index
  return "literal";
};

export interface RouteIndexes {
  index: SymbolIndex;
  literals: readonly LiteralEntry[];
}

export const route = (query: string, indexes: RouteIndexes): RoutedResult => {
  const category = classify(query);
  if (category === "literal") {
    const literals = searchLiterals(indexes.literals, query);
    // Phrase fallback: the literal index is exact-substring, so a multi-word
    // query that names symbols (e.g. "the buildAllEdges function") matches
    // nothing there. Tokenize and retry the symbol index so the phrase still
    // resolves, marking the provenance so callers can tell it came from a
    // fallback (source: "symbol-index"). If the retry finds nothing, the
    // literal result is returned unchanged.
    if (literals.length === 0) {
      const symbols: SymbolNode[] = [];
      const seen = new Set<string>();
      for (const id of extractQueryIdentifiers(query)) {
        for (const n of searchSymbols(indexes.index, "^" + id + "$", { limit: 10 })) {
          const key = n.name + ":" + n.file;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push(n);
          }
        }
      }
      if (symbols.length > 0) return { category: "literal", source: "symbol-index", symbols, literals: [] };
    }
    return { category, source: "literal-index", symbols: [], literals };
  }
  const s = query.trim();
  let symbols: SymbolNode[] = [];
  if (category === "declaration") {
    const parts = s.split(/\s+/);
    const kw = parts[0]!.toLowerCase().replace(/:$/, "");
    const pattern = parts.slice(1).join(" ");
    const st = DECL_TO_TYPE.get(kw);
    symbols = searchSymbols(indexes.index, pattern, st ? { symbolType: st } : {});
  } else if (category === "call") {
    symbols = searchSymbols(indexes.index, s.slice(0, -1));
  } else {
    // symbol and regex both resolve via the symbol index
    symbols = searchSymbols(indexes.index, s);
  }
  // Re-rank: exact-name matches before substring/pattern matches.
  // PageRank favors centrally-imported files, which can push a definition
  // behind an incidental match in a popular module (e.g., "Entity" in
  // src/protocol.ts ranking above src/ui/dashboard-model.ts).
  const exact: SymbolNode[] = [];
  const rest: SymbolNode[] = [];
  for (const node of symbols) {
    if (node.name === s) exact.push(node);
    else rest.push(node);
  }
  exact.sort((a, b) => a.file.localeCompare(b.file));
  symbols = [...exact, ...rest];
  return { category, source: "symbol-index", symbols, literals: [] };
};